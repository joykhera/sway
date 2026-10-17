import { describe, expect, it } from 'vitest';
import { CHANNELS } from './constants.ts';
import { StreamingResampler } from './resample.ts';

function sine(frames: number, freqHz: number, rateHz: number): Float32Array {
  const a = new Float32Array(frames * CHANNELS);
  for (let i = 0; i < frames; i++) {
    const s = Math.sin((2 * Math.PI * freqHz * i) / rateHz);
    a[i * CHANNELS] = s;
    a[i * CHANNELS + 1] = s;
  }
  return a;
}

/** Push `input` in chunks of `chunkSizes` (last call takes the remainder). */
function pushChunked(
  r: StreamingResampler,
  input: Float32Array,
  chunkSizes: number[],
): Float32Array {
  const inFrames = Math.floor(input.length / CHANNELS);
  const pieces: Float32Array[] = [];
  let off = 0;
  let c = 0;
  while (off < inFrames) {
    const n = c < chunkSizes.length ? (chunkSizes[c] ?? inFrames) : inFrames;
    const slice = input.subarray(off * CHANNELS, (off + n) * CHANNELS);
    const scratch = new Float32Array(r.pendingOutputFrames(n) * CHANNELS);
    const produced = r.push(slice, scratch);
    pieces.push(scratch.subarray(0, produced * CHANNELS));
    off += n;
    c++;
  }
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const joined = new Float32Array(total);
  let o = 0;
  for (const p of pieces) {
    joined.set(p, o);
    o += p.length;
  }
  return joined;
}

