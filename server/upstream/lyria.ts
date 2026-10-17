// Adapter from MusicUpstream to @google/genai's Lyria RealTime live-music API.
//
// SDK shape (verified against @google/genai@2.30.0 dist/node/index.mjs):
//   const ai = new GoogleGenAI({ apiKey });
//   const session = await ai.live.music.connect({ model, callbacks });
//   // resolves when the socket OPENS (R4) — the SDK then sends {setup:{model}}
//   // itself; the server's setupComplete arrives later via onmessage.
//   await session.setWeightedPrompts({ weightedPrompts });
//   await session.setMusicGenerationConfig({ musicGenerationConfig });
//   session.play();  // sends {playbackControl:'PLAY'}
//   session.close();
//
// LiveMusicServerMessage = {
//   setupComplete?: {},
//   serverContent?: { audioChunks?: [{ data?: base64, mimeType?: string }] },
//   filteredPrompt?: { text?: string, filteredReason?: string },
// }
//
// R8: the SDK builds the upstream URL as `...BidiGenerateMusic?key=${apiKey}`.
// We never log URLs or raw ErrorEvent/CloseEvent objects — only extracted
// safe fields pass through the redacting logger.

import { GoogleGenAI } from '@google/genai';
import type {
  LiveMusicCallbacks,
  LiveMusicGenerationConfig,
  LiveMusicServerMessage,
} from '@google/genai';
import { errMessage, log } from '../log.ts';
import type {
  AudioFormat,
  StreamConfig,
  WeightedPrompt,
} from '../../src/shared/protocol.ts';
import type {
  MusicUpstream,
  UpstreamCallbacks,
  UpstreamStartArgs,
} from './types.ts';

export const LYRIA_MODEL = 'models/lyria-realtime-exp';

// R2: official output is 48 kHz stereo s16le. We refine it from
// AudioChunk.mimeType when present.
const DEFAULT_AUDIO: AudioFormat = {
  format: 'pcm_s16le',
  sampleRateHz: 48000,
  channels: 2,
};

// connect() resolves on socket open; if the socket never opens the SDK never
// settles it, and after open the server may still stall before setupComplete.
// One timeout covers both gaps.
const SETUP_TIMEOUT_MS = 15_000;

/**
 * Minimal structural view of LiveMusicSession — lets tests inject a fake
 * without a real socket. LiveMusicSession satisfies this shape (its methods
 * are bivariant under strictFunctionTypes).
 */
export interface LyriaSessionLike {
  setWeightedPrompts(params: { weightedPrompts: WeightedPrompt[] }): Promise<void>;
  setMusicGenerationConfig(params: {
    musicGenerationConfig: LiveMusicGenerationConfig;
  }): Promise<void>;
  play(): void;
  close(): void;
}

/** Test seam: replace connect to drive callbacks without network. */
export type LyriaConnect = (
  callbacks: LiveMusicCallbacks,
) => Promise<LyriaSessionLike>;

export type LyriaUpstreamOptions = {
  apiKey: string;
  model?: string;
  connect?: LyriaConnect;
};

export class LyriaUpstream implements MusicUpstream {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly connectFn: LyriaConnect | null;

  private session: LyriaSessionLike | null = null;
  private cb: UpstreamCallbacks | null = null;
  private audioFormat: AudioFormat = DEFAULT_AUDIO;

  private started = false;
  private closed = false;
  private setupDone = false;
  private played = false;

  /** Newest pending prompt set — latest-wins coalescing (R11 ~200 ms cadence). */
  private pendingSteer: { prompts: WeightedPrompt[]; config?: StreamConfig } | null = null;
  private sending = false;

  private setupTimer: NodeJS.Timeout | null = null;
  private finishStart: ((v: { audio: AudioFormat }) => void) | null = null;
  private failStart: ((e: Error) => void) | null = null;

  constructor(options: LyriaUpstreamOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? LYRIA_MODEL;
    this.connectFn = options.connect ?? null;
  }

  start(args: UpstreamStartArgs, cb: UpstreamCallbacks): Promise<{ audio: AudioFormat }> {
    if (this.started) return Promise.reject(new Error('start() called twice'));
    if (this.closed) return Promise.reject(new Error('upstream is closed'));
    this.started = true;
    this.cb = cb;
    // Seed the prompt queue: flushed to the socket once setupComplete lands.
    this.pendingSteer = { prompts: args.prompts, config: args.config };

    const connect =
      this.connectFn ?? ((callbacks: LiveMusicCallbacks) => this.connectSdk(callbacks));
    const callbacks: LiveMusicCallbacks = {
      onmessage: (e) => this.handleMessage(e),
      onerror: (e) => this.handleError(e),
      onclose: (e) => this.handleClose(e),
    };
    const sessionPromise = Promise.resolve().then(() => connect(callbacks));

    return new Promise<{ audio: AudioFormat }>((resolve, reject) => {
      this.finishStart = resolve;
      this.failStart = reject;
      this.setupTimer = setTimeout(() => {
        this.abortStart(new Error('timed out waiting for Lyria setupComplete'));
      }, SETUP_TIMEOUT_MS);
      this.setupTimer.unref?.();

      sessionPromise.then(
        (session) => {
          this.session = session;
          void this.flushSteer();
        },
        (err) => this.abortStart(err instanceof Error ? err : new Error(errMessage(err))),
      );
    });
  }

