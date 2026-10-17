// One MusicSession per browser WebSocket connection.
//
// State machine (part-a-plan):
//   idle → connecting → playing ⇄ reconnecting → closed
//
// - `start` only from `idle`; any other state → error{bad_state}.
// - `steer` with revision <= lastApplied → dropped silently. While connecting
//   or reconnecting, keep only the newest pending steer; applied once playing.
// - Upstream sends coalesced ≤1 per ~200 ms (newest wins) — Lyria itself also
//   coalesces latest-wins internally; this keeps wire traffic polite (R11).
// - Upstream close while playing → status:reconnecting → reopen ≤3 times with
//   backoff using the latest APPLIED prompts → fresh `ready` + status:playing;
//   exhausted → error{upstream_lost, retryable:true} + dispose.
// - filteredPrompt → error{prompt_filtered, retryable:true} + log.
// - upstream start() rejection → error{upstream_unavailable, retryable:true}
//   and the session returns to `idle` so the client may retry `start`.
// - `stop` / client close / ws error → dispose(): close upstream, clear ALL
//   timers, release the stream slot. Idempotent.

import { parseClientMessage, ProtocolError } from './guard.ts';
import { errMessage, log } from './log.ts';
import type {
  AudioFormat,
  ClientMessage,
  ErrorCode,
  ServerMessage,
  StreamConfig,
  WeightedPrompt,
} from '../src/shared/protocol.ts';
import type {
  MusicUpstream,
  UpstreamCallbacks,
} from './upstream/types.ts';

export type SessionState =
  | 'idle'
  | 'connecting'
  | 'playing'
  | 'reconnecting'
  | 'closed';

export type SessionDeps = {
  /** JSON ServerMessage to the browser. */
  send(msg: ServerMessage): void;
  /** Binary audio frame to the browser. */
  sendBinary(chunk: Buffer): void;
  /** Factory for a fresh upstream (index.ts picks Lyria vs Mock by mode). */
  createUpstream(): MusicUpstream;
  /** Release the stream slot (index.ts frees capacity). */
  onDispose?(): void;
  /** Steer coalescing window. Default 200 ms. */
  steerIntervalMs?: number;
  /** Reconnect attempts before upstream_lost. Default 3. */
  maxReconnectAttempts?: number;
  /** Backoff base; attempt n waits base * 2^(n-1). Default 400 ms. */
  reconnectBaseDelayMs?: number;
};

const DEFAULT_STEER_INTERVAL_MS = 200;
const DEFAULT_MAX_RECONNECT = 3;
const DEFAULT_RECONNECT_BASE_MS = 400;

type AppliedInput = { prompts: WeightedPrompt[]; config?: StreamConfig };

export class MusicSession {
  private readonly deps: SessionDeps;
  private readonly steerIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;

  private _state: SessionState = 'idle';
  private disposed = false;

  private upstream: MusicUpstream | null = null;

  /** Latest input actually sent upstream (start or applied steer). */
  private applied: AppliedInput | null = null;
  /** Highest revision applied upstream; start() resets the gate. */
  private lastAppliedRevision = -1;
  /** Newest steer awaiting the coalescing window or `playing` state. */
  private pendingSteer: (AppliedInput & { revision: number }) | null = null;

