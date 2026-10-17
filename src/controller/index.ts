import { INTENT_LIMITS, parseMusicIntent, parseInterpretResponse, type MusicIntent } from '../shared/intent.ts';
import { FEATURE_IDS } from '../learner/vocabulary.ts';
import { matchesIntent } from '../learner/adaptive/intent.ts';
import type { IntentInterpreter } from './intent-client.ts';
import type {
  FeatureBlend,
  Learner,
  LearnerState,
  ListeningPurpose,
  MusicSessionController,
  MusicSignature,
  PCMPlayer,
  PCMPlayerStats,
  ServerMessage,
  SessionState,
  StreamLevels,
  Target,
  Vote,
  VoteDecision,
  WeightedPrompt,
} from '../shared/protocol.ts';
import { FEATURE_GROUPS, GROUP_IDS, type FeatureGroup } from '../learner/vocabulary.ts';
import { MAX_PROMPT_COUNT } from '../shared/protocol.ts';
import type { MusicTransport, TransportFactory, TransportHandlers } from '../transport/types.ts';
import { lerpBlend, lerpPrompts } from './blend.ts';
import { LookaheadPool } from './lookahead.ts';
import type { FeedbackRecord, PreferencesStore, SavedProfile } from '../preferences/types.ts';
import { DEFAULT_CONTROLLER_CONFIG, type ControllerConfig } from './config.ts';

export { DEFAULT_CONTROLLER_CONFIG, type ControllerConfig } from './config.ts';

/** Stats polling cadence for `subscribeStats` — matches the player's telemetry window rate. */
const STATS_INTERVAL_MS = 100;
/** Statuses during which the session is steering toward a target and stats flow. */
const ACTIVE_STATUSES: ReadonlySet<SessionState['status']> = new Set(['connecting', 'playing', 'reconnecting']);
const ZERO_LEVELS: StreamLevels = { energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0, generation: 0 };

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

/** Words for the blend currently in the ears — the audible estimate, not the pending target. */
function signatureForSent(sent: Sent | undefined): MusicSignature | undefined {
  if (!sent) return undefined;
  return deriveSignature({ features: sent.features, prompts: sent.prompts ?? [] });
}

export type ControllerDeps = {
  learner: Learner;
  player: PCMPlayer;
  createTransport: TransportFactory;
  seed?: number;
  purpose?: ListeningPurpose;
  config?: Partial<ControllerConfig>;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  preferences?: PreferencesStore;
  lookahead?: boolean;
  interpretIntent?: IntentInterpreter;
  restoreState?: (value: unknown, purpose: ListeningPurpose) => LearnerState | undefined;
};

