import { describe, expect, it } from 'vitest';
import { MockUpstream } from './mock.ts';
import type { UpstreamCallbacks } from './types.ts';

const PROMPTS = [{ text: 'test pad', weight: 1 }];

function collect(cb: Partial<UpstreamCallbacks> = {}) {
  const chunks: { buf: Buffer; at: number }[] = [];
  const callbacks: UpstreamCallbacks = {
    onAudio: cb.onAudio ?? ((buf) => chunks.push({ buf, at: Date.now() })),
    onFiltered: cb.onFiltered,
    onWarning: cb.onWarning,
    onClosed: cb.onClosed ?? (() => { }),
  };
  return { chunks, callbacks };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MockUpstream', () => {
  it('resolves start with 48kHz stereo s16le format', async () => {
    const up = new MockUpstream();
    const { chunks, callbacks } = collect();
    const { audio } = await up.start({ prompts: PROMPTS }, callbacks);
    expect(audio).toEqual({
      format: 'pcm_s16le',
      sampleRateHz: 48000,
      channels: 2,
    });
    await up.close();
    expect(chunks.length).toBe(0);
  });

  it('emits %4-aligned chunks paced at ~1x realtime', async () => {
    const up = new MockUpstream();
    const { chunks, callbacks } = collect();
    await up.start({ prompts: PROMPTS }, callbacks);
    await sleep(650);
    await up.close();

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(5); // ~3 expected at 200 ms
    const audioMs = chunks.reduce((s, c) => s + (c.buf.length / 4 / 48000) * 1000, 0);
    const wallMs = chunks[chunks.length - 1]!.at - chunks[0]!.at + 200;
    // burst ratio ≈ 1x realtime, within generous slack for timers
    expect(audioMs / wallMs).toBeGreaterThan(0.5);
    expect(audioMs / wallMs).toBeLessThan(2);
    for (const c of chunks) {
      expect(c.buf.length % 4).toBe(0);
      expect(c.buf.length).toBe(9600 * 4); // 200 ms @48k stereo s16le
    }
  });

  it('produces quiet s16le audio (~-20 dBFS, decodable)', async () => {
    const up = new MockUpstream();
    const { chunks, callbacks } = collect();
    await up.start({ prompts: PROMPTS }, callbacks);
    await sleep(250);
    await up.close();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const buf = chunks[0]!.buf;
    let peak = 0;
    for (let i = 0; i < buf.length; i += 2) {
      peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(500); // non-silent
    expect(peak).toBeLessThan(32767 * 0.2); // comfortably under full scale
  });

  it('steer records prompts and shifts the base frequency audibly', async () => {
    const up = new MockUpstream();
    const { callbacks } = collect();
    await up.start({ prompts: PROMPTS }, callbacks);
    const f0 = up.currentFreq;
    up.steer([{ text: 'brighter', weight: 1.5 }]);
    expect(up.latestPrompts[0]?.text).toBe('brighter');
    expect(up.currentFreq).toBeGreaterThan(f0 * 1.03); // a few % up
    await up.close();
  });

  it('close() is idempotent and stops all chunks', async () => {
    const up = new MockUpstream();
    const { chunks, callbacks } = collect();
    await up.start({ prompts: PROMPTS }, callbacks);
    await up.close();
    await up.close();
    const n = chunks.length;
    await sleep(300);
    expect(chunks.length).toBe(n);
  });
});
