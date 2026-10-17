import type {
  FeatureBlend,
  Learner,
  LearnerState,
  ListeningPurpose,
  MusicSessionController,
  PCMPlayer,
  ServerMessage,
  SessionState,
  Target,
  Vote,
  WeightedPrompt,
} from '../shared/protocol.ts';
import type { MusicTransport, TransportFactory } from '../transport/types.ts';
import { lerpBlend, lerpPrompts } from './blend.ts';
import { DEFAULT_CONTROLLER_CONFIG, type ControllerConfig } from './config.ts';

export { DEFAULT_CONTROLLER_CONFIG, type ControllerConfig } from './config.ts';

export type ControllerDeps = {
  learner: Learner;
  player: PCMPlayer;
  createTransport: TransportFactory;
  seed?: number;
  purpose?: ListeningPurpose;
  config?: Partial<ControllerConfig>;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

type Ramp = { fromFeatures: FeatureBlend; fromPrompts: WeightedPrompt[]; target: Target; step: number };
type Sent = { at: number; features: FeatureBlend };

function blendDistance(a: FeatureBlend, b: FeatureBlend): number {
  const total = (blend: FeatureBlend) => Object.values(blend).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  const aTotal = total(a), bTotal = total(b);
  const share = (blend: FeatureBlend, id: string, sum: number) => sum > 0 && Number.isFinite(blend[id]) ? Math.max(0, blend[id] ?? 0) / sum : 0;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].reduce((sum, id) => sum + Math.abs(share(a, id, aTotal) - share(b, id, bTotal)), 0) / 2;
}