type Ramp = { fromIntentRevision: number; fromFeatures: FeatureBlend; fromPrompts: WeightedPrompt[]; target: Target; step: number; durationMs: number };
type Sent = { at: number; features: FeatureBlend; prompts?: WeightedPrompt[]; intentRevision?: number };
const PURPOSES: ListeningPurpose[] = ['focus', 'relax', 'energy', 'explore', 'crazy'];
const sessionId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function sameSignature(a: MusicSignature | undefined, b: MusicSignature | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.genre === b.genre && a.instrument === b.instrument && a.mood === b.mood
    && a.texture === b.texture && a.focus === b.focus;
}

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
  private readonly statsListeners = new Set<(l: StreamLevels) => void>();
  private state: SessionState = { status: 'idle', intentAvailable: false };
  private readonly seed: number;
  private purpose: ListeningPurpose;
  // Derived from `this.target` whenever it changes; surfaced on states emitted while active.
  private signature: MusicSignature | undefined;
  private intent: MusicIntent | undefined;
  private intentText = '';
  private intentRevision = 0;
  private sentIntentRevision = 0;
  private intentRequest = 0;
  private intentAbort: AbortController | undefined;
  private profileIntents: Partial<Record<ListeningPurpose, { intent: MusicIntent; text: string }>> = {};

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
  // Issue #9: the latest vote's explanation + an ETA for when it reaches the ears.
  private decision: VoteDecision | undefined;
  private pendingSteer: { vote: Vote; at: number; etaMs: number; generationAtVote: number; prepared?: boolean; doneAt?: number } | undefined;
  // PCM blocks landed on the current socket — the real generation cadence behind steerProgress.
  private blocksLanded = 0;
  private nowPlayingSig: MusicSignature | undefined;
  private noveltyStep = 0;
  private rejected: Sent | undefined;
  private feedbackSession = sessionId();
  private feedbackSequence = 0;
  private profiles: Partial<Record<ListeningPurpose, LearnerState>> = {};
  private persistedVotes: Partial<Record<ListeningPurpose, number>> = {};
  private purposeChosen = false;
  private memoryReady: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private memoryFailed = false;
  private resetting = false;
  private memoryLoading = false;
  private memoryRestored = false;
  private queuedVotes: Array<{ vote: Vote; at: number; session: string; purpose: ListeningPurpose; run: number }> = [];

  private transport: MusicTransport | undefined;
  private readonly lookahead: LookaheadPool | undefined;
  private lookaheadSupported = false;
  private lookaheadTimer: ReturnType<typeof setTimeout> | undefined;
  private preparedKey: string | undefined;
  private branchSettlesAt = -Infinity;
  private ready = false;
  private awaitingReady = false;
  private revision = 0;
  private ramp: Ramp | undefined;
  private rampTimer: ReturnType<typeof setTimeout> | undefined;
  private evolveTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private runId = 0; // bumped by start() and stop() so a superseded start() cannot connect or fail the new session
  // What the relay will restart from; votes while awaiting `ready` may move past it.
  private started: { features: FeatureBlend; prompts: WeightedPrompt[]; intentRevision: number } | undefined;

  constructor(private readonly deps: ControllerDeps) {
    this.cfg = { ...DEFAULT_CONTROLLER_CONFIG, ...deps.config };
    // Rigs that only pin rampMs inherit it for votes too — voteRampMs must be asked for by name.
    if (deps.config?.rampMs !== undefined && deps.config?.voteRampMs === undefined) {
      this.cfg.voteRampMs = deps.config.rampMs;
    }
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    if (deps.lookahead && deps.player.replacePcm) {
      this.lookahead = new LookaheadPool(deps.createTransport, { log: this.log });
    }
    this.seed = deps.seed ?? Math.floor(Math.random() * 0x7fffffff);
    this.purpose = deps.purpose ?? 'explore';
    this.learnerState = deps.learner.createLearner(this.seed, this.purpose);
    this.target = deps.learner.initialTarget(this.learnerState);
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.sentIntentRevision = this.intentRevision;
    this.resetHearing(this.sentFeatures, this.sentPrompts);
    this.signature = deriveSignature(this.target);
    this.purposeChosen = deps.purpose !== undefined;
    if (deps.interpretIntent && deps.learner.applyIntent) this.state = { ...this.state, purpose: this.purpose,
      intentStatus: 'idle', intentText: '', intentAvailable: true };
    if (deps.preferences) {
      this.memoryLoading = true;
      this.state = { ...this.state, purpose: this.purpose, memory: 'loading', savedVotes: 0 };
      this.memoryReady = this.loadPreferences();
    }
  }

  setPurpose(purpose: ListeningPurpose): void {
    if (!PURPOSES.includes(purpose) || this.resetting || !['idle', 'stopped', 'error'].includes(this.state.status)) return;
    this.purposeChosen = true;
    if (this.deps.preferences) {
      void this.memoryReady.then(() => {
        if (this.purpose === purpose) return this.queueWrite(() => this.deps.preferences!.selectPurpose(purpose));
      });
    }
    if (purpose === this.purpose) return;
    this.cancelIntentRequest();
    if (this.deps.preferences) this.profiles[this.purpose] = this.learnerState;
    this.purpose = purpose;
    this.activateProfile(this.profiles[purpose]);
    if (this.deps.preferences) {
      this.updateMemory(this.state.memory ?? 'ready');
    }
  }

  private activateProfile(saved?: LearnerState): void {
    const brief = this.profileIntents[this.purpose];
    this.intent = brief?.intent;
    this.intentText = brief?.text ?? '';
    this.intentRevision++;
    this.sentIntentRevision = this.intentRevision;
    this.learnerState = saved ?? this.deps.learner.createLearner(this.seed, this.purpose);
    this.target = this.deps.learner.initialTarget(this.learnerState, this.intent);
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.noveltyStep = 0;
    this.resetHearing(this.sentFeatures, this.sentPrompts);
    this.signature = deriveSignature(this.target);
    this.publishIntent();
  }

  private publishIntent(): void {
    if (!this.state.intentAvailable) return;
    this.setState({ ...this.state, purpose: this.purpose, intent: this.intent, intentText: this.intentText,
      intentStatus: this.intent ? 'ready' : 'idle', intentMessage: undefined });
  }

  private cancelIntentRequest(): void {
    this.intentRequest++;
    this.intentAbort?.abort();
    this.intentAbort = undefined;
    if (this.state.intentStatus === 'loading') this.publishIntent();
  }

  async interpretText(text: string): Promise<void> {
    if (!this.deps.interpretIntent || !this.deps.learner.applyIntent || this.resetting) return;
    this.cancelIntentRequest();
    const request = this.intentRequest;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > INTENT_LIMITS.text) {
      this.setState({ ...this.state, intentStatus: 'error', intentMessage: 'Enter a song, style, or activity (up to 1,200 characters).' });
      return;
    }
    const abort = new AbortController();
    this.intentAbort = abort;
    this.setState({ ...this.state, intentStatus: 'loading', intentMessage: undefined });
    await this.memoryReady;
    if (request !== this.intentRequest || abort.signal.aborted) return;
    // Loading saved memory may publish its brief, but this request remains pending.
    this.setState({ ...this.state, intentStatus: 'loading' });
    const ranked = FEATURE_IDS.map(id => ({ id, score: this.learnerState.scores[id] ?? 0 }));
    const liked = ranked.filter(x => x.score > 0.05).sort((a,b) => b.score-a.score).slice(0, 4).map(x => x.id);
    const disliked = ranked.filter(x => x.score < -0.05).sort((a,b) => a.score-b.score).slice(0, 4).map(x => x.id);
    try {
      const result = parseInterpretResponse(await this.deps.interpretIntent({ text: trimmed,
        purpose: this.purpose, currentFeatures: { ...this.target.features },
        ...(this.intent ? { currentIntent: this.intent } : {}), preferences: { liked, disliked } }, abort.signal));
      if (request !== this.intentRequest || abort.signal.aborted) return;
      if (!result) throw new Error('Invalid interpretation');
      if (result.status !== 'ready') {
        this.setState({ ...this.state, intentStatus: result.status, intentMessage: result.message });
        return;
      }
      // Use the latest learner state: thumbs may have arrived while interpreting.
      this.applyIntent(result.intent, trimmed);
    } catch {
      if (request === this.intentRequest && !abort.signal.aborted) this.setState({ ...this.state,
        intentStatus: 'error', intentMessage: 'Could not interpret that request right now. Your current music is unchanged.' });
    } finally { if (request === this.intentRequest) this.intentAbort = undefined; }
  }

  clearIntent(): void {
    this.cancelIntentRequest();
    if (this.resetting || !this.deps.learner.applyIntent) return;
    if (this.memoryLoading) {
      const request = this.intentRequest;
      void this.memoryReady.then(() => {
        if (request === this.intentRequest && !this.resetting) this.applyIntent(undefined, '');
      });
      return;
    }
    this.applyIntent(undefined, '');
  }

  private applyIntent(intent: MusicIntent | undefined, text: string): void {
    const target = this.deps.learner.applyIntent!({ state: this.learnerState, currentTarget: this.target, intent });
    this.intent = intent;
    this.intentText = text;
    this.intentRevision++;
    if (intent) this.profileIntents[this.purpose] = { intent: structuredClone(intent), text };
    else delete this.profileIntents[this.purpose];
    this.rejected = undefined;
    this.evidenceHistory = [];
    this.clearLookahead();
    this.cancelVoteProgress();
    this.retarget(target, true, this.cfg.voteRampMs);
    this.publishIntent();
    this.savePreferences(); // A request is context, never a fabricated vote.
  }

  private async loadPreferences(): Promise<void> {
    try {
      const saved = await this.deps.preferences!.load();
      for (const purpose of PURPOSES) {
        const profile = saved.profiles[purpose];
        if (!profile || profile.purpose !== purpose) continue;
        const restored = this.deps.restoreState?.(profile.state, purpose);
        if (restored) {
          this.profiles[purpose] = restored;
          this.persistedVotes[purpose] = restored.votes;
          const intent = parseMusicIntent(profile.intent);
          if (intent && this.deps.learner.applyIntent) this.profileIntents[purpose] = {
            intent, text: typeof profile.intentText === 'string' ? profile.intentText.slice(0, INTENT_LIMITS.text) : '',
          };
        }
      }
      if (!this.purposeChosen && saved.purpose && PURPOSES.includes(saved.purpose)) this.purpose = saved.purpose;
      this.activateProfile(this.profiles[this.purpose]);
      this.memoryRestored = true;
      this.updateMemory('ready');
    } catch {
      this.memoryFailed = true;
      this.updateMemory('unavailable');
    } finally {
      this.memoryLoading = false;
      for (const pending of this.queuedVotes.splice(0)) {
        if (pending.run === this.runId && pending.purpose === this.purpose && this.state.status === 'connecting') {
          this.applyVote(pending.vote, pending.at, true, pending.session);
        } else {
          // A canceled pre-playback action is still recorded with zero evidence,
          // but can never steer or contaminate a different active profile.
          const state = this.profiles[pending.purpose] ?? this.deps.learner.createLearner(this.seed, pending.purpose);
          const intent = this.profileIntents[pending.purpose]?.intent;
          const target = this.deps.learner.initialTarget(state, intent);
          const result = this.deps.learner.processVote({ state, audible: target.features, currentTarget: target,
            vote: pending.vote, evidenceWeight: 0, intent });
          if (pending.purpose === this.purpose) this.learnerState = result.state;
          this.saveProfile(pending.purpose, result.state, {
            id: `${pending.session}:${++this.feedbackSequence}`, at: pending.at, sessionId: pending.session,
            purpose: pending.purpose, vote: pending.vote, audible: { ...target.features }, evidenceWeight: 0,
            targetBefore: structuredClone(target), targetAfter: structuredClone(target),
          });
        }
      }
    }
  }

  private updateMemory(memory: SessionState['memory']): void {
    if (!this.deps.preferences) return;
    this.setState({ ...this.state, purpose: this.purpose, memory, savedVotes: this.persistedVotes[this.purpose] ?? 0 });
  }

  private queueWrite(action: () => Promise<void>, saved?: SavedProfile, allowWithoutLoad = false): Promise<boolean> {
    // A failed read is not an empty profile: never overwrite unread saved taste.
    if (!this.memoryRestored && !allowWithoutLoad) {
      this.updateMemory('unavailable');
      return Promise.resolve(false);
    }
    this.pendingWrites++;
    this.updateMemory('saving');
    const operation = this.writes.then(action).then(() => {
      if (saved) this.persistedVotes[saved.purpose] = saved.state.votes;
      return true;
    }, () => {
      this.memoryFailed = true;
      return false;
    }).finally(() => {
      this.pendingWrites--;
      this.updateMemory(this.pendingWrites ? 'saving' : this.memoryFailed ? 'unavailable' : 'ready');
    });
    this.writes = operation.then(() => {});
    return operation;
  }

  private savePreferences(event?: FeedbackRecord): void {
    if (!this.deps.preferences) return;
    this.saveProfile(this.purpose, this.learnerState, event);
  }

  private saveProfile(purpose: ListeningPurpose, state: LearnerState, event?: FeedbackRecord): void {
    this.profiles[purpose] = state;
    const brief = this.profileIntents[purpose];
    const profile: SavedProfile = { purpose, state: structuredClone(state), updatedAt: this.now(),
      ...(brief ? { intent: structuredClone(brief.intent), intentText: brief.text } : {}) };
    void this.queueWrite(() => this.deps.preferences!.save(profile, event), profile);
  }

  async exportFeedback(): Promise<string> {
    if (!this.deps.preferences) throw new Error('Local storage is unavailable.');
    await this.memoryReady;
    await this.writes;
    return this.deps.preferences.export();
  }

  async resetPreferences(): Promise<void> {
    if (!this.deps.preferences) throw new Error('Local storage is unavailable.');
    if (this.resetting || !['idle', 'stopped', 'error'].includes(this.state.status)) throw new Error('End the session before resetting preferences.');
    this.cancelIntentRequest();
    this.resetting = true;
    try {
      await this.memoryReady;
      const cleared = await this.queueWrite(() => this.deps.preferences!.clear(), undefined, true);
      if (!cleared) throw new Error('Could not clear saved preferences.');
      this.memoryFailed = false;
      this.memoryRestored = true;
      this.profiles = {};
      this.profileIntents = {};
      this.persistedVotes = {};
      this.activateProfile();
      this.updateMemory('ready');
    } finally { this.resetting = false; }
  }

  async start(): Promise<void> {
    if (this.resetting || (this.state.status !== 'idle' && this.state.status !== 'stopped' && this.state.status !== 'error')) return;
    const run = ++this.runId;
    this.feedbackSession = sessionId();
    this.feedbackSequence = 0;
    this.setState({ status: 'connecting' });
    try {
      // First statement so it runs inside the tap handler's gesture.
      await this.deps.player.initializeFromUserGesture();
    } catch (err) {
      if (run !== this.runId) return;
      return this.fail(`Audio could not start: ${String(err instanceof Error ? err.message : err)}`);
    }
    await this.memoryReady; // AudioContext was already created synchronously in the gesture.
    if (run !== this.runId || this.status() !== 'connecting') return; // stopped or restarted while initializing/loading
    if (this.deps.preferences) {
      const purpose = this.purpose;
      void this.queueWrite(() => this.deps.preferences!.selectPurpose(purpose));
      this.savePreferences();
    }
    this.attempts = 0;
    this.connect();
  }

  vote(v: Vote): void {
    const { status } = this.state;
    if (status === 'idle' || status === 'stopped' || status === 'error') return;
    if (this.memoryLoading) {
      this.queuedVotes.push({ vote: v, at: this.now(), session: this.feedbackSession, purpose: this.purpose, run: this.runId });
      return;
    }
    this.applyVote(v);
  }

  private applyVote(v: Vote, at = this.now(), beforePlayback = false, session = this.feedbackSession): void {
    const audible = beforePlayback ? this.target.features : this.estimateAudible();
    const evidenceWeight = beforePlayback ? 0 : this.evidenceWeight(audible);
    const intentAppliedToAudible = this.heard?.intentRevision === this.intentRevision;
    const previous = v === 'up' && evidenceWeight > 0 && this.rejected
      && this.now() - this.rejected.at <= this.cfg.comparisonWindowMs
      && blendDistance(this.rejected.features, audible) >= this.cfg.evidenceBlendDistance
      ? { ...this.rejected.features } : undefined;
    const targetBefore = this.target;
    const result = this.deps.learner.processVote({
      state: this.learnerState,
      audible,
      currentTarget: this.target,
      vote: v,
      evidenceWeight,
      intent: this.intent,
      ...(previous ? { comparison: { previous } } : {}),
    });
    this.learnerState = result.state;
    const d = result.target.lastDecision;
    this.decision = d
      ? { vote: v, kind: d.kind, reason: d.reason, phase: d.phase, at: this.now() }
      : { vote: v, kind: 'hold', reason: 'Keeping what is playing.', phase: 'listening', at: this.now() };
    const buffered = this.deps.player.getBufferedDurationMs();
    this.pendingSteer = {
      vote: v,
      at: this.now(),
      etaMs: this.cfg.generationLatencyMs + buffered + this.cfg.voteRampMs * 0.5,
      generationAtVote: this.blocksLanded,
    };
    if (evidenceWeight > 0) this.rejected = v === 'down' ? { at: this.now(), features: { ...audible } } : undefined;
    this.log('vote', { vote: v, audible, previous, evidenceWeight, bufferedMs: buffered, votes: result.state.votes });
    if (!this.usePrepared(v, result.target)) {
      this.log('lookahead_miss', { vote: v });
      this.clearLookahead();
      this.retarget(result.target, true, this.cfg.voteRampMs);
    }
    // Deliver a fresh progress sample before the next polling tick; ready cached
    // audio can finish its fade before that tick reaches the UI.
    this.emitStats();
    this.savePreferences({
      id: `${session}:${++this.feedbackSequence}`, at, sessionId: session,
      purpose: this.purpose, vote: v, audible: { ...audible }, ...(previous ? { previous } : {}), evidenceWeight,
      targetBefore: structuredClone(targetBefore), targetAfter: structuredClone(result.target),
      ...(this.intent ? { intent: structuredClone(this.intent), intentText: this.intentText } : {}),
      intentAppliedToAudible,
    });
  }

  stop(): void {
    this.cancelIntentRequest();
    this.publishIntent();
    if (this.state.status === 'idle' || this.state.status === 'stopped') return;
    this.runId++;
    this.rejected = undefined;
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

  private cancelVoteProgress(): void {
    const pending = this.pendingSteer !== undefined;
    this.pendingSteer = undefined;
    this.decision = undefined;
    if (this.state.decision) this.setState({ ...this.state, decision: undefined });
    if (pending) this.emitStats(true);
  }

  private emitStats(steerCanceled = false): void {
    // Keep `heard` — and the `nowPlaying` words derived from it — advancing on the
    // stats cadence: issue #9's "what you're actually hearing" line.
    if (this.canHear()) {
      this.estimateAudible();
      const np = signatureForSent(this.heard);
      if (!sameSignature(np, this.nowPlayingSig)) {
        this.nowPlayingSig = np;
        this.setState({ ...this.state });
      }
    }
    const snapshot = this.statsSnapshot();
    if (steerCanceled) snapshot.steerCanceled = true;
    for (const l of this.statsListeners) l(snapshot);
  }

  private statsSnapshot(): StreamLevels {
    const steer = this.steerProgress();
    if (!ACTIVE_STATUSES.has(this.state.status)) {
      return { ...ZERO_LEVELS, generation: this.blocksLanded, steerProgress: steer.p, steerVote: steer.v };
    }
    const stats: PCMPlayerStats | undefined = this.deps.player.getStats?.();
    // a torn-down player reports silence, not an exception — but the steer still ticks
    if (!stats) return { ...ZERO_LEVELS, generation: this.blocksLanded, steerProgress: steer.p, steerVote: steer.v };
    return {
      energy: stats.energyRms ?? 0,
      brightnessHz: stats.brightnessHz ?? 0,
      pitchHz: stats.pitchHz ?? null,
      bufferedMs: stats.bufferedMs ?? this.deps.player.getBufferedDurationMs(),
      underruns: stats.underruns ?? 0,
      generation: stats.chunksReceived ?? this.blocksLanded,
      steerProgress: steer.p,
      steerVote: steer.v,
    };
  }

  /**
   * 0..1 — how close the latest vote's steer is to reaching the ears. Eases along
   * the clock estimate (generation latency + buffer at vote time + half the vote
   * ramp) but holds at 0.95 until BOTH the ETA has passed AND at least one new
   * generated PCM block has landed since the vote — a fast upstream completes
   * right at the ETA; a stalled one parks the fill just under full. Lingers
   * ~600 ms at 1, then clears to null. Prepared audio instead uses the local
   * crossfade duration and needs no new provider block.
   */
  private steerProgress(): { p: number | null; v: Vote | null } {
    const s = this.pendingSteer;
    if (!s || !this.ready) return { p: null, v: null };
    const now = this.now();
    const landed = s.prepared || this.blocksLanded > s.generationAtVote;
    if (landed && now - s.at >= s.etaMs) {
      s.doneAt ??= now;
      if (now - s.doneAt > 600) {
        this.pendingSteer = undefined;
        return { p: null, v: null };
      }
      return { p: 1, v: s.vote };
    }
    return { p: Math.min(0.95, Math.max(0, (now - s.at) / s.etaMs)), v: s.vote };
  }

  // ---- connection ----

  private connect(): void {
    // Start from the latest target: after a (re)connect there is no audio continuity to protect.
    this.sentFeatures = this.target.features;
    this.sentPrompts = this.target.prompts;
    this.sentIntentRevision = this.intentRevision;
    this.resetHearing(this.sentFeatures, this.sentPrompts);
    this.ready = false;
    this.awaitingReady = false;
    this.blocksLanded = 0; // a new socket restarts the generation count
    const transport = this.deps.createTransport();
    this.transport = transport;
    transport.connect(this.activeHandlers(transport));
  }

  private activeHandlers(transport: MusicTransport): TransportHandlers {
    return {
      onOpen: () => {
        if (this.transport !== transport) return;
        this.started = { features: this.sentFeatures, prompts: this.sentPrompts, intentRevision: this.sentIntentRevision };
        transport.send({ type: 'start', prompts: this.sentPrompts });
      },
      onMessage: (msg) => this.transport === transport && this.onServerMessage(msg),
      onAudio: (bytes) => {
        if (this.transport !== transport || !this.ready || this.awaitingReady) return;
        this.deps.player.enqueuePcm(bytes);
        this.blocksLanded++;
      },
      onClose: () => {
        if (this.transport === transport) this.connectionLost('connection closed');
      },
    };
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'ready':
        this.lookaheadSupported = msg.prefetch === true;
        const resetHearing = !this.ready || this.awaitingReady;
        this.deps.player.configure(msg.audio);
        this.ready = true;
        this.awaitingReady = false;
        this.attempts = 0;
        this.setState({ status: 'playing' });
        const started = this.started;
        if (resetHearing) this.resetHearing(started?.features ?? this.sentFeatures, started?.prompts ?? this.sentPrompts, started?.intentRevision ?? this.sentIntentRevision);
        this.started = undefined; // `ready` can repeat after an upstream reconnect; only the first one matters
        if (started && started.prompts !== this.sentPrompts) {
          // Voted while connecting: the relay started on an older target, so ramp to the latest.
          this.sentFeatures = started.features;
          this.sentPrompts = started.prompts;
          this.sentIntentRevision = started.intentRevision;
          this.retarget(this.target);
        } else {
          this.scheduleEvolve();
        }
        this.scheduleLookahead();
        return;
      case 'status':
        if (msg.state === 'reconnecting') {
          this.cancelVoteProgress();
          this.clearLookahead();
          if (!this.awaitingReady) this.started ??= { features: this.sentFeatures, prompts: this.sentPrompts, intentRevision: this.sentIntentRevision };
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
    void this.deps.player.close().catch(() => { });
    this.setState({ status: 'error', lastError: message });
  }

  private teardownConnection(): void {
    this.clearLookahead();
    this.lookaheadSupported = false;
    clearTimeout(this.lookaheadTimer);
    this.lookaheadTimer = undefined;
    this.transport?.close();
    this.rejected = undefined;
    this.transport = undefined;
    this.ready = false;
    this.awaitingReady = false;
    this.started = undefined;
    this.cancelVoteProgress();
    this.blocksLanded = 0;
    this.ramp = undefined;
    clearTimeout(this.rampTimer);
    clearTimeout(this.evolveTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.statsTimer);
    this.rampTimer = this.evolveTimer = this.retryTimer = undefined;
    this.statsTimer = undefined;
  }

  // ---- steering ----

  private retarget(target: Target, resetEvolve = true, rampMs = this.cfg.rampMs): void {
    const directionChanged = !sameTarget(this.target, target);
    if (directionChanged) this.clearLookahead();
    this.target = target;
    this.signature = deriveSignature(target);
    if (ACTIVE_STATUSES.has(this.state.status)) {
      // Signature-only steering change: same status, new identity — still an emission.
      this.setState({ ...this.state });
    }
    if (!this.ready || this.awaitingReady) {
      clearTimeout(this.rampTimer);
      // Not streaming yet (or reconnecting): connect() will start from this target.
      this.sentFeatures = target.features;
      this.sentPrompts = target.prompts;
      this.sentIntentRevision = this.intentRevision;
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
      if (this.sentIntentRevision !== this.intentRevision) {
        this.sentIntentRevision = this.intentRevision;
        this.history.push({ at: this.now(), features: this.sentFeatures, prompts: this.sentPrompts, intentRevision: this.intentRevision });
      }
      // Likes can keep arriving without postponing fresh variations forever.
      if (resetEvolve && (directionChanged || this.evolveTimer === undefined)) this.scheduleEvolve();
      return;
    }
    // Endpoints fit the relay, but two different briefs can exceed its prompt count
    // when blended. Send the complete new target in that case; never drop constraints.
    const tooMany = new Set([...this.sentPrompts, ...target.prompts].map(prompt => prompt.text)).size > MAX_PROMPT_COUNT;
    this.ramp = { fromIntentRevision: this.sentIntentRevision, fromFeatures: this.sentFeatures, fromPrompts: this.sentPrompts,
      target, step: tooMany ? Math.ceil(rampMs / this.cfg.stepMs) : 0, durationMs: rampMs };
    this.tick();
    if (resetEvolve) this.scheduleEvolve();
  }

  private tick(): void {
    const ramp = this.ramp;
    if (!ramp || !this.ready || this.awaitingReady) return;
    ramp.step++;
    const t = Math.min(1, (ramp.step * this.cfg.stepMs) / ramp.durationMs);
    this.sentFeatures = t >= 1 ? ramp.target.features : lerpBlend(ramp.fromFeatures, ramp.target.features, t);
    this.sentPrompts = lerpPrompts(ramp.fromPrompts, ramp.target.prompts, t);
    const at = this.now();
    this.sentIntentRevision = t >= 1 ? this.intentRevision : ramp.fromIntentRevision;
    this.history.push({ at, features: this.sentFeatures, prompts: this.sentPrompts, intentRevision: this.sentIntentRevision });
    this.history = this.history.filter((h, i) => i === 0 || at - h.at <= this.cfg.historyRetentionMs);
    this.transport?.send({ type: 'steer', revision: ++this.revision, prompts: this.sentPrompts });
    if (t < 1) this.rampTimer = setTimeout(() => this.tick(), this.cfg.stepMs);
    else this.ramp = undefined;
  }

  // Best guess of what the listener hears: the newest blend we sent early enough to have cleared the buffer.
  private estimateAudible(): FeatureBlend {
    // A growing queue cannot make already heard music become unheard again.
    if (this.hasAudiblePlayback()) this.audibleCursor = Math.max(this.audibleCursor, this.audibleCutoff());
    this.heard = this.pickHeard(this.audibleCursor);
    return this.heard?.features ?? this.sentFeatures;
  }

  private audibleCutoff(): number {
    return this.now() - this.deps.player.getBufferedDurationMs() - this.cfg.generationLatencyMs;
  }

  private pickHeard(cursor: number): Sent | undefined {
    let pick = this.heard ?? this.history[0];
    for (const h of this.history) if (h.at <= cursor && (!pick || h.at >= pick.at)) pick = h;
    return pick;
  }

  /** Read-only twin of estimateAudible for the visualizer: never moves the vote-attribution cursor. */
  getAudibleFeatures(): FeatureBlend {
    const cursor = this.hasAudiblePlayback() ? Math.max(this.audibleCursor, this.audibleCutoff()) : this.audibleCursor;
    return this.pickHeard(cursor)?.features ?? this.sentFeatures;
  }

  /** Spectrum of what is playing, for the visualizer. Null before init and after close. */
  getAnalyser(): AnalyserNode | null {
    return this.deps.player.getAnalyser?.() ?? null;
  }

  /** The learner's current per-feature scores, for showing what it has learned. */
  getTaste(): Record<string, number> {
    return { ...this.learnerState.scores };
  }

  /** What is audible right now, as a target that can be returned to later. Null when nothing is playing. */
  captureMoment(): Target | null {
    if (!this.canHear()) return null;
    const cursor = this.hasAudiblePlayback() ? Math.max(this.audibleCursor, this.audibleCutoff()) : this.audibleCursor;
    const heard = this.pickHeard(cursor);
    return heard?.prompts ? { features: { ...heard.features }, prompts: heard.prompts.map((p) => ({ ...p })) } : null;
  }

  /**
   * Steer back to a captured moment. The same prompts give a similar sound, not
   * the same audio. Not a vote: the learner's state is untouched.
   */
  recallMoment(moment: Target): boolean {
    if (!this.canHear() || moment.prompts.length === 0) return false;
    if (!matchesIntent(moment.features, this.intent)) {
      this.setState({ ...this.state, intentMessage: 'That moment conflicts with your request. Edit or clear it to return to that sound.' });
      return false;
    }
    this.log('recall', { target: moment.features });
    // Rebuild the current request overlay rather than replaying stale request text.
    const target = this.deps.learner.restoreTarget?.({ state: this.learnerState, currentTarget: this.target, moment, intent: this.intent })
      ?? { ...this.target, features: { ...moment.features }, prompts: moment.prompts.map(p => ({ ...p })) };
    if (!sameTarget(this.target, target)) this.cancelVoteProgress();
    this.retarget(target, true, this.cfg.voteRampMs);
    if (this.state.intentStatus === 'ready') this.setState({ ...this.state, intentMessage: undefined });
    return true;
  }

  /**
   * Steer one step toward a feature the listener picked, over the usual ramp.
   * Repeat clicks go further. Not a vote: the learner's state is untouched.
   */
  nudge(feature: string): void {
    if (!this.canHear() || !this.deps.learner.nudge) return;
    const group = GROUP_OF_ID.get(feature);
    const conflicts = this.intent && (this.intent.excludedFeatures.some(id => id === feature)
      || this.intent.requiredFeatures.some(id => GROUP_OF_ID.get(id) === group && id !== feature));
    if (conflicts) {
      this.setState({ ...this.state, intentMessage: 'That style conflicts with your request. Edit or clear it to explore that direction.' });
      return;
    }
    const target = this.deps.learner.nudge({ state: this.learnerState, target: this.target, feature, intent: this.intent });
    if (!sameTarget(this.target, target)) this.cancelVoteProgress();
    this.log('nudge', { feature, target: target.features });
    this.retarget(target);
    if (this.state.intentStatus === 'ready') this.setState({ ...this.state, intentMessage: undefined });
  }

  private resetHearing(features: FeatureBlend, prompts?: WeightedPrompt[], intentRevision = this.sentIntentRevision): void {
    // configure/reconnect does not flush queued PCM. Keep its last heard context
    // until the new timeline has cleared the measured buffer and generation delay.
    const buffered = this.deps.player.getBufferedDurationMs() > 0 ? this.heard : undefined;
    this.history = [{ at: this.now(), features, prompts, intentRevision }];
    this.heard = buffered ?? this.history[0];
    this.audibleCursor = -Infinity;
    this.evidenceHistory = [];
    this.rejected = undefined;
  }

  private canHear(): boolean {
    return this.ready && !this.awaitingReady && this.state.status === 'playing';
  }

  private evidenceWeight(audible: FeatureBlend): number {
    if (!this.hasAudiblePlayback() || this.heard?.intentRevision !== this.intentRevision) return 0;
    const at = this.now();
    this.evidenceHistory = this.evidenceHistory.filter((observation) => at - observation.at < this.cfg.evidenceWindowMs);
    if (this.evidenceHistory.some((observation) => blendDistance(observation.features, audible) < this.cfg.evidenceBlendDistance)) return 0;
    this.evidenceHistory.push({ at, features: { ...audible } });
    return 1;
  }

  private hasAudiblePlayback(): boolean {
    if (this.now() < this.branchSettlesAt) return false;
    if (!this.canHear()) return false;
    const stats = this.deps.player.getStats?.();
    return !stats || (stats.state === 'ready' && !stats.priming
      && (stats.audioContextState === undefined || stats.audioContextState === 'running'));
  }

  // Planning uses detached hypothetical states. Only applyVote commits evidence/history.
  private scheduleLookahead(): void {
    clearTimeout(this.lookaheadTimer);
    this.lookaheadTimer = undefined;
    if (!this.lookahead || !this.lookaheadSupported || !this.canHear()) return;
    this.lookaheadTimer = setTimeout(() => {
      this.lookaheadTimer = undefined;
      this.prepareLookahead();
      this.scheduleLookahead();
    }, 1000);
  }

  private prepareLookahead(): void {
    if (!this.lookahead || !this.lookaheadSupported || this.ramp || !this.hasAudiblePlayback()) return;
    const audible = this.estimateAudible();
    // Predictions while the audible blend is still in a ramp are usually stale.
    if (blendDistance(audible, this.target.features) > 1e-9) return;
    const key = JSON.stringify([this.runId, this.intentRevision, this.learnerState.votes, this.target.features, this.target.prompts, this.rejected?.at]);
    if (key === this.preparedKey) return;
    this.preparedKey = key; // at most one attempt per real state; failures do not spin up retries
    const previous = this.rejected && this.now() - this.rejected.at <= this.cfg.comparisonWindowMs
      && blendDistance(this.rejected.features, audible) >= this.cfg.evidenceBlendDistance
      ? this.rejected.features : undefined;
    const predict = (vote: Vote) => this.deps.learner.processVote({
      state: structuredClone(this.learnerState), audible: { ...audible }, currentTarget: structuredClone(this.target),
      vote, evidenceWeight: 1, intent: this.intent, ...(vote === 'up' && previous ? { comparison: { previous: { ...previous } } } : {}),
    }).target;
    const targets = { up: predict('up'), down: predict('down') };
    this.log('lookahead_prepare', { up: targets.up.features, down: targets.down.features });
    this.lookahead.prepare(targets);
  }

  private clearLookahead(): void {
    this.lookahead?.clear();
    this.preparedKey = undefined;
  }

  private usePrepared(vote: Vote, target: Target): boolean {
    if (!this.lookahead || !this.hasAudiblePlayback() || this.ramp) return false;
    const prepared = this.lookahead.take(vote, target);
    if (!prepared) return false;
    const fadeMs = 100;
    if (!this.deps.player.replacePcm?.(prepared.audio, prepared.chunks, fadeMs)) {
      prepared.dispose();
      return false;
    }
    const changed = !sameTarget(this.target, target);
    const old = this.transport;
    this.transport = prepared.transport;
    this.target = target;
    this.sentFeatures = target.features;
    this.sentPrompts = target.prompts;
    this.sentIntentRevision = this.intentRevision;
    this.started = undefined;
    this.ready = true;
    this.awaitingReady = false;
    this.ramp = undefined;
    clearTimeout(this.rampTimer);
    this.rampTimer = undefined;
    // Cached audio starts now, rather than after the old queue/control delay.
    // Preserve the rejection reference and correlated-click ledger across the switch.
    this.history = [{ at: this.now(), features: { ...target.features }, intentRevision: this.intentRevision, prompts: target.prompts.map(p => ({ ...p })) }];
    this.heard = this.history[0];
    this.audibleCursor = -Infinity;
    this.signature = deriveSignature(target);
    this.nowPlayingSig = this.signature;
    // Cached PCM is already available; this path has no provider/old-buffer wait.
    this.pendingSteer = { vote, at: this.now(), etaMs: fadeMs, generationAtVote: this.blocksLanded, prepared: true };
    this.setState({ status: 'playing' });
    this.branchSettlesAt = this.now() + fadeMs + 500;
    this.preparedKey = undefined;
    old?.send({ type: 'stop' });
    old?.close();
    prepared.activate(this.activeHandlers(prepared.transport));
    this.log('lookahead_selected', { vote, target: target.features, fadeMs });
    if (changed || this.evolveTimer === undefined) this.scheduleEvolve();
    this.scheduleLookahead();
    return true;
  }

  private nextVariation(): Target {
    const target = this.deps.learner.evolveNoVote({ state: this.learnerState, target: this.target, step: ++this.noveltyStep, intent: this.intent });
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
    if (ACTIVE_STATUSES.has(next.status)) {
      next = {
        ...next,
        signature: this.signature ?? next.signature,
        nowPlaying: this.nowPlayingSig ?? next.nowPlaying,
        decision: this.decision ?? next.decision,
      };
    }
    const combined = { ...this.state, ...next };
    if (!('lastError' in next)) delete combined.lastError;
    if (!ACTIVE_STATUSES.has(combined.status)) {
      delete combined.signature;
      delete combined.nowPlaying;
      delete combined.decision;
    }
    if (JSON.stringify(combined) === JSON.stringify(this.state)) return;
    this.state = combined;
    for (const l of this.listeners) l(combined);
    this.updateStatsTimer();
  }
}
