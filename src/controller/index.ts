import type {
  FeatureBlend,
  Learner,
  LearnerState,
  MusicSessionController,
  MusicSignature,
  PCMPlayer,
  PCMPlayerStats,
  ServerMessage,
  SessionState,
  StreamLevels,
  Target,
  Vote,
  WeightedPrompt,
} from '../shared/protocol.ts';
import { FEATURE_GROUPS, GROUP_IDS, type FeatureGroup } from '../learner/vocabulary.ts';
import type { MusicTransport, TransportFactory } from '../transport/types.ts';
import { lerpBlend, lerpPrompts } from './blend.ts';
import { DEFAULT_CONTROLLER_CONFIG, type ControllerConfig } from './config.ts';

export { DEFAULT_CONTROLLER_CONFIG, type ControllerConfig } from './config.ts';

/** Stats polling cadence for `subscribeStats` — matches the player's telemetry window rate. */
const STATS_INTERVAL_MS = 100;
/** Statuses during which the session is steering toward a target and stats flow. */
const ACTIVE_STATUSES: ReadonlySet<SessionState['status']> = new Set(['connecting', 'playing', 'reconnecting']);
const ZERO_LEVELS: StreamLevels = { energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0 };

/** Reverse lookup: bare feature id ('lofi') -> its group ('genre'). */
const GROUP_OF_ID = new Map<string, FeatureGroup>();
for (const group of GROUP_IDS) {
  for (const id of FEATURE_GROUPS[group]) GROUP_OF_ID.set(id, group);
}

/**
 * The stream's musical identity: the highest-weight feature in each group plus the
 * highest-weight prompt phrase. Feature ids may be bare ('lofi') or carry a
 * 'group:' prefix ('genre:lofi') — both resolve to the same group.
 */
export function deriveSignature(target: Target): MusicSignature | undefined {
  const best = new Map<FeatureGroup, { word: string; weight: number }>();
  for (const [key, weight] of Object.entries(target.features)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue;
    let group: FeatureGroup | undefined;
    let word = key;
    const colon = key.indexOf(':');
    if (colon > 0 && key.slice(0, colon) in FEATURE_GROUPS) {
      group = key.slice(0, colon) as FeatureGroup;
      word = key.slice(colon + 1);
    } else {
      group = GROUP_OF_ID.get(key);
    }
    if (!group) continue;
    const cur = best.get(group);
    if (!cur || weight > cur.weight) best.set(group, { word, weight });
  }
  let focus: string | undefined;
  let top = -Infinity;
  for (const p of target.prompts) {
    if (p.weight > top) {
      top = p.weight;
      focus = p.text;
    }
  }
  const signature: MusicSignature = {
    genre: best.get('genre')?.word,
    instrument: best.get('instrument')?.word,
    mood: best.get('mood')?.word,
    texture: best.get('texture')?.word,
    focus,
  };
  return Object.values(signature).some((v) => v !== undefined) ? signature : undefined;
}

