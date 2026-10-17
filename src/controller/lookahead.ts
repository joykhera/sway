import type { AudioFormat, Target, Vote } from '../shared/protocol.ts';
import type { MusicTransport, TransportFactory, TransportHandlers } from '../transport/types.ts';

export const LOOKAHEAD_LIMITS = Object.freeze({
  prefetchMs: 6000,
  minimumAudioMs: 3000,
  maximumAudioMs: 12_000,
  maximumBytes: 3 * 1024 * 1024,
  maximumChunks: 256,
  setupMs: 15_000,
  ttlMs: 55_000,
});
export type LookaheadOptions = {
  /** Tests/hosts may shorten deadlines; they cannot extend the hard bounds. */
  setupMs?: number;
  ttlMs?: number;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};
export type PreparedCandidate = {
  audio: AudioFormat;
  /** Snapshot at take(); late pre-activation PCM is forwarded by activate(). */
  chunks: ArrayBuffer[];
  transport: MusicTransport;
  /** Switch the existing socket's callback router, then resume; never reconnect. */
  activate(handlers: TransportHandlers): void;
  /** Also marks callbacks stale; use if the player's replacement was refused. */
  dispose(): void;
};
type Candidate = {
  vote: Vote;
  transport: MusicTransport;
  phase: 'capturing' | 'taken' | 'active' | 'disposed';
  audio?: AudioFormat;
  chunks: ArrayBuffer[];
  bytes: number;
  started: boolean;
  paused: boolean;
  ready: boolean;
  setupDeadline: number;
  expiry: number;
  setupTimer?: ReturnType<typeof setTimeout>;
  ttlTimer?: ReturnType<typeof setTimeout>;
  forward?: TransportHandlers;
};

function deadline(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Lookahead deadline must be positive and finite');
  return Math.min(value, maximum);
}
function audioFormat(value: unknown): value is AudioFormat {
  if (!value || typeof value !== 'object') return false;
  const audio = value as Partial<AudioFormat>;
  return audio.format === 'pcm_s16le' && audio.channels === 2
    && Number.isInteger(audio.sampleRateHz) && audio.sampleRateHz! >= 8000 && audio.sampleRateHz! <= 192000;
}

/** Stable exact identity; ignore diagnostic metadata and property/prompt order. */
function targetKey(target: Target): string | undefined {
  if (!target || !target.features || typeof target.features !== 'object' || Array.isArray(target.features)
    || !Array.isArray(target.prompts) || target.prompts.length === 0 || target.prompts.length > 64) return;
  const features = Object.entries(target.features).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!features.length || features.length > 128 || features.some(([, weight]) => !Number.isFinite(weight) || weight < 0)) return;
  const prompts = target.prompts.map(prompt => [prompt?.text, prompt?.weight] as const);
  if (prompts.some(([text, weight]) => typeof text !== 'string' || !text.length || text.length > 4096
    || !Number.isFinite(weight) || weight < 0.1 || weight > 2)) return;
  prompts.sort(([a, aw], [b, bw]) => a < b ? -1 : a > b ? 1 : aw - bw);
  return JSON.stringify([features, prompts]);
}

/** Two bounded independent streams; no learner, player, retry loop or feedback. */
export class LookaheadPool {
  private readonly setupMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: NonNullable<LookaheadOptions['log']>;
  private generation = 0;
  private keys?: Record<Vote, string>;
  private slots: Partial<Record<Vote, Candidate>> = {};
  /** Taken candidates remain owned until activated, so clear() can cancel a handoff. */
  private owned = new Set<Candidate>();