function sameTarget(a: Target, b: Target): boolean {
  const sameWeights = (x: Record<string, number>, y: Record<string, number>) => [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .every((id) => Math.abs((x[id] ?? 0) - (y[id] ?? 0)) < 1e-9);
  return sameWeights(a.features, b.features)
    && sameWeights(Object.fromEntries(a.prompts.map((p) => [p.text, p.weight])), Object.fromEntries(b.prompts.map((p) => [p.text, p.weight])));
}

export class SessionController implements MusicSessionController {
  private readonly cfg: ControllerConfig;
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  private readonly listeners = new Set<(s: SessionState) => void>();
  private state: SessionState = { status: 'idle' };
  private readonly seed: number;
  private purpose: ListeningPurpose;

  private learnerState: LearnerState;
  private target: Target;
  // What the relay was last told to play. Ramps start here so the upstream blend stays continuous.
  private sentFeatures: FeatureBlend;
  private sentPrompts: WeightedPrompt[];
  // Recent (time, features) pairs we sent, used to estimate what is audible now.
  private history: Sent[] = [];
  private audibleCursor = -Infinity;
  private heard: Sent | undefined;
  private evidenceHistory: Sent[] = [];
  private noveltyStep = 0;

  private transport: MusicTransport | undefined;
  private ready = false;
  private awaitingReady = false;
  private revision = 0;
  private ramp: Ramp | undefined;
  private rampTimer: ReturnType<typeof setTimeout> | undefined;
  private evolveTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private runId = 0; // bumped by start() and stop() so a superseded start() cannot connect or fail the new session
  // What the relay will restart from; votes while awaiting `ready` may move past it.
  private started: { features: FeatureBlend; prompts: WeightedPrompt[] } | undefined;

  constructor(private readonly deps: ControllerDeps) {
    this.cfg = { ...DEFAULT_CONTROLLER_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.seed = deps.seed ?? Math.floor(Math.random() * 0x7fffffff);
    this.purpose = deps.purpose ?? 'explore';
    this.learnerState = deps.learner.createLearner(this.seed, this.purpose);
    this.target = deps.learner.initialTarget(this.learnerState);
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.resetHearing(this.sentFeatures);
  }

  setPurpose(purpose: ListeningPurpose): void {
    if (purpose === this.purpose || !['idle', 'stopped', 'error'].includes(this.state.status)) return;
    this.purpose = purpose;
    this.learnerState = this.deps.learner.createLearner(this.seed, purpose);
    this.target = this.deps.learner.initialTarget(this.learnerState);
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.noveltyStep = 0;
    this.resetHearing(this.sentFeatures);
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
    const evidenceWeight = this.evidenceWeight(audible);
    const result = this.deps.learner.processVote({
      state: this.learnerState,
      audible,
      currentTarget: this.target,
      vote: v,
      evidenceWeight,
    });
    this.learnerState = result.state;
    this.log('vote', { vote: v, audible, evidenceWeight, bufferedMs: this.deps.player.getBufferedDurationMs(), votes: result.state.votes });
    this.retarget(result.target);
  }

  stop(): void {
    if (this.state.status === 'idle' || this.state.status === 'stopped') return;
    this.runId++;
    this.transport?.send({ type: 'stop' });
    this.teardownConnection();
    void this.deps.player.close().catch(() => {});
    this.setState({ status: 'stopped' });
  }

  subscribe(listener: (s: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  // ---- connection ----

  private connect(): void {
    // Start from the latest target: after a (re)connect there is no audio continuity to protect.
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.resetHearing(this.sentFeatures);
    this.ready = false;
    this.awaitingReady = false;
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
        if (this.transport === transport && this.ready && !this.awaitingReady) this.deps.player.enqueuePcm(bytes);
      },
      onClose: () => {
        if (this.transport === transport) this.connectionLost('connection closed');
      },
    });
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'ready':
        const resetHearing = !this.ready || this.awaitingReady;
        this.deps.player.configure(msg.audio);
        this.ready = true;
        this.awaitingReady = false;
        this.attempts = 0;
        this.setState({ status: 'playing' });
        const started = this.started;
        if (resetHearing) this.resetHearing(started?.features ?? this.sentFeatures);
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
        if (msg.state === 'reconnecting') {
          if (!this.awaitingReady) this.started ??= { features: this.sentFeatures, prompts: this.sentPrompts };
          this.awaitingReady = true;
          this.sentFeatures = this.target.features;
          this.sentPrompts = this.target.prompts;
          this.ramp = undefined;
          clearTimeout(this.rampTimer);
          clearTimeout(this.evolveTimer);
          this.rampTimer = this.evolveTimer = undefined;
          this.setState({ status: 'reconnecting' });
        }
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
    if (!this.canHear()) return;
    this.retarget(this.nextVariation(), false);
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
    void this.deps.player.close().catch(() => {});
    this.setState({ status: 'error', lastError: message });
  }

  private teardownConnection(): void {
    this.transport?.close();
    this.transport = undefined;
    this.ready = false;
    this.awaitingReady = false;
    this.started = undefined;
    this.ramp = undefined;
    clearTimeout(this.rampTimer);
    clearTimeout(this.evolveTimer);
    clearTimeout(this.retryTimer);
    this.rampTimer = this.evolveTimer = this.retryTimer = undefined;
  }

  // ---- steering ----

  private retarget(target: Target, resetEvolve = true): void {
    const directionChanged = !sameTarget(this.target, target);
    this.target = target;
    if (!this.ready || this.awaitingReady) {
      clearTimeout(this.rampTimer);
      // Not streaming yet (or reconnecting): connect() will start from this target.
      this.sentFeatures = target.features;
      this.sentPrompts = target.prompts;
      this.ramp = undefined;
      return;
    }
    // Holding the same pending target should not restart an in-flight ramp.
    if (this.ramp && sameTarget(this.ramp.target, target)) {
      this.ramp.target = target;
      if (resetEvolve && (directionChanged || this.evolveTimer === undefined)) this.scheduleEvolve();
      return;
    }
    clearTimeout(this.rampTimer);
    this.rampTimer = undefined;
    if (sameTarget({ features: this.sentFeatures, prompts: this.sentPrompts }, target)) {
      this.ramp = undefined;
      // Likes can keep arriving without postponing fresh variations forever.
      if (resetEvolve && (directionChanged || this.evolveTimer === undefined)) this.scheduleEvolve();
      return;
    }
    this.ramp = { fromFeatures: this.sentFeatures, fromPrompts: this.sentPrompts, target, step: 0 };
    this.tick();
    if (resetEvolve) this.scheduleEvolve();
  }

  private tick(): void {
    const ramp = this.ramp;
    if (!ramp || !this.ready || this.awaitingReady) return;
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
    // A growing queue cannot make already heard music become unheard again.
    if (this.hasAudiblePlayback()) this.audibleCursor = Math.max(this.audibleCursor, cutoff);
    let pick = this.heard ?? this.history[0];
    for (const h of this.history) if (h.at <= this.audibleCursor && (!pick || h.at >= pick.at)) pick = h;
    this.heard = pick;
    return pick?.features ?? this.sentFeatures;
  }

  private resetHearing(features: FeatureBlend): void {
    this.history = [{ at: this.now(), features }];
    this.heard = this.history[0];
    this.audibleCursor = -Infinity;
    this.evidenceHistory = [];
  }

  private canHear(): boolean {
    return this.ready && !this.awaitingReady && this.state.status === 'playing';
  }

  private evidenceWeight(audible: FeatureBlend): number {
    if (!this.hasAudiblePlayback()) return 0;
    const at = this.now();
    this.evidenceHistory = this.evidenceHistory.filter((observation) => at - observation.at < this.cfg.evidenceWindowMs);
    if (this.evidenceHistory.some((observation) => blendDistance(observation.features, audible) < this.cfg.evidenceBlendDistance)) return 0;
    this.evidenceHistory.push({ at, features: { ...audible } });
    return 1;
  }

  private hasAudiblePlayback(): boolean {
    if (!this.canHear()) return false;
    const stats = this.deps.player.getStats?.();
    return !stats || (stats.state === 'ready' && !stats.priming
      && (stats.audioContextState === undefined || stats.audioContextState === 'running'));
  }

  private nextVariation(): Target {
    const target = this.deps.learner.evolveNoVote({ state: this.learnerState, target: this.target, step: ++this.noveltyStep });
    this.log('evolve', { step: this.noveltyStep, target: target.features });
    return target;
  }

  private scheduleEvolve(): void {
    clearTimeout(this.evolveTimer);
    this.evolveTimer = undefined;
    if (!this.canHear()) return;
    this.evolveTimer = setTimeout(() => {
      this.evolveTimer = undefined;
      if (!this.canHear()) return;
      if (!this.hasAudiblePlayback()) {
        // The connection can keep producing audio while its output is suspended.
        // Retry the deadline without claiming exposure or advancing novelty.
        this.scheduleEvolve();
        return;
      }
      this.retarget(this.nextVariation());
    }, this.cfg.noVoteEvolveMs);
  }

  private status(): SessionState['status'] {
    return this.state.status;
  }

  private setState(next: SessionState): void {
    if (next.status === this.state.status && next.lastError === this.state.lastError) return;
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}