  private steerTimer: NodeJS.Timeout | null = null;
  private lastSteerSentAt = -Infinity;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private wakeReconnect: (() => void) | null = null;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.steerIntervalMs = deps.steerIntervalMs ?? DEFAULT_STEER_INTERVAL_MS;
    this.maxReconnectAttempts = deps.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT;
    this.reconnectBaseDelayMs = deps.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_MS;
  }

  get state(): SessionState {
    return this._state;
  }

  handleMessage(raw: Buffer | string): void {
    if (this.disposed) return;
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(raw);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.sendError(err.code, err.message, false);
      } else {
        log.error('client message parse failed', { error: errMessage(err) });
        this.sendError('internal', 'internal error parsing message', false);
      }
      return;
    }
    try {
      switch (msg.type) {
        case 'start':
          this.handleStart(msg);
          return;
        case 'steer':
          this.handleSteer(msg);
          return;
        case 'stop':
          this.send({ type: 'status', state: 'stopped' });
          this.dispose();
          return;
      }
    } catch (err) {
      log.error('client message handling failed', { error: errMessage(err) });
      this.sendError('internal', 'internal error handling message', false);
    }
  }

  /** Idempotent teardown: upstream closed, timers cleared, slot released. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this._state = 'closed';
    if (this.steerTimer) {
      clearTimeout(this.steerTimer);
      this.steerTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Unblock a sleeping reconnectLoop so it can observe `disposed` and exit.
    this.wakeReconnect?.();
    this.wakeReconnect = null;
    this.pendingSteer = null;
    const upstream = this.upstream;
    this.upstream = null;
    if (upstream) void upstream.close().catch(() => {});
    this.deps.onDispose?.();
  }

  // ---- message handlers ---------------------------------------------------

  private handleStart(msg: { prompts: WeightedPrompt[]; config?: StreamConfig }): void {
    if (this._state !== 'idle') {
      this.sendError('bad_state', `cannot start while ${this._state}`, false);
      return;
    }
    this._state = 'connecting';
    this.send({ type: 'status', state: 'connecting' });
    this.applied = { prompts: msg.prompts, config: msg.config };
    this.lastAppliedRevision = -1;
    log.info('stream start requested', {
      promptCount: msg.prompts.length,
      shares: msg.prompts.map((p) => ({
        text: p.text,
        share: +(p.weight / msg.prompts.reduce((s, x) => s + x.weight, 0)).toFixed(3),
      })),
    });
    void this.openUpstream();
  }

  private handleSteer(msg: {
    revision: number;
    prompts: WeightedPrompt[];
    config?: StreamConfig;
  }): void {
    if (
      this._state !== 'connecting' &&
      this._state !== 'playing' &&
      this._state !== 'reconnecting'
    ) {
      this.sendError('bad_state', `cannot steer while ${this._state}`, false);
      return;
    }
    // Stale revisions drop silently; also never go backwards vs a queued steer.
    const floor = Math.max(this.lastAppliedRevision, this.pendingSteer?.revision ?? -1);
    if (msg.revision <= floor) return;
    this.pendingSteer = {
      revision: msg.revision,
      prompts: msg.prompts,
      config: msg.config,
    };
    this.scheduleSteerFlush();
  }

  // ---- upstream lifecycle -------------------------------------------------

  /**
   * Open a fresh upstream with the latest applied input. Used by both initial
   * start (state `connecting`) and reconnect attempts (state `reconnecting`).
   */
  private async openUpstream(): Promise<boolean> {
    const upstream = this.deps.createUpstream();
    this.upstream = upstream;
    const applied = this.applied;
    if (!applied) {
      this.upstream = null;
      return false;
    }
    let audio: AudioFormat;
    try {
      ({ audio } = await upstream.start(
        { prompts: applied.prompts, config: applied.config },
        this.makeCallbacks(upstream),
      ));
    } catch (err) {
      if (this.upstream === upstream) this.upstream = null;
      if (this.disposed) return false;
      if (this._state === 'connecting') {
        log.warn('upstream start failed', { error: errMessage(err) });
        this._state = 'idle';
        this.sendError('upstream_unavailable', errMessage(err), true);
      } else {
        // reconnectLoop counts attempts and decides whether to retry.
        log.warn('upstream reconnect attempt failed', { error: errMessage(err) });
      }
      return false;
    }
    if (this.upstream !== upstream || this.disposed) {
      // Superseded or disposed while connecting — don't leak the stream.
      void upstream.close().catch(() => {});
      return false;
    }
    this.send({ type: 'ready', audio });
    this._state = 'playing';
    this.send({ type: 'status', state: 'playing' });
    this.scheduleSteerFlush();
    return true;
  }

  private makeCallbacks(upstream: MusicUpstream): UpstreamCallbacks {
    const current = () => this.upstream === upstream && !this.disposed;
    return {
      onAudio: (chunk) => {
        if (current()) this.sendBinary(chunk);
      },
      onFiltered: (prompts) => {
        if (!current()) return;
        log.warn('upstream filtered prompt(s)', { prompts });
        this.sendError(
          'prompt_filtered',
          `filtered prompt(s): ${prompts.join(', ')}`,
          true,
        );
      },
      onWarning: (message) => log.warn('upstream warning', { message }),
      onClosed: (reason) => {
        if (!current()) return;
        this.upstream = null;
        // While `connecting` the pending start() rejection already reports the
        // failure (upstream_unavailable); while `reconnecting` the in-flight
        // attempt's rejection drives the retry loop. Only a drop from `playing`
        // starts a reconnect here.
        if (this._state === 'playing') {
          this._state = 'reconnecting';
          this.send({ type: 'status', state: 'reconnecting' });
          log.warn('upstream closed; reconnecting', { reason: reason ?? '' });
          void this.reconnectLoop();
        }
      },
    };
  }

  private async reconnectLoop(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
      if (this.disposed || this._state !== 'reconnecting') return;
      await this.sleep(this.reconnectBaseDelayMs * 2 ** (attempt - 1));
      if (this.disposed || this._state !== 'reconnecting') return;
      if (await this.openUpstream()) return; // fresh ready + playing
    }
    if (this.disposed || this._state !== 'reconnecting') return;
    log.error('upstream reconnect exhausted', { attempts: this.maxReconnectAttempts });
    this.sendError('upstream_lost', 'upstream stream lost after retries', true);
    this.dispose();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wakeReconnect = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.wakeReconnect = null;
        resolve();
      }, ms);
    });
  }

  // ---- steer coalescing ---------------------------------------------------

  private scheduleSteerFlush(): void {
    if (this.steerTimer || !this.pendingSteer) return;
    const wait = Math.max(0, this.steerIntervalMs - (Date.now() - this.lastSteerSentAt));
    this.steerTimer = setTimeout(() => {
      this.steerTimer = null;
      this.flushSteer();
    }, wait);
  }

  private flushSteer(): void {
    if (this._state !== 'playing' || !this.upstream || !this.pendingSteer) return;
    const steer = this.pendingSteer;
    this.pendingSteer = null;
    this.lastAppliedRevision = steer.revision;
    this.applied = {
      prompts: steer.prompts,
      config: steer.config ?? this.applied?.config,
    };
    this.lastSteerSentAt = Date.now();
    this.upstream.steer(steer.prompts, steer.config);
  }

  // ---- send helpers -------------------------------------------------------

  private sendError(code: ErrorCode, message: string, retryable: boolean): void {
    this.send({ type: 'error', code, message, retryable });
  }

  private send(msg: ServerMessage): void {
    try {
      this.deps.send(msg);
    } catch (err) {
      log.warn('failed to send to client', { error: errMessage(err) });
    }
  }

  private sendBinary(chunk: Buffer): void {
    try {
      this.deps.sendBinary(chunk);
    } catch (err) {
      log.warn('failed to send audio to client', { error: errMessage(err) });
    }
  }
}
