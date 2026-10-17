import type {
  ClientMessage,
  ErrorCode,
  ServerMessage,
  StreamConfig,
  WeightedPrompt,
} from '../src/shared/protocol.ts';
import type { StreamSlots } from './limits.ts';
import { errorMessage, log } from './log.ts';
import type { MusicUpstream, UpstreamFactory, UpstreamFormat } from './upstream/types.ts';

export type ClientSocket = {
  readonly readyState: number;
  send(data: string | Buffer, opts?: { binary?: boolean }): void;
};

export type SessionState = 'idle' | 'connecting' | 'playing' | 'reconnecting' | 'closed';

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
        return this.start(msg.prompts, msg.config ?? {});
      case 'steer':
        return this.steer(msg.revision, msg.prompts, msg.config);
      case 'stop':
        return this.stop();
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

  private start(prompts: WeightedPrompt[], config: StreamConfig): void {
    if (this.state !== 'idle') return this.sendError('bad_state', `cannot start while ${this.state}`, false);
    if (!this.slots.tryAcquire()) {
      log.warn(this.id, 'stream capacity reached', { inUse: this.slots.inUse });
      return this.sendError('capacity', 'Too many active streams, try again shortly', true);
    }
    this.hasSlot = true;
    this.target = { prompts, config };
    this.lastRevision = -1;
    this.state = 'connecting';
    this.send({ type: 'status', state: 'connecting' });
    log.info(this.id, 'start', { prompts: shares(prompts), config });
    this.connect();
  }

  private steer(revision: number, prompts: WeightedPrompt[], config: StreamConfig | undefined): void {
    if (this.state === 'idle') return this.sendError('bad_state', 'steer before start', false);
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

  private connect(): void {
    const up: MusicUpstream = this.createUpstream({
      onAudio: (chunk, format) => {
        if (up === this.upstream) this.onAudio(chunk, format);
      },
      onFiltered: (info) => {
        if (up !== this.upstream) return;
        log.warn(this.id, 'prompt filtered', info);
        this.sendError('prompt_filtered', `Prompt was filtered${info.text ? `: ${info.text}` : ''}`, true);
      },
      onWarning: (message) => {
        if (up === this.upstream) log.warn(this.id, 'upstream message', { message });
      },
      onClosed: (reason) => this.upstreamFailed(up, reason),
    });
    this.upstream = up;
    this.awaitingReady = true;
    this.dirty = false;
    this.configDirty = false;
    this.lastSteerAt = -Infinity;
    up.start(this.target.prompts, this.target.config).catch((err) => this.upstreamFailed(up, errorMessage(err)));
  }

  private onAudio(chunk: Buffer, format: UpstreamFormat): void {
    if (this.awaitingReady) {
      if (format.channels !== 2) {
        log.error(this.id, 'unsupported channel count', { ...format });
        this.sendError('internal', 'Unsupported audio format from provider', false);
        return this.stop();
      }
      this.awaitingReady = false;
      this.attempts = 0;
      this.state = 'playing';
      this.send({ type: 'ready', audio: { format: 'pcm_s16le', sampleRateHz: format.sampleRateHz, channels: 2 } });
      this.send({ type: 'status', state: 'playing' });
      log.info(this.id, 'ready', { ...format });
      if (this.dirty) this.scheduleFlush();
    }
    if (this.socket.readyState === WS_OPEN) this.socket.send(chunk, { binary: true });
  }

  private upstreamFailed(up: MusicUpstream, reason: string): void {
    if (up !== this.upstream) return;
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

  private send(msg: ServerMessage): void {
    if (this.socket.readyState === WS_OPEN) this.socket.send(JSON.stringify(msg));
  }
}

// Lyria normalizes weights to sum to 1, so log the effective shares.
function shares(prompts: WeightedPrompt[]): Record<string, number> {
  const total = prompts.reduce((s, p) => s + p.weight, 0);
  return Object.fromEntries(prompts.map((p) => [p.text, Math.round((p.weight / total) * 1000) / 1000]));
}