export type ControllerDeps = {
  learner: Learner;
  player: PCMPlayer;
  createTransport: TransportFactory;
  seed?: number;
  config?: Partial<ControllerConfig>;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

type Ramp = { fromFeatures: FeatureBlend; fromPrompts: WeightedPrompt[]; target: Target; step: number };
type Sent = { at: number; features: FeatureBlend };

export class SessionController implements MusicSessionController {
  private readonly cfg: ControllerConfig;
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  private readonly listeners = new Set<(s: SessionState) => void>();
  private readonly statsListeners = new Set<(l: StreamLevels) => void>();
  private state: SessionState = { status: 'idle' };
  // Derived from `this.target` whenever it changes; surfaced on states emitted while active.
  private signature: MusicSignature | undefined;

  private learnerState: LearnerState;
  private target: Target;
  // What the relay was last told to play. Ramps start here so the upstream blend stays continuous.
  private sentFeatures: FeatureBlend;
  private sentPrompts: WeightedPrompt[];
  // Recent (time, features) pairs we sent, used to estimate what is audible now.
  private history: Sent[] = [];

  private transport: MusicTransport | undefined;
  private ready = false;
  private revision = 0;
  private ramp: Ramp | undefined;
  private rampTimer: ReturnType<typeof setTimeout> | undefined;
  private evolveTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private runId = 0; // bumped by start() and stop() so a superseded start() cannot connect or fail the new session
  // What the current socket's `start` message carried; a vote before `ready` may have moved past it.
  private started: { features: FeatureBlend; prompts: WeightedPrompt[] } | undefined;

  constructor(private readonly deps: ControllerDeps) {
    this.cfg = { ...DEFAULT_CONTROLLER_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => { });
    const seed = deps.seed ?? Math.floor(Math.random() * 0x7fffffff);
    this.learnerState = deps.learner.createLearner(seed);
    this.target = deps.learner.initialTarget(this.learnerState);
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.history = [{ at: this.now(), features: this.sentFeatures }];
    this.signature = deriveSignature(this.target);
  }

  async start(): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'stopped' && this.state.status !== 'error') return;
    const run = ++this.runId;
    this.setState({ status: 'connecting' });
    try {
      // First statement so it runs inside the tap handler's gesture.
      await this.deps.player.initializeFromUserGesture();
    } catch (err) {
      if (run !== this.runId) return;
      return this.fail(`Audio could not start: ${String(err instanceof Error ? err.message : err)}`);
    }
    if (run !== this.runId || this.status() !== 'connecting') return; // stopped or restarted while initializing
    this.attempts = 0;
    this.connect();
  }

  vote(v: Vote): void {
    const { status } = this.state;
    if (status === 'idle' || status === 'stopped' || status === 'error') return;
    const audible = this.estimateAudible();
    const result = this.deps.learner.processVote({
      state: this.learnerState,
      audible,
      currentTarget: this.target,
      vote: v,
    });
    this.learnerState = result.state;
    this.log('vote', { vote: v, audible, bufferedMs: this.deps.player.getBufferedDurationMs(), votes: result.state.votes });
    this.retarget(result.target);
  }

  stop(): void {
    if (this.state.status === 'idle' || this.state.status === 'stopped') return;
    this.runId++;
    this.transport?.send({ type: 'stop' });
    this.teardownConnection();
    void this.deps.player.close().catch(() => { });
    this.setState({ status: 'stopped' });
  }

  subscribe(listener: (s: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  subscribeStats(listener: (l: StreamLevels) => void): () => void {
    this.statsListeners.add(listener);
    listener(this.statsSnapshot()); // synchronous snapshot: zeros when idle/no stats
    this.updateStatsTimer();
    return () => {
      this.statsListeners.delete(listener);
      this.updateStatsTimer();
    };
  }


  // ---- live stats (~10 Hz while active) ----

  private updateStatsTimer(): void {
    const want = this.statsListeners.size > 0 && ACTIVE_STATUSES.has(this.state.status);
    if (want && this.statsTimer === undefined) {
      this.statsTimer = setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    } else if (!want && this.statsTimer !== undefined) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  private emitStats(): void {
    const snapshot = this.statsSnapshot();
    for (const l of this.statsListeners) l(snapshot);
  }

  private statsSnapshot(): StreamLevels {
    if (!ACTIVE_STATUSES.has(this.state.status)) return ZERO_LEVELS;
    const stats: PCMPlayerStats | undefined = this.deps.player.getStats?.();
    if (!stats) return ZERO_LEVELS; // a torn-down player reports silence, not an exception
    return {
      energy: stats.energyRms,
      brightnessHz: stats.brightnessHz,
      pitchHz: stats.pitchHz,
      bufferedMs: stats.bufferedMs,
      underruns: stats.underruns,
    };
  }

  // ---- connection ----

  private connect(): void {
    // Start from the latest target: after a (re)connect there is no audio continuity to protect.
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.history = [{ at: this.now(), features: this.sentFeatures }];
    this.ready = false;
    const transport = this.deps.createTransport();
    this.transport = transport;
    transport.connect({
      onOpen: () => {
        if (this.transport !== transport) return;
        this.started = { features: this.sentFeatures, prompts: this.sentPrompts };
        transport.send({ type: 'start', prompts: this.sentPrompts });
      },
      onMessage: (msg) => this.transport === transport && this.onServerMessage(msg),
      onAudio: (bytes) => {
        if (this.transport === transport && this.ready) this.deps.player.enqueuePcm(bytes);
      },
      onClose: () => {
        if (this.transport === transport) this.connectionLost('connection closed');
      },
    });
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'ready':
        this.deps.player.configure(msg.audio);
        this.ready = true;
        this.attempts = 0;
        this.setState({ status: 'playing' });
        const started = this.started;
        this.started = undefined; // `ready` can repeat after an upstream reconnect; only the first one matters
        if (started && started.prompts !== this.sentPrompts) {
          // Voted while connecting: the relay started on an older target, so ramp to the latest.
          this.sentFeatures = started.features;
          this.sentPrompts = started.prompts;
          this.retarget(this.target);
        } else {
          this.scheduleEvolve();
        }
        return;
      case 'status':
        if (msg.state === 'reconnecting') this.setState({ status: 'reconnecting' });
        else if (msg.state === 'playing' && this.ready) this.setState({ status: 'playing' });
        return;
      case 'error':
        this.log('server_error', { code: msg.code, message: msg.message, retryable: msg.retryable });
        if (msg.code === 'prompt_filtered') return this.onPromptFiltered();
        if (msg.retryable) return this.connectionLost(msg.message);
        return this.fail(msg.message);
    }
  }

  // The stream keeps playing; move to a different valid combination without touching scores.
  private onPromptFiltered(): void {
    this.retarget(this.deps.learner.evolveNoVote({ state: this.learnerState, target: this.target }), false);
  }

  private connectionLost(reason: string): void {
    this.teardownConnection();
    this.setState({ status: 'reconnecting', lastError: reason });
    const delay = this.cfg.reconnectBackoffMs[this.attempts];
    if (delay === undefined) return this.fail('Could not reconnect to the music service');
    this.attempts++;
    this.log('reconnect', { attempt: this.attempts, delayMs: delay, reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private fail(message: string): void {
    this.teardownConnection();
    void this.deps.player.close().catch(() => { });
    this.setState({ status: 'error', lastError: message });
  }

  private teardownConnection(): void {
    this.transport?.close();
    this.transport = undefined;
    this.ready = false;
    this.ramp = undefined;
    clearTimeout(this.rampTimer);
    clearTimeout(this.evolveTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.statsTimer);
    this.rampTimer = this.evolveTimer = this.retryTimer = undefined;
    this.statsTimer = undefined;
  }

  // ---- steering ----

  private retarget(target: Target, resetEvolve = true): void {
    this.target = target;
    this.signature = deriveSignature(target);
    if (ACTIVE_STATUSES.has(this.state.status)) {
      // Signature-only steering change: same status, new identity — still an emission.
      this.setState({ ...this.state });
    }
    clearTimeout(this.rampTimer);
    if (!this.ready) {
      // Not streaming yet (or reconnecting): connect() will start from this target.
      this.sentFeatures = target.features;
      this.sentPrompts = target.prompts;
      this.ramp = undefined;
      return;
    }
    this.ramp = { fromFeatures: this.sentFeatures, fromPrompts: this.sentPrompts, target, step: 0 };
    this.tick();
    if (resetEvolve) this.scheduleEvolve();
  }

  private tick(): void {
    const ramp = this.ramp;
    if (!ramp || !this.ready) return;
    ramp.step++;
    const t = Math.min(1, (ramp.step * this.cfg.stepMs) / this.cfg.rampMs);
    this.sentFeatures = t >= 1 ? ramp.target.features : lerpBlend(ramp.fromFeatures, ramp.target.features, t);
    this.sentPrompts = lerpPrompts(ramp.fromPrompts, ramp.target.prompts, t);
    const at = this.now();
    this.history.push({ at, features: this.sentFeatures });
    this.history = this.history.filter((h, i) => i === 0 || at - h.at <= this.cfg.historyRetentionMs);
    this.transport?.send({ type: 'steer', revision: ++this.revision, prompts: this.sentPrompts });
    if (t < 1) this.rampTimer = setTimeout(() => this.tick(), this.cfg.stepMs);
    else this.ramp = undefined;
  }

  // Best guess of what the listener hears: the newest blend we sent early enough to have cleared the buffer.
  private estimateAudible(): FeatureBlend {
    const cutoff = this.now() - this.deps.player.getBufferedDurationMs() - this.cfg.generationLatencyMs;
    let pick = this.history[0];
    for (const h of this.history) if (h.at <= cutoff) pick = h;
    return pick?.features ?? this.sentFeatures;
  }

  private scheduleEvolve(): void {
    clearTimeout(this.evolveTimer);
    this.evolveTimer = setTimeout(() => {
      this.retarget(this.deps.learner.evolveNoVote({ state: this.learnerState, target: this.target }));
    }, this.cfg.noVoteEvolveMs);
  }

  private status(): SessionState['status'] {
    return this.state.status;
  }

  private setState(next: SessionState): void {
    if (ACTIVE_STATUSES.has(next.status) && this.signature !== undefined) {
      next = { ...next, signature: this.signature };
    }
    if (
      next.status === this.state.status &&
      next.lastError === this.state.lastError &&
      next.signature === this.state.signature
    )
      return;
    this.state = next;
    for (const l of this.listeners) l(next);
    this.updateStatsTimer();
  }
}
