import type { WeightedPrompt } from '../../src/shared/protocol.ts';
import type { MusicUpstream, UpstreamEvents, UpstreamFactory } from './types.ts';

export const MOCK_SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const AMPLITUDE = 0.2 * 32767;
const MAX_CATCHUP_CHUNKS = 5;

export type MockOptions = { chunkMs?: number; now?: () => number };

export function createMockFactory(opts: MockOptions = {}): UpstreamFactory {
  return (events) => new MockUpstream(events, opts.chunkMs ?? 100, opts.now ?? (() => performance.now()));
}

// Pitch in [220, 440) Hz derived from the prompt set, so steers are audible.
export function toneFrequency(prompts: WeightedPrompt[]): number {
  const key = prompts.map((p) => `${p.text}:${p.weight.toFixed(1)}`).sort().join('|');
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return 220 + ((h >>> 0) % 220);
}

class MockUpstream implements MusicUpstream {
  private timer: ReturnType<typeof setInterval> | undefined;
  private freq = 330;
  private phase = 0;
  private startedAt = 0;
  private framesSent = 0;
  private closed = false;
  private paused = false;

  constructor(
    private readonly events: UpstreamEvents,
    private readonly chunkMs: number,
    private readonly now: () => number,
  ) {}

  async start(prompts: WeightedPrompt[]): Promise<void> {
    if (this.closed) throw new Error('closed');
    this.freq = toneFrequency(prompts);
    this.startedAt = this.now();
    this.framesSent = 0;
    this.timer = setInterval(() => this.tick(), this.chunkMs);
    this.tick();
  }

  async steer(prompts: WeightedPrompt[]): Promise<void> {
    this.freq = toneFrequency(prompts);
  }

  pause(): void {
    if (this.closed || this.paused) return;
    this.paused = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  resume(): void {
    if (this.closed || !this.paused) return;
    this.paused = false;
    // Resume at the next frame without catching up the time spent paused.
    this.startedAt = this.now() - this.framesSent * 1000 / MOCK_SAMPLE_RATE;
    this.timer = setInterval(() => this.tick(), this.chunkMs);
    this.tick();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Emits whatever is due by wall clock, so interval jitter doesn't accumulate as drift.
  private tick(): void {
    if (this.closed || this.paused) return;
    const chunkFrames = Math.round((MOCK_SAMPLE_RATE * this.chunkMs) / 1000);
    const due = Math.floor(((this.now() - this.startedAt) * MOCK_SAMPLE_RATE) / 1000) + chunkFrames;
    let pending = Math.min(due - this.framesSent, chunkFrames * MAX_CATCHUP_CHUNKS);
    if (pending < chunkFrames) return;
    while (pending >= chunkFrames && !this.closed && !this.paused) {
      this.events.onAudio(this.render(chunkFrames), { sampleRateHz: MOCK_SAMPLE_RATE, channels: CHANNELS });
      this.framesSent += chunkFrames;
      pending -= chunkFrames;
    }
    // After a long stall, skip ahead rather than bursting the backlog.
    if (due - this.framesSent > chunkFrames * MAX_CATCHUP_CHUNKS) this.framesSent = due - chunkFrames;
  }

  private render(frames: number): Buffer {
    const buf = Buffer.alloc(frames * CHANNELS * 2);
    const step = (2 * Math.PI * this.freq) / MOCK_SAMPLE_RATE;
    for (let i = 0; i < frames; i++) {
      const s = Math.round(Math.sin(this.phase) * AMPLITUDE);
      buf.writeInt16LE(s, i * 4);
      buf.writeInt16LE(s, i * 4 + 2);
      this.phase += step;
    }
    this.phase %= 2 * Math.PI;
    return buf;
  }
}
