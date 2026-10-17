// Browser PCM player built on an AudioWorklet (handoff §5).
// Every Web Audio touch-point goes through narrow structural interfaces so the
// player can be driven by fakes in node tests — no DOM audio exists there.

import {
  PCM_WORKLET_PROCESSOR_NAME,
  type AudioFormat,
  type PCMPlayer,
  type PCMPlayerStats,
  type PCMPlayerState,
  type WorkletInbound,
  type WorkletOutbound,
} from './types.ts';
import { CHANNELS, PENDING_CHUNK_LIMIT } from './constants.ts';
import { workletUrl as bundledWorkletUrl } from './worklet-url.ts';

/** Narrow slice of `AudioContext` the player actually uses. `AudioContext` satisfies this structurally. */
export interface AudioContextLike {
  readonly sampleRate: number;
  /** 'suspended' | 'running' | 'closed' ('interrupted' on iOS); kept as string for fakes. */
  readonly state: string;
  readonly destination: AudioNode;
  readonly audioWorklet: { addModule(moduleURL: string): Promise<void> };
  /** Mirrors `AudioContext.onstatechange`; the player owns this slot while alive. */
  onstatechange: ((event: Event) => void) | null;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** Narrow slice of `AudioWorkletNode.port` (a `MessagePort`). */
export interface WorkletPortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkletInbound, transfer?: Transferable[]): void;
  start?(): void;
}

/** Narrow slice of `AudioWorkletNode`. `AudioWorkletNode` satisfies this structurally. */
export interface WorkletNodeLike {
  readonly port: WorkletPortLike;
  connect(destination: AudioNode): unknown;
  disconnect(): void;
}

/** Injectable seams for tests; browser defaults hit the real Web Audio API. */
export type WorkletPCMPlayerOptions = {
  createAudioContext?: () => AudioContextLike;
  createWorkletNode?: (ctx: AudioContextLike, url: string) => WorkletNodeLike;
  workletUrl?: string;
};

/**
 * Streams interleaved stereo s16le PCM into an AudioWorklet that owns the ring
 * buffer and render loop. `configure()` and `enqueuePcm()` are order-agnostic
 * relative to `initializeFromUserGesture()`: audio is held on the main thread
 * until both have happened, then flushed in order (configure first).
 */
export class WorkletPCMPlayer implements PCMPlayer {
  private readonly makeContext: () => AudioContextLike;
  private readonly makeNode: (ctx: AudioContextLike, url: string) => WorkletNodeLike;
  private readonly url: string;

  private ctx: AudioContextLike | null = null;
  private node: WorkletNodeLike | null = null;
  private initPromise: Promise<void> | null = null;
  private state: PCMPlayerState = 'idle';
  private configured = false;
  private sourceSampleRateHz = 0;
  private pending: ArrayBuffer[] = [];
  /** Set when the ctx slips back to 'suspended'; consumed by the next gesture. */
  private resumeNeeded = false;
  /** Latest `WorkletOutbound` stats message, or null before the first one. */
  private workletStats: WorkletOutbound | null = null;

  constructor(opts: WorkletPCMPlayerOptions = {}) {
    this.makeContext = opts.createAudioContext ?? (() => new AudioContext());
    this.makeNode =
      opts.createWorkletNode ??
      ((ctx) => new AudioWorkletNode(ctx as AudioContext, PCM_WORKLET_PROCESSOR_NAME));
    this.url = opts.workletUrl ?? bundledWorkletUrl;
  }

  initializeFromUserGesture(): Promise<void> {
    // ── Fresh init path (idle, or rebuilding after close()). ──
    if (this.initPromise === null) {
      // iOS/Safari tie AudioContext creation to the gesture task: the
      // constructor MUST run synchronously here — nothing may await above it.
      const ctx = this.makeContext();
      this.ctx = ctx;
      this.node = null;
      this.state = 'initializing';
      this.resumeNeeded = false;
      ctx.onstatechange = () => {
        if (ctx.state === 'suspended') this.resumeNeeded = true;
      };
      this.initPromise = this.finishInit(ctx).catch((err: unknown) => {
        // Roll back so a later gesture can retry the whole init.
        if (this.ctx === ctx) {
          this.initPromise = null;
          this.ctx = null;
          this.state = 'idle';
        }
        throw err;
      });
      return this.initPromise;
    }

    // ── Re-resume path: init already done, but the ctx has since been ──
    // ── suspended (tab switch, OS audio grab); this call is a new gesture. ──
    if (this.state === 'ready' && this.resumeNeeded && this.ctx !== null) {
      const ctx = this.ctx;
      this.resumeNeeded = false;
      this.initPromise = (async () => {
        if (ctx.state === 'suspended') await ctx.resume();
      })();
      return this.initPromise;
    }

    // 'initializing' → the same in-flight promise; 'ready' → the same settled one.
    return this.initPromise;
  }

