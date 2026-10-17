import { GoogleGenAI } from '@google/genai';
import type { LiveMusicGenerationConfig, LiveMusicServerMessage, LiveMusicSession } from '@google/genai';
import type { StreamConfig, WeightedPrompt } from '../../src/shared/protocol.ts';
import { errorMessage, log, redact } from '../log.ts';
import type { MusicUpstream, UpstreamEvents, UpstreamFactory, UpstreamFormat } from './types.ts';

const MODEL = 'models/lyria-realtime-exp';
const SETUP_TIMEOUT_MS = 15_000;
const DEFAULT_FORMAT: UpstreamFormat = { sampleRateHz: 48_000, channels: 2 };

export function createLyriaFactory(apiKey: string): UpstreamFactory {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  return (events) => new LyriaUpstream(ai, events);
}

// e.g. "audio/l16;rate=48000;channels=2"; missing fields fall back to the documented 48 kHz stereo.
export function parseAudioFormat(mimeType: string | undefined): UpstreamFormat {
  const rate = Number(/rate=(\d+)/i.exec(mimeType ?? '')?.[1]);
  const channels = Number(/channels=(\d+)/i.exec(mimeType ?? '')?.[1]);
  return {
    sampleRateHz: Number.isInteger(rate) && rate > 0 ? rate : DEFAULT_FORMAT.sampleRateHz,
    channels: Number.isInteger(channels) && channels > 0 ? channels : DEFAULT_FORMAT.channels,
  };
}

function toSdkConfig(config: StreamConfig): LiveMusicGenerationConfig {
  const out: LiveMusicGenerationConfig = {};
  if (config.density !== undefined) out.density = config.density;
  if (config.brightness !== undefined) out.brightness = config.brightness;
  if (config.temperature !== undefined) out.temperature = config.temperature;
  return out;
}

class LyriaUpstream implements MusicUpstream {
  private session: LiveMusicSession | undefined;
  private config: LiveMusicGenerationConfig = {};
  private closed = false;
  private setupDone: (() => void) | undefined;
  private setupFailed: ((err: Error) => void) | undefined;

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly events: UpstreamEvents,
  ) {}

  async start(prompts: WeightedPrompt[], config: StreamConfig): Promise<void> {
    this.config = toSdkConfig(config);
    const setup = new Promise<void>((resolve, reject) => {
      this.setupDone = resolve;
      this.setupFailed = reject;
    });
    const timer = setTimeout(() => this.setupFailed?.(new Error('setup timed out')), SETUP_TIMEOUT_MS);
    // connect() resolves when the socket opens (and never settles if it fails to open), but the
    // server only accepts prompts/config/play after `setupComplete`, so wait for both.
    const connecting = this.ai.live.music
      .connect({
        model: MODEL,
        callbacks: {
          onmessage: (m) => this.onMessage(m),
          onerror: (e) => log.warn('lyria', 'socket error', { message: redact(String(e?.message ?? '')) }),
          onclose: (e) => this.onClose(e?.code, e?.reason),
        },
      })
      .then((s) => {
        this.session = s;
        if (this.closed) s.close();
      });
    try {
      await Promise.all([connecting, setup]);
    } finally {
      clearTimeout(timer);
    }
    const session = this.session;
    if (this.closed || !session) throw new Error('closed during setup');
    await session.setWeightedPrompts({ weightedPrompts: prompts });
    if (Object.keys(this.config).length > 0) {
      await session.setMusicGenerationConfig({ musicGenerationConfig: this.config });
    }
    session.play();
  }

  async steer(prompts: WeightedPrompt[], config?: StreamConfig): Promise<void> {
    const session = this.session;
    if (this.closed || !session) return;
    await session.setWeightedPrompts({ weightedPrompts: prompts });
    if (config) {
      // setMusicGenerationConfig replaces the whole config; unset fields reset to defaults.
      this.config = toSdkConfig(config);
      await session.setMusicGenerationConfig({ musicGenerationConfig: this.config });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.setupFailed?.(new Error('closed'));
    try {
      this.session?.close();
    } catch (err) {
      log.warn('lyria', 'close failed', { error: errorMessage(err) });
    }
  }

  private onMessage(m: LiveMusicServerMessage): void {
    if (this.closed) return;
    const { setupComplete, serverContent, filteredPrompt, ...rest } = m;
    if (setupComplete) this.setupDone?.();
    for (const chunk of serverContent?.audioChunks ?? []) {
      if (!chunk.data) continue;
      this.events.onAudio(Buffer.from(chunk.data, 'base64'), parseAudioFormat(chunk.mimeType));
    }
    if (filteredPrompt) {
      this.events.onFiltered({ text: filteredPrompt.text, reason: filteredPrompt.filteredReason });
    }
    if (Object.keys(rest).length > 0) {
      this.events.onWarning(JSON.stringify(rest).slice(0, 500));
    }
  }

  private onClose(code: number | undefined, reason: string | undefined): void {
    const detail = `code=${code ?? '?'} reason=${redact(reason ?? '').slice(0, 200)}`;
    if (this.closed) return;
    this.closed = true;
    this.setupFailed?.(new Error(`closed before setup (${detail})`));
    this.events.onClosed(detail);
  }
}
