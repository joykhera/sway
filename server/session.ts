import type {
  ClientMessage,
  ErrorCode,
  ServerMessage,
  StreamConfig,
  WeightedPrompt,
} from '../src/shared/protocol.ts';
import type { StreamSlots } from './limits.ts';
import { errorMessage, log } from './log.ts';
import { PREFETCH_AUDIO_LIMIT_MS, PREFETCH_LIFETIME_MS, PREFETCH_PAUSED_TTL_MS, PREFETCH_SETUP_TIMEOUT_MS, validPrefetchMs } from './prefetch.ts';
import type { MusicUpstream, UpstreamFactory, UpstreamFormat } from './upstream/types.ts';

export type ClientSocket = {
  readonly readyState: number;
  send(data: string | Buffer, opts?: { binary?: boolean }): void;
};

export type SessionState = 'idle' | 'connecting' | 'playing' | 'paused' | 'reconnecting' | 'closed';

export const STEER_INTERVAL_MS = 200;
export const RECONNECT_BACKOFF_MS = [500, 1000, 2000];
const WS_OPEN = 1;

type Target = { prompts: WeightedPrompt[]; config: StreamConfig };

export class Session {
  state: SessionState = 'idle';
  private upstream: MusicUpstream | undefined;
  private target: Target = { prompts: [], config: {} };
  private lastRevision = -1;
  private dirty = false;
  private configDirty = false;
  private lastSteerAt = -Infinity;
  private steerTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private awaitingReady = false;
  private hasSlot = false;
  private prefetchMs: number | undefined;
  private prefetchBytes = 0;
  private prefetchFormat: UpstreamFormat | undefined;
  private prefetchSetupTimer: ReturnType<typeof setTimeout> | undefined;
  private prefetchPausedTimer: ReturnType<typeof setTimeout> | undefined;
  private prefetchLifetimeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly socket: ClientSocket,
    private readonly createUpstream: UpstreamFactory,
    private readonly slots: StreamSlots,
    readonly id = 'session',
  ) {}

  handle(msg: ClientMessage): void {
    if (this.state === 'closed') return;
    switch (msg.type) {
      case 'start':
        return this.start(msg.prompts, msg.config ?? {}, msg.prefetchMs);
      case 'steer':
        return this.steer(msg.revision, msg.prompts, msg.config);
      case 'stop':
        return this.stop();
      case 'resume':
        return this.resume();
    }
  }

  sendError(code: ErrorCode, message: string, retryable: boolean): void {
    this.send({ type: 'error', code, message, retryable });
  }

  dispose(): void {
    if (this.state === 'closed') return;
    this.teardown();
    this.state = 'closed';
    log.info(this.id, 'disposed');
  }

  private start(prompts: WeightedPrompt[], config: StreamConfig, prefetchMs?: number): void {
    if (this.state !== 'idle') return this.sendError('bad_state', `cannot start while ${this.state}`, false);
    if (prefetchMs !== undefined && !validPrefetchMs(prefetchMs)) {
      return this.sendError('bad_message', 'prefetchMs must be an integer in [3000, 8000]', false);
    }
    if (!this.slots.tryAcquire()) {
      log.warn(this.id, 'stream capacity reached', { inUse: this.slots.inUse });
      return this.sendError('capacity', 'Too many active streams, try again shortly', true);
    }
    this.hasSlot = true;
    this.prefetchMs = prefetchMs;
    if (prefetchMs !== undefined) {
      this.prefetchSetupTimer = setTimeout(() => this.prefetchFailed('Prefetch did not receive audio before its setup deadline'), PREFETCH_SETUP_TIMEOUT_MS);
      this.prefetchLifetimeTimer = setTimeout(() => this.prefetchFailed('Prefetch lifetime expired'), PREFETCH_LIFETIME_MS);
    }
    this.target = { prompts, config };
    this.lastRevision = -1;
    this.state = 'connecting';
    this.send({ type: 'status', state: 'connecting' });
    log.info(this.id, 'start', { prompts: shares(prompts), config });
    this.connect();
  }

  private steer(revision: number, prompts: WeightedPrompt[], config: StreamConfig | undefined): void {
    if (this.state === 'idle') return this.sendError('bad_state', 'steer before start', false);
    if (this.prefetchMs !== undefined) return this.sendError('bad_state', 'resume before steering a prefetched stream', false);
    if (revision <= this.lastRevision) {
      log.info(this.id, 'stale steer dropped', { revision, lastRevision: this.lastRevision });
      return;
    }
    this.lastRevision = revision;
    this.target = { prompts, config: config ? { ...this.target.config, ...config } : this.target.config };
    this.dirty = true;
    if (config) this.configDirty = true;
    if (this.state === 'playing') this.scheduleFlush();
  }

  private stop(): void {
    if (this.state !== 'idle') log.info(this.id, 'stop');
    this.teardown();
    this.state = 'idle';
    this.send({ type: 'status', state: 'stopped' });
  }

  private resume(): void {
    if (this.prefetchMs === undefined && this.state === 'playing') return; // Duplicate promotion.
    if (this.prefetchMs === undefined || (this.state !== 'paused' && this.state !== 'playing')) {
      return this.sendError('bad_state', `cannot resume while ${this.state}`, false);
    }
    const up = this.upstream;
    if (!up?.resume) return this.prefetchFailed('Upstream cannot resume prefetch');
    const wasPaused = this.state === 'paused';
    // Clear speculative limits before resuming: synchronous audio callbacks are now ordinary audio.
    this.clearPrefetch();
    this.state = 'playing';
    try { if (wasPaused) up.resume(); }
    catch (error) { this.upstreamFailed(up, errorMessage(error)); return; }
    if (this.upstream === up && this.state === 'playing') this.send({ type: 'status', state: 'playing' });
  }

  private connect(): void {
    const up: MusicUpstream = this.createUpstream({
      onAudio: (chunk, format) => {
        if (up === this.upstream) this.onAudio(chunk, format);
      },
      onFiltered: (info) => {
        if (up !== this.upstream) return;
        log.warn(this.id, 'prompt filtered', info);
        if (this.prefetchMs !== undefined) return this.prefetchFailed('Prefetch prompt was filtered', 'prompt_filtered');
        this.sendError('prompt_filtered', `Prompt was filtered${info.text ? `: ${info.text}` : ''}`, true);
      },
      onWarning: (message) => {
        if (up === this.upstream) log.warn(this.id, 'upstream message', { message });
      },
      onClosed: (reason, retryable) => this.upstreamFailed(up, reason, retryable),
    });
    this.upstream = up;
    if (this.prefetchMs !== undefined && (!up.pause || !up.resume)) {
      return this.prefetchFailed('Upstream does not support bounded prefetch');
    }
    this.awaitingReady = true;
    this.dirty = false;
    this.configDirty = false;
    this.lastSteerAt = -Infinity;
    try {
      up.start(this.target.prompts, this.target.config).catch((err) => this.upstreamFailed(up, errorMessage(err)));
    } catch (err) { this.upstreamFailed(up, errorMessage(err)); }
  }

  private onAudio(chunk: Buffer, format: UpstreamFormat): void {
    if (this.prefetchMs !== undefined) {
      if (chunk.length === 0) return; // Empty provider frames do not satisfy the first-audio deadline.
      if (format.channels !== 2 || !Number.isInteger(format.sampleRateHz) || format.sampleRateHz < 8000
        || format.sampleRateHz > 192000 || (this.prefetchFormat && format.sampleRateHz !== this.prefetchFormat.sampleRateHz)) {
        return this.prefetchFailed('Invalid or changing prefetch audio format');
      }
      this.prefetchFormat = { ...format };
      const nextBytes = this.prefetchBytes + chunk.length;
      if (nextBytes > format.sampleRateHz * 4 * PREFETCH_AUDIO_LIMIT_MS / 1000) {
        return this.prefetchFailed('Prefetch exceeded its audio limit');
      }
      this.prefetchBytes = nextBytes;
    }
    if (this.awaitingReady) {
      if (format.channels !== 2) {
        log.error(this.id, 'unsupported channel count', { ...format });
        this.sendError('internal', 'Unsupported audio format from provider', false);
        return this.stop();
      }
      this.awaitingReady = false;
      clearTimeout(this.prefetchSetupTimer);
      this.prefetchSetupTimer = undefined;
      this.attempts = 0;
      this.state = 'playing';
      this.send({ type: 'ready', audio: { format: 'pcm_s16le', sampleRateHz: format.sampleRateHz, channels: 2 },
        ...(this.upstream?.pause && this.upstream.resume ? { prefetch: true } : {}) });
      this.send({ type: 'status', state: 'playing' });
      log.info(this.id, 'ready', { ...format });
      if (this.dirty) this.scheduleFlush();
    }
    if (this.socket.readyState === WS_OPEN) this.socket.send(chunk, { binary: true });
    if (this.prefetchMs !== undefined && this.state === 'playing'
      && this.prefetchBytes >= format.sampleRateHz * 4 * this.prefetchMs / 1000) {
      const up = this.upstream!;
      this.state = 'paused';
      this.prefetchPausedTimer = setTimeout(() => this.prefetchFailed('Paused prefetch expired'), PREFETCH_PAUSED_TTL_MS);
      try { up.pause!(); }
      catch (error) { this.prefetchFailed(`Could not pause prefetch: ${errorMessage(error)}`); return; }
      if (this.upstream === up && this.state === 'paused') this.send({ type: 'status', state: 'paused' });
    }
  }

  private prefetchFailed(message: string, code: ErrorCode = 'upstream_unavailable'): void {
    if (this.prefetchMs === undefined) return;
    this.teardown();
    this.state = 'idle';
    this.sendError(code, message, false);
  }

  private upstreamFailed(up: MusicUpstream, reason: string, retryable = true): void {
    if (up !== this.upstream) return;
    if (this.prefetchMs !== undefined) return this.prefetchFailed('Prefetch upstream was lost');
    if (!retryable) {
      const connecting = this.state === 'connecting';
      this.teardown();
      this.state = 'idle';
      return this.sendError(connecting ? 'upstream_unavailable' : 'upstream_lost',
        connecting ? 'Could not start the music stream' : 'Lost the music stream', false);
    }
    this.upstream = undefined;
    up.close();
    log.warn(this.id, 'upstream lost', { state: this.state, reason });
    if (this.state === 'connecting') {
      this.teardown();
      this.state = 'idle';
      return this.sendError('upstream_unavailable', 'Could not start the music stream', true);
    }
    if (this.state === 'playing') {
      clearTimeout(this.steerTimer);
      this.steerTimer = undefined;
      this.state = 'reconnecting';
      this.attempts = 0;
      this.send({ type: 'status', state: 'reconnecting' });
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const delay = RECONNECT_BACKOFF_MS[this.attempts];
    if (delay === undefined) {
      log.error(this.id, 'reconnect attempts exhausted');
      this.teardown();
      this.state = 'idle';
      return this.sendError('upstream_lost', 'Lost the music stream', true);
    }
    this.attempts++;
    log.info(this.id, 'reconnecting', { attempt: this.attempts, delayMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private scheduleFlush(): void {
    if (this.steerTimer) return;
    const wait = this.lastSteerAt + STEER_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.flush();
    this.steerTimer = setTimeout(() => {
      this.steerTimer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const up = this.upstream;
    if (this.state !== 'playing' || !up || !this.dirty) return;
    const config = this.configDirty ? this.target.config : undefined;
    this.dirty = false;
    this.configDirty = false;
    this.lastSteerAt = Date.now();
    log.info(this.id, 'steer', { revision: this.lastRevision, prompts: shares(this.target.prompts), config });
    up.steer(this.target.prompts, config).catch((err) =>
      log.warn(this.id, 'steer failed', { error: errorMessage(err) }),
    );
  }

  private teardown(): void {
    this.clearPrefetch();
    clearTimeout(this.steerTimer);
    clearTimeout(this.retryTimer);
    this.steerTimer = undefined;
    this.retryTimer = undefined;
    const up = this.upstream;
    this.upstream = undefined;
    up?.close();
    if (this.hasSlot) {
      this.hasSlot = false;
      this.slots.release();
    }
    this.awaitingReady = false;
    this.dirty = false;
    this.configDirty = false;
    this.attempts = 0;
  }

  private clearPrefetch(): void {
    clearTimeout(this.prefetchSetupTimer);
    clearTimeout(this.prefetchPausedTimer);
    clearTimeout(this.prefetchLifetimeTimer);
    this.prefetchSetupTimer = this.prefetchPausedTimer = this.prefetchLifetimeTimer = undefined;
    this.prefetchMs = undefined;
    this.prefetchBytes = 0;
    this.prefetchFormat = undefined;
  }

  private send(msg: ServerMessage): void {
    if (this.socket.readyState === WS_OPEN) this.socket.send(JSON.stringify(msg));
  }
}

// Lyria normalizes weights to sum to 1, so log the effective shares.
function shares(prompts: WeightedPrompt[]): Record<string, number> {
  const total = prompts.reduce((s, p) => s + p.weight, 0);
  return Object.fromEntries(prompts.map((p) => [p.text, Math.round((p.weight / total) * 1000) / 1000]));
}