  /** Async tail of {@link initializeFromUserGesture}; the ctx already exists. */
  private async finishInit(ctx: AudioContextLike): Promise<void> {
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule(this.url);
    if (this.ctx !== ctx || this.state === 'closed') {
      // close() (and possibly a re-init) ran while we were awaiting.
      return;
    }

    const node = this.makeNode(ctx, this.url);
    this.node = node;
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as WorkletOutbound;
      if (data.type === 'stats') this.workletStats = data;
    };
    node.port.start?.();
    node.connect(ctx.destination);

    // Port messages are ordered: the worklet must learn the source rate before
    // any held PCM reaches it.
    if (this.configured) {
      node.port.postMessage({ type: 'configure', sourceSampleRateHz: this.sourceSampleRateHz });
    }
    this.flushPending(node);
    this.state = 'ready';
  }

  configure(audio: AudioFormat): void {
    if (audio.format !== 'pcm_s16le') {
      throw new TypeError(
        `WorkletPCMPlayer: unsupported format ${JSON.stringify(audio.format)} (expected 'pcm_s16le')`,
      );
    }
    if (audio.channels !== CHANNELS) {
      throw new TypeError(
        `WorkletPCMPlayer: unsupported channel count ${JSON.stringify(audio.channels)} (expected ${CHANNELS})`,
      );
    }
    this.sourceSampleRateHz = audio.sampleRateHz;
    this.configured = true;

    const node = this.node;
    if (node !== null && this.state !== 'closed') {
      node.port.postMessage({ type: 'configure', sourceSampleRateHz: audio.sampleRateHz });
      // Chunks enqueued before this configure() can finally be released.
      this.flushPending(node);
    }
  }

  enqueuePcm(bytes: ArrayBuffer): void {
    if (this.state === 'closed') return;
    const node = this.node;
    if (!this.configured || node === null) {
      this.pending.push(bytes);
      const overflow = this.pending.length - PENDING_CHUNK_LIMIT;
      if (overflow > 0) this.pending.splice(0, overflow); // drop the OLDEST
      return;
    }
    // Transferred, not copied: `bytes` detaches on the sending side.
    node.port.postMessage({ type: 'pcm', bytes }, [bytes]);
  }

  getBufferedDurationMs(): number {
    return this.workletStats?.bufferedMs ?? 0;
  }

  /** Cached worklet stats merged with main-thread state and rates. */
  getStats(): PCMPlayerStats {
    const ws = this.workletStats;
    return {
      state: this.state,
      bufferedMs: ws?.bufferedMs ?? 0,
      underruns: ws?.underruns ?? 0,
      droppedFrames: ws?.droppedFrames ?? 0,
      // No stats yet means nothing has rendered: still effectively priming.
      priming: ws?.priming ?? true,
      outputSampleRateHz: this.ctx?.sampleRate ?? 0,
      sourceSampleRateHz: this.sourceSampleRateHz,
    };
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const node = this.node;
    const ctx = this.ctx;
    this.node = null;
    this.ctx = null;
    this.initPromise = null;
    this.pending = [];
    this.workletStats = null;
    this.resumeNeeded = false;

    if (node !== null) {
      try {
        node.port.postMessage({ type: 'reset' });
      } catch {
        // Best-effort: the node/context may already be gone.
      }
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        // Best-effort.
      }
    }
    if (ctx !== null) {
      ctx.onstatechange = null;
      try {
        if (ctx.state !== 'closed') await ctx.close();
      } catch {
        // Best-effort: an already-closed ctx rejects.
      }
    }
  }

  /** Drains the held queue into the worklet, preserving enqueue order. */
  private flushPending(node: WorkletNodeLike): void {
    const queued = this.pending;
    this.pending = [];
    for (const bytes of queued) {
      node.port.postMessage({ type: 'pcm', bytes }, [bytes]);
    }
  }
}

/** Default player factory for the app composition root (src/App.tsx). */
export function createPCMPlayer(opts: WorkletPCMPlayerOptions = {}): PCMPlayer {
  return new WorkletPCMPlayer(opts);
}
