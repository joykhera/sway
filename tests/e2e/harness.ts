import type {
  AudioFormat,
  ClientMessage,
  FeatureBlend,
  Learner,
  LearnerState,
  PCMPlayer,
  ServerMessage,
  Target,
  Vote,
} from '../../src/shared/protocol.ts';
import type { MusicTransport, TransportHandlers } from '../../src/transport/types.ts';

export const FORMAT: AudioFormat = { format: 'pcm_s16le', sampleRateHz: 48000, channels: 2 };

// Stands in for A's relay on the client side: enforces start-before-steer and the stale-revision rule.
export class FakeTransport implements MusicTransport {
  sent: ClientMessage[] = [];
  closed = false;
  accepted: number[] = [];
  private h!: TransportHandlers;
  private lastRevision = -1;
  private started = false;

  constructor(private readonly auto: boolean) {}

  connect(h: TransportHandlers): void {
    this.h = h;
    if (this.auto) queueMicrotask(() => this.open());
  }
  send(msg: ClientMessage): void {
    this.sent.push(msg);
    if (msg.type === 'start') {
      this.started = true;
      this.lastRevision = -1;
      if (this.auto) queueMicrotask(() => this.ready());
    } else if (msg.type === 'steer') {
      if (!this.started) throw new Error('steer before start');
      if (msg.revision > this.lastRevision) {
        this.lastRevision = msg.revision;
        this.accepted.push(msg.revision);
      }
    }
  }
  close(): void {
    this.closed = true;
  }

  open(): void { this.h.onOpen(); }
  ready(): void { this.h.onMessage({ type: 'ready', audio: FORMAT }); }
  serverMessage(m: ServerMessage): void { this.h.onMessage(m); }
  audio(bytes = new ArrayBuffer(8)): void { this.h.onAudio(bytes); }
  drop(): void { this.h.onClose(); }
  get steers() { return this.sent.filter((m) => m.type === 'steer') as Extract<ClientMessage, { type: 'steer' }>[]; }
}

export function fakeRelay(auto = true) {
  const transports: FakeTransport[] = [];
  return {
    transports,
    create: () => {
      const t = new FakeTransport(auto);
      transports.push(t);
      return t;
    },
    get last() { return transports[transports.length - 1]!; },
  };
}

export class FakePlayer implements PCMPlayer {
  initialized = 0;
  configured: AudioFormat[] = [];
  chunks = 0;
  closed = 0;
  bufferedMs = 0;
  initFails: Error | undefined;
  /** Set to fake a visualizer tap; null = a context without `createAnalyser`. */
  analyser: AnalyserNode | null = null;
  async initializeFromUserGesture() {
    if (this.initFails) throw this.initFails;
    this.initialized++;
  }
  configure(a: AudioFormat) { this.configured.push(a); }
  enqueuePcm() { this.chunks++; }
  getBufferedDurationMs() { return this.bufferedMs; }
  getAnalyser() { return this.analyser; }
  async close() { this.closed++; }
}

// Deterministic learner: A -> B -> C... down moves to the next style, up keeps it. Records every call.
const STYLES = ['ambient', 'jazz', 'electronic', 'classical', 'lofi'];
const styleTarget = (i: number): Target => ({
  features: { [STYLES[i % STYLES.length]!]: 1 },
  prompts: [{ text: STYLES[i % STYLES.length]!, weight: 1 }],
});

export function fakeLearner() {
  const calls = { vote: [] as { audible: FeatureBlend; vote: Vote; currentTarget: Target }[], evolve: 0 };
  const learner: Learner = {
    createLearner: (seed): LearnerState => ({ scores: {}, votes: 0, seed }),
    initialTarget: () => styleTarget(0),
    processVote: ({ state, audible, currentTarget, vote }) => {
      calls.vote.push({ audible, vote, currentTarget });
      const votes = state.votes + 1;
      const current = STYLES.findIndex((s) => currentTarget.features[s]);
      return {
        state: { ...state, votes, scores: { ...state.scores, [STYLES[current]!]: (vote === 'up' ? 1 : -1) } },
        target: vote === 'up' ? currentTarget : styleTarget(current + 1),
      };
    },
    evolveNoVote: ({ target }) => {
      calls.evolve++;
      return { features: target.features, prompts: target.prompts.map((p) => ({ ...p, weight: p.weight * 0.9 + 0.2 })) };
    },
  };
  return { learner, calls };
}