describe('StreamingResampler', () => {
  it('passes 48k -> 48k through exactly', () => {
    const r = new StreamingResampler(48000, 48000);
    const input = sine(256, 440, 48000);
    const out = new Float32Array(input.length);
    expect(r.push(input, out)).toBe(256);
    expect(out).toEqual(input);
  });

  it('passthrough keeps the last frame (no 1-frame delay)', () => {
    const r = new StreamingResampler(48000, 48000);
    const a = sine(100, 440, 48000);
    const out = new Float32Array(200 * CHANNELS);
    expect(r.push(a, out)).toBe(100); // all frames, including the last one
    expect(out.subarray(0, a.length)).toEqual(a);
  });

  it('44100 -> 48000 produces ~480/441 times the frames', () => {
    const r = new StreamingResampler(44100, 48000);
    const input = sine(44100, 440, 44100);
    const out = new Float32Array(r.pendingOutputFrames(44100) * CHANNELS);
    const produced = r.push(input, out);
    // 44099 interpolatable positions / 0.91875 -> 47999 or 48000.
    expect(Math.abs(produced - 48000)).toBeLessThanOrEqual(4);
  });

  it('48000 -> 44100 downsamples by ~441/480', () => {
    const r = new StreamingResampler(48000, 44100);
    const input = sine(48000, 440, 48000);
    const out = new Float32Array(r.pendingOutputFrames(48000) * CHANNELS);
    const produced = r.push(input, out);
    expect(Math.abs(produced - 44100)).toBeLessThanOrEqual(4);
  });

  it('upsampled 440 Hz sine tracks the ideal sine within interp error', () => {
    const r = new StreamingResampler(44100, 48000);
    const input = sine(4410, 440, 44100); // 100 ms
    const out = new Float32Array(r.pendingOutputFrames(4410) * CHANNELS);
    const produced = r.push(input, out);
    // Theoretical linear-interp bound for a 440 Hz sine sampled at 44.1 kHz:
    //   |x''| * dt^2 / 8 = (2*pi*440)^2 * (1/44100)^2 / 8 ≈ 4.9e-4.
    // Allow generous headroom for edge segments; still far tighter than 0.02.
    let maxErr = 0;
    for (let j = 0; j < produced; j++) {
      const ideal = Math.sin((2 * Math.PI * 440 * j) / 48000);
      const got = out[j * CHANNELS] ?? 0;
      const err = Math.abs(got - ideal);
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr).toBeLessThan(0.01);
  });

  it('produces bit-identical output whether pushed whole or chunked', () => {
    const input = sine(4410, 440, 44100);
    const whole = new StreamingResampler(44100, 48000);
    const bigOut = new Float32Array(whole.pendingOutputFrames(4410) * CHANNELS);
    const nWhole = whole.push(input, bigOut);
    const expected = bigOut.subarray(0, nWhole * CHANNELS);

    const chunked = new StreamingResampler(44100, 48000);
    const joined = pushChunked(chunked, input, [1, 2, 7, 63, 128, 441, 1000, 3]);
    expect(joined.length).toBe(expected.length);
    expect(joined).toEqual(expected);
  });

  it('chunked == whole when downsampling too (phase carry across pushes)', () => {
    const input = sine(4800, 440, 48000);
    const whole = new StreamingResampler(48000, 44100);
    const bigOut = new Float32Array(whole.pendingOutputFrames(4800) * CHANNELS);
    const nWhole = whole.push(input, bigOut);
    const expected = bigOut.subarray(0, nWhole * CHANNELS);

    const chunked = new StreamingResampler(48000, 44100);
    const joined = pushChunked(chunked, input, [5, 17, 128, 1, 640]);
    expect(joined).toEqual(expected);
  });

  it('keeps stereo interleaved and channels independent', () => {
    const r = new StreamingResampler(44100, 48000);
    const frames = 441;
    const input = new Float32Array(frames * CHANNELS);
    for (let i = 0; i < frames; i++) {
      input[i * CHANNELS] = Math.sin((2 * Math.PI * 440 * i) / 44100); // L
      input[i * CHANNELS + 1] = 0.25 * Math.cos((2 * Math.PI * 220 * i) / 44100); // R
    }
    const out = new Float32Array(r.pendingOutputFrames(frames) * CHANNELS);
    const produced = r.push(input, out);
    let differ = 0;
    for (let j = 0; j < produced; j++) {
      const l = out[j * CHANNELS] ?? 0;
      const rr = out[j * CHANNELS + 1] ?? 0;
      if (l !== rr) differ++;
      const idealL = Math.sin((2 * Math.PI * 440 * j) / 48000);
      const idealR = 0.25 * Math.cos((2 * Math.PI * 220 * j) / 48000);
      expect(Math.abs(l - idealL)).toBeLessThan(0.01);
      expect(Math.abs(rr - idealR)).toBeLessThan(0.01);
    }
    expect(differ).toBeGreaterThan(0);
  });

  it('setSourceRate switches resampling behavior and resets phase', () => {
    const r = new StreamingResampler(48000, 48000); // passthrough at first
    const in441 = sine(441, 440, 44100);
    const scratch = new Float32Array(1024 * CHANNELS);
    expect(r.push(in441.subarray(0, 200 * CHANNELS), scratch)).toBe(200);
    r.setSourceRate(44100); // now upsampling
    const out = new Float32Array(r.pendingOutputFrames(441) * CHANNELS);
    const produced = r.push(in441, out);
    expect(produced).toBeGreaterThan(441); // ~480
    expect(produced).toBeLessThanOrEqual(485);
    r.setSourceRate(48000); // back to passthrough
    const again = new Float32Array(441 * CHANNELS);
    expect(r.push(in441, again)).toBe(441);
    expect(again).toEqual(in441);
  });

  it('setSourceRate rejects non-positive rates', () => {
    const r = new StreamingResampler(48000, 48000);
    expect(() => r.setSourceRate(0)).toThrow(RangeError);
    expect(() => r.setSourceRate(-44100)).toThrow(RangeError);
    expect(() => new StreamingResampler(0, 48000)).toThrow(RangeError);
  });

  it('pendingOutputFrames never underestimates actual output', () => {
    for (const [src, dst] of [
      [44100, 48000],
      [48000, 44100],
      [22050, 48000],
    ] as const) {
      const r = new StreamingResampler(src, dst);
      for (const n of [0, 1, 2, 3, 128, 999, 4096]) {
        const input = sine(n, 440, src);
        const bound = r.pendingOutputFrames(n);
        const out = new Float32Array(bound * CHANNELS);
        const produced = r.push(input, out);
        expect(produced).toBeLessThanOrEqual(bound);
      }
    }
  });
});