  constructor(private readonly createTransport: TransportFactory, options: LookaheadOptions = {}) {
    this.setupMs = deadline(options.setupMs, LOOKAHEAD_LIMITS.setupMs);
    this.ttlMs = deadline(options.ttlMs, LOOKAHEAD_LIMITS.ttlMs);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  prepare(targets: { up: Target; down: Target }): void {
    this.clear();
    const up = targetKey(targets.up), down = targetKey(targets.down);
    if (!up || !down) return;
    this.keys = { up, down };
    const starts = { up: targets.up.prompts.map(prompt => ({ ...prompt })), down: targets.down.prompts.map(prompt => ({ ...prompt })) };
    const generation = this.generation;
    for (const vote of ['up', 'down'] as const) {
      if (generation !== this.generation) return;
      let transport: MusicTransport;
      try { transport = this.createTransport(); } catch { this.log('lookahead_unavailable', { vote, reason: 'factory' }); continue; }
      if (generation !== this.generation) { try { transport.close(); } catch {} return; }
      const now = this.now();
      const candidate: Candidate = {
        vote, transport, phase: 'capturing', chunks: [], bytes: 0, started: false, paused: false, ready: false,
        setupDeadline: now + this.setupMs, expiry: now + this.ttlMs,
      };
      // Register BEFORE connect/send: mocks and injected transports may be synchronous.
      this.slots[vote] = candidate;
      this.owned.add(candidate);
      candidate.setupTimer = setTimeout(() => this.dispose(candidate, 'setup_timeout'), this.setupMs);
      candidate.ttlTimer = setTimeout(() => this.dispose(candidate, 'expired'), this.ttlMs);
      const prompts = starts[vote];
      try {
        transport.connect({
          onOpen: () => {
            if (candidate.phase !== 'capturing' || candidate.started || !this.live(candidate)) return;
            candidate.started = true;
            try { transport.send({ type: 'start', prompts, prefetchMs: LOOKAHEAD_LIMITS.prefetchMs }); }
            catch { this.dispose(candidate, 'send_start'); }
          },
          onMessage: message => {
            if (candidate.phase === 'active') { candidate.forward?.onMessage(message); return; }
            if (!this.live(candidate)) return;
            if (message.type === 'error') { this.dispose(candidate, 'server_error'); return; }
            if (message.type === 'ready') {
              if (message.prefetch !== true || !audioFormat(message.audio)) { this.dispose(candidate, 'unsupported_format_or_prefetch'); return; }
              if (candidate.audio && (candidate.audio.sampleRateHz !== message.audio.sampleRateHz || candidate.bytes > 0)) {
                this.dispose(candidate, 'format_restart'); return;
              }
              candidate.audio = { ...message.audio };
            } else if (message.type === 'status') {
              if (message.state === 'stopped' || message.state === 'reconnecting') { this.dispose(candidate, message.state); return; }
              if (message.state === 'paused') candidate.paused = true;
              else if (candidate.paused && message.state === 'playing') { this.dispose(candidate, 'unexpected_resume'); return; }
            }
            this.updateReady(candidate);
          },
          onAudio: bytes => {
            if (candidate.phase === 'active') { candidate.forward?.onAudio(bytes); return; }
            if (!this.live(candidate)) return;
            // No interpretation of partial stereo frames at a handoff boundary.
            // Fail this optional optimization instead of shifting channels/samples.
            if (!candidate.audio || bytes.byteLength % 4 !== 0) { this.dispose(candidate, 'invalid_pcm'); return; }
            if (!bytes.byteLength) return;
            const total = candidate.bytes + bytes.byteLength;
            if (total > LOOKAHEAD_LIMITS.maximumBytes
              || total / (candidate.audio.sampleRateHz * 4) * 1000 > LOOKAHEAD_LIMITS.maximumAudioMs
              || candidate.chunks.length >= LOOKAHEAD_LIMITS.maximumChunks) {
              this.dispose(candidate, 'buffer_limit'); return;
            }
            candidate.bytes = total;
            candidate.chunks.push(bytes.slice(0));
            this.updateReady(candidate);
          },
          onClose: () => {
            const forward = candidate.phase === 'active' ? candidate.forward : undefined;
            this.dispose(candidate, 'closed');
            forward?.onClose();
          },
        });
      } catch { this.dispose(candidate, 'connect'); }
    }
  }

  take(vote: Vote, target: Target): PreparedCandidate | undefined {
    if (!this.keys) return;
    if (targetKey(target) !== this.keys[vote]) { this.clear(); return; }
    const candidate = this.slots[vote];
    if (!candidate || !this.live(candidate) || !candidate.ready || !candidate.audio) return;
    candidate.phase = 'taken';
    const chunks = candidate.chunks.slice();
    candidate.chunks = []; // Capture any in-flight tail separately until activation.
    const sibling = this.slots[vote === 'up' ? 'down' : 'up'];
    if (sibling) this.dispose(sibling, 'not_selected');
    this.slots = {};
    this.keys = undefined;
    let activationAttempted = false;
    return {
      audio: { ...candidate.audio }, chunks, transport: candidate.transport,
      dispose: () => this.dispose(candidate, 'handoff_disposed'),
      activate: handlers => {
        if (activationAttempted) return;
        activationAttempted = true;
        if (candidate.phase !== 'taken' || !this.live(candidate)) { handlers.onClose(); return; }
        this.clearTimers(candidate);
        this.owned.delete(candidate); // Pool refresh/clear must never close live playback.
        candidate.forward = handlers;
        candidate.phase = 'active';
        const tail = candidate.chunks;
        candidate.chunks = [];
        candidate.bytes = 0;
        for (const bytes of tail) {
          if (candidate.phase !== 'active') return;
          handlers.onAudio(bytes);
        }
        if (candidate.phase !== 'active') return;
        try { candidate.transport.send({ type: 'resume' }); }
        catch { if (candidate.phase === 'active') { this.dispose(candidate, 'send_resume'); handlers.onClose(); } }
      },
    };
  }

  /** Close only speculative/unactivated streams. Activated playback belongs to D. */
  clear(): void {
    this.generation++;
    for (const candidate of [...this.owned]) this.dispose(candidate, 'cleared');
    this.keys = undefined;
    this.slots = {};
  }

  private live(candidate: Candidate): boolean {
    if (candidate.phase === 'disposed' || candidate.phase === 'active') return false;
    if (this.now() >= candidate.expiry) { this.dispose(candidate, 'expired'); return false; }
    if (!candidate.ready && this.now() >= candidate.setupDeadline) { this.dispose(candidate, 'setup_timeout'); return false; }
    return true;
  }

  private updateReady(candidate: Candidate): void {
    if (candidate.ready || !candidate.audio || !candidate.paused) return;
    if (candidate.bytes / (candidate.audio.sampleRateHz * 4) * 1000 < LOOKAHEAD_LIMITS.minimumAudioMs) return;
    candidate.ready = true;
    if (candidate.setupTimer !== undefined) clearTimeout(candidate.setupTimer);
    candidate.setupTimer = undefined;
    this.log('lookahead_ready', { vote: candidate.vote, bufferedMs: candidate.bytes / (candidate.audio.sampleRateHz * 4) * 1000 });
  }

  private clearTimers(candidate: Candidate): void {
    if (candidate.setupTimer !== undefined) clearTimeout(candidate.setupTimer);
    if (candidate.ttlTimer !== undefined) clearTimeout(candidate.ttlTimer);
    candidate.setupTimer = candidate.ttlTimer = undefined;
  }

  private dispose(candidate: Candidate, reason: string): void {
    if (candidate.phase === 'disposed') return;
    candidate.phase = 'disposed';
    candidate.forward = undefined;
    this.clearTimers(candidate);
    candidate.chunks = [];
    candidate.bytes = 0;
    this.owned.delete(candidate);
    if (this.slots[candidate.vote] === candidate) delete this.slots[candidate.vote];
    try { candidate.transport.close(); } catch { /* Optional speculative failure stays silent. */ }
    this.log('lookahead_disposed', { vote: candidate.vote, reason });
  }
}
