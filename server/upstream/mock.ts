// No-network MusicUpstream: a quiet stereo sine pad paced at ~1x realtime.
// For Vitest and keyless devs only (MUSIC_MODE=mock).

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

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2; // s16le stereo
const CHUNK_MS = 200; // emit a 200 ms chunk every 200 ms → 1x realtime
const AMPLITUDE = 0.1; // ~ -20 dBFS
const BASE_FREQ_HZ = 220;
const STEER_SHIFT = 1.05; // +5% base frequency per steer — audibly different
const FRAMES_PER_CHUNK = Math.floor((SAMPLE_RATE * CHUNK_MS) / 1000); // 9600

export class MockUpstream implements MusicUpstream {
  private cb: UpstreamCallbacks | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private sampleCursor = 0;
  private steerCount = 0;

  /** Latest inputs + current base frequency — test/debug introspection. */
  latestPrompts: WeightedPrompt[] = [];
  latestConfig: StreamConfig | undefined;
  currentFreq = BASE_FREQ_HZ;

  async start(
    args: UpstreamStartArgs,
    cb: UpstreamCallbacks,
  ): Promise<{ audio: AudioFormat }> {
    if (this.closed) throw new Error('MockUpstream is closed');
    this.cb = cb;
    this.latestPrompts = args.prompts;
    this.latestConfig = args.config;
    // Short async tick so `start` behaves like a real async connect.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    if (this.closed) throw new Error('MockUpstream closed during start');
    this.timer = setInterval(() => this.emitChunk(), CHUNK_MS);
    this.timer.unref?.();
    return {
      audio: { format: 'pcm_s16le', sampleRateHz: SAMPLE_RATE, channels: CHANNELS },
    };
  }

  steer(prompts: WeightedPrompt[], config?: StreamConfig): void {
    if (this.closed) return;
    this.latestPrompts = prompts;
    if (config) this.latestConfig = config;
    this.steerCount += 1;
    this.currentFreq = BASE_FREQ_HZ * Math.pow(STEER_SHIFT, this.steerCount);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cb = null;
  }

  private emitChunk(): void {
    const cb = this.cb;
    if (this.closed || !cb) return;
    const buf = Buffer.alloc(FRAMES_PER_CHUNK * BYTES_PER_FRAME);
    const f = this.currentFreq;
    let offset = 0;
    for (let i = 0; i < FRAMES_PER_CHUNK; i++) {
      const t = (this.sampleCursor + i) / SAMPLE_RATE;
      // Root + fifth + soft octave-ish overtone: a pad, not a beep.
      const v =
        AMPLITUDE *
        (0.55 * Math.sin(2 * Math.PI * f * t) +
          0.3 * Math.sin(2 * Math.PI * f * 1.5 * t) +
          0.15 * Math.sin(2 * Math.PI * f * 2.02 * t));
      const s16 = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
      buf.writeInt16LE(s16, offset);
      buf.writeInt16LE(s16, offset + 2);
      offset += BYTES_PER_FRAME;
    }
    this.sampleCursor += FRAMES_PER_CHUNK;
    cb.onAudio(buf);
  }
}
