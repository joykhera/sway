import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockFactory, MOCK_SAMPLE_RATE, toneFrequency } from './mock.ts';

describe('mock upstream', () => {
  afterEach(() => vi.useRealTimers());

  it('emits stereo s16le frames paced at ~1x realtime', async () => {
    vi.useFakeTimers();
    const chunks: Buffer[] = [];
    const up = createMockFactory({ now: () => Date.now() })({
      onAudio: (b, f) => {
        expect(f).toEqual({ sampleRateHz: MOCK_SAMPLE_RATE, channels: 2 });
        chunks.push(b);
      },
      onFiltered: () => {},
      onWarning: () => {},
      onClosed: () => {},
    });
    await up.start([{ text: 'lofi', weight: 1 }], {});
    await vi.advanceTimersByTimeAsync(2000);
    up.close();
    const bytes = chunks.reduce((n, c) => n + c.length, 0);
    expect(chunks.every((c) => c.length % 4 === 0)).toBe(true);
    const seconds = bytes / 4 / MOCK_SAMPLE_RATE;
    expect(seconds).toBeGreaterThanOrEqual(1.9);
    expect(seconds).toBeLessThanOrEqual(2.2);
    const before = chunks.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(chunks.length).toBe(before);
  });

  it('catches up after timer stalls without drifting', async () => {
    let now = 0;
    vi.useFakeTimers();
    const chunks: Buffer[] = [];
    const up = createMockFactory({ now: () => now })({
      onAudio: (b) => chunks.push(b),
      onFiltered: () => {},
      onWarning: () => {},
      onClosed: () => {},
    });
    await up.start([{ text: 'a', weight: 1 }], {});
    for (let i = 0; i < 30; i++) {
      now += 100 + (i % 3 === 0 ? 37 : 0); // late ticks
      await vi.advanceTimersByTimeAsync(100);
    }
    up.close();
    const seconds = chunks.reduce((n, c) => n + c.length, 0) / 4 / MOCK_SAMPLE_RATE;
    expect(Math.abs(seconds - (now / 1000 + 0.1))).toBeLessThanOrEqual(0.1);
  });

  it('derives pitch from prompts', () => {
    const a = toneFrequency([{ text: 'lofi', weight: 1 }]);
    const b = toneFrequency([{ text: 'jazz', weight: 1 }]);
    expect(a).not.toBe(b);
    for (const f of [a, b]) expect(f >= 220 && f < 440).toBe(true);
  });

  it('preserves sample continuity through pause/resume without catching up paused wall time', async () => {
    vi.useFakeTimers();
    const reference: Buffer[] = [];
    const resumed: Buffer[] = [];
    const create = (output: Buffer[]) => createMockFactory({ now: () => Date.now() })({
      onAudio: chunk => output.push(chunk), onFiltered: () => {}, onWarning: () => {}, onClosed: () => {},
    });
    const a = create(reference);
    const b = create(resumed);
    await a.start([{ text: 'a', weight: 1 }], {});
    await b.start([{ text: 'a', weight: 1 }], {});
    await vi.advanceTimersByTimeAsync(200);
    b.pause!();
    b.pause!();
    const prefixLength = resumed.length;
    await vi.advanceTimersByTimeAsync(200);
    a.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resumed).toHaveLength(prefixLength);
    b.resume!();
    b.resume!();
    expect(resumed).toHaveLength(prefixLength + 1);
    await vi.advanceTimersByTimeAsync(100);
    b.close();
    b.resume!();
    expect(resumed).toHaveLength(prefixLength + 2);
    expect(Buffer.concat(resumed)).toEqual(Buffer.concat(reference));
    expect(vi.getTimerCount()).toBe(0);
  });
});