  steer(prompts: WeightedPrompt[], config?: StreamConfig): void {
    if (this.closed || !this.started) return;
    // Latest-wins: overwrite whatever is queued (incl. the pre-setup seed).
    this.pendingSteer = { prompts, config };
    void this.flushSteer();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearSetupTimer();
    this.pendingSteer = null;
    // A pending start must not hang the session's connect path.
    const fail = this.failStart;
    this.failStart = null;
    this.finishStart = null;
    fail?.(new Error('upstream closed before setupComplete'));
    const session = this.session;
    this.session = null;
    try {
      session?.close();
    } catch {
      // 'WebSocket is not connected' etc. — already closed is success.
    }
  }

  // ---- internals ---------------------------------------------------------

  private async connectSdk(callbacks: LiveMusicCallbacks): Promise<LyriaSessionLike> {
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    // Never log the URL this builds — it carries ?key=<GEMINI_API_KEY> (R8).
    return await ai.live.music.connect({ model: this.model, callbacks });
  }

  private handleMessage(msg: LiveMusicServerMessage): void {
    if (this.closed) return;
    if (msg.setupComplete) {
      this.setupDone = true;
      this.clearSetupTimer();
      const finish = this.finishStart;
      this.finishStart = null;
      this.failStart = null;
      finish?.({ audio: this.audioFormat });
      void this.flushSteer();
      return;
    }
    const chunks = msg.serverContent?.audioChunks;
    if (chunks) {
      for (const chunk of chunks) {
        this.noteMimeType(chunk.mimeType);
        if (chunk.data) {
          this.cb?.onAudio(Buffer.from(chunk.data, 'base64'));
        }
      }
    }
    const filtered = msg.filteredPrompt;
    if (filtered) {
      const text = filtered.text ?? '';
      log.warn('lyria filtered prompt', {
        text,
        reason: filtered.filteredReason ?? '',
      });
      this.cb?.onFiltered?.([text]);
    }
  }

  private handleError(e: unknown): void {
    if (this.closed) return;
    // Extract a safe field only — the raw event may embed the keyed URL (R8).
    const detail =
      typeof (e as { message?: unknown })?.message === 'string'
        ? (e as { message: string }).message
        : 'socket error';
    this.terminate(`upstream ${detail}`);
  }

  private handleClose(e: unknown): void {
    if (this.closed) return;
    const evt = e as { code?: unknown; reason?: unknown };
    const code = typeof evt?.code === 'number' ? evt.code : undefined;
    const reason = typeof evt?.reason === 'string' ? evt.reason : undefined;
    this.terminate(
      `upstream socket closed (code ${code ?? 'unknown'}${reason ? `, reason ${reason}` : ''})`,
    );
  }

  /** Terminal event: reject a pending start, else notify onClosed once. */
  private terminate(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearSetupTimer();
    this.pendingSteer = null;
    // Tear down whatever socket remains (setup-timeout aborts leave it open).
    const session = this.session;
    this.session = null;
    try {
      session?.close();
    } catch {
      // already closed
    }
    if (this.failStart) {
      const fail = this.failStart;
      this.failStart = null;
      this.finishStart = null;
      fail(new Error(reason));
      return;
    }
    this.cb?.onClosed(reason);
  }

  private abortStart(err: Error): void {
    this.terminate(err.message);
  }

  /**
   * Newest-wins coalescing: at most one steer in flight; anything queued while
   * sending (or before setupComplete) collapses to the newest set.
   */
  private async flushSteer(): Promise<void> {
    if (this.sending || this.closed || !this.setupDone || !this.session) return;
    const job = this.pendingSteer;
    if (!job) return;
    this.pendingSteer = null;
    this.sending = true;
    try {
      await this.session.setWeightedPrompts({ weightedPrompts: job.prompts });
      if (job.config) {
        await this.session.setMusicGenerationConfig({
          musicGenerationConfig: toGenerationConfig(job.config),
        });
      }
      if (!this.played) {
        this.session.play();
        this.played = true;
      }
    } catch (err) {
      this.cb?.onWarning?.(`steer send failed: ${errMessage(err)}`);
    } finally {
      this.sending = false;
    }
    if (this.pendingSteer) void this.flushSteer();
  }

  /** R2: parse `rate=` out of e.g. `audio/pcm;rate=48000` when present. */
  private noteMimeType(mimeType: string | undefined): void {
    if (!mimeType) return;
    const rate = /rate=(\d+)/i.exec(mimeType)?.[1];
    if (!rate) return;
    const sampleRateHz = Number(rate);
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return;
    if (sampleRateHz !== this.audioFormat.sampleRateHz) {
      log.warn('lyria audio rate differs from reported format', {
        expected: this.audioFormat.sampleRateHz,
        actual: sampleRateHz,
        mimeType,
      });
      this.cb?.onWarning?.(`audio mimeType ${mimeType} reports ${sampleRateHz} Hz`);
      this.audioFormat = { ...this.audioFormat, sampleRateHz };
    }
  }

  private clearSetupTimer(): void {
    if (this.setupTimer) {
      clearTimeout(this.setupTimer);
      this.setupTimer = null;
    }
  }
}

function toGenerationConfig(config: StreamConfig): LiveMusicGenerationConfig {
  const out: LiveMusicGenerationConfig = {};
  if (config.density !== undefined) out.density = config.density;
  if (config.brightness !== undefined) out.brightness = config.brightness;
  if (config.temperature !== undefined) out.temperature = config.temperature;
  return out;
}
