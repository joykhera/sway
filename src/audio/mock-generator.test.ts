// MockPcmGenerator tests — pure node, no audio hardware. The contract under
// test: deterministic seeded output, sane s16le signal, spec'd chunk sizes.

import { describe, expect, it } from 'vitest';
import { MockPcmGenerator, type MockPreset } from './mock-generator.ts';
import { BYTES_PER_FRAME, BYTES_PER_SAMPLE, DEFAULT_SAMPLE_RATE_HZ } from './constants.ts';

function chunks(gen: MockPcmGenerator, n: number): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < n; i++) out.push(gen.nextChunk());
  return out;
}

function toBytes(buf: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buf));
}

function rms(buf: ArrayBuffer): number {
  const i16 = new Int16Array(buf);
  let acc = 0;
  for (const v of i16) acc += v * v;
  return Math.sqrt(acc / i16.length);
}

function peak(buf: ArrayBuffer): number {
  const i16 = new Int16Array(buf);
  let p = 0;
  for (const v of i16) p = Math.max(p, Math.abs(v));
  return p;
}

describe('MockPcmGenerator', () => {
  it('produces byte-identical output for the same seed + preset', () => {
    const a = new MockPcmGenerator({ seed: 42, preset: 'dusk' });
    const b = new MockPcmGenerator({ seed: 42, preset: 'dusk' });
    const ca = chunks(a, 6).map(toBytes);
    const cb = chunks(b, 6).map(toBytes);
    expect(ca).toEqual(cb);
  });

  it('produces different output for different seeds', () => {
    const a = new MockPcmGenerator({ seed: 1, preset: 'ember' });
    const b = new MockPcmGenerator({ seed: 2, preset: 'ember' });
    expect(toBytes(a.nextChunk())).not.toEqual(toBytes(b.nextChunk()));
  });

  it('emits 10–60 ms chunks, 4-byte-aligned by default', () => {
    const gen = new MockPcmGenerator({ seed: 7 });
    for (let i = 0; i < 40; i++) {
      const buf = gen.nextChunk();
      expect(buf.byteLength % BYTES_PER_FRAME).toBe(0);
      const ms = (buf.byteLength / BYTES_PER_FRAME / DEFAULT_SAMPLE_RATE_HZ) * 1000;
      expect(ms).toBeGreaterThanOrEqual(10 - 0.05); // rounding tolerance
      expect(ms).toBeLessThanOrEqual(60 + 0.05);
    }
  });

  it('honors maxMs as a duration cap', () => {
    const gen = new MockPcmGenerator({ seed: 9 });
    for (let i = 0; i < 20; i++) {
      const buf = gen.nextChunk(25);
      const ms = (buf.byteLength / BYTES_PER_FRAME / DEFAULT_SAMPLE_RATE_HZ) * 1000;
      expect(ms).toBeLessThanOrEqual(25 + 0.05);
    }
  });

  it('splitOdd: every 7th chunk ends mid-frame (len % 4 !== 0, % 2 === 0)', () => {
    const gen = new MockPcmGenerator({ seed: 3, splitOdd: true });
    const lengths: number[] = [];
    for (let i = 0; i < 14; i++) lengths.push(gen.nextChunk().byteLength);
    for (let i = 0; i < lengths.length; i++) {
      const len = lengths[i]!;
      expect(len % BYTES_PER_SAMPLE).toBe(0); // whole int16 samples always
      if ((i + 1) % 7 === 0) {
        expect(len % BYTES_PER_FRAME).not.toBe(0);
      } else {
        expect(len % BYTES_PER_FRAME).toBe(0);
      }
    }
  });

  it('without splitOdd, no chunk is ever mid-frame', () => {
    const gen = new MockPcmGenerator({ seed: 3 });
    for (let i = 0; i < 14; i++) {
      expect(gen.nextChunk().byteLength % BYTES_PER_FRAME).toBe(0);
    }
  });

  it('decodes to in-range int16 with non-zero signal near −18 dBFS peak', () => {
    const gen = new MockPcmGenerator({ seed: 5, preset: 'dusk' });
    let globalPeak = 0;
    for (let i = 0; i < 30; i++) {
      const buf = gen.nextChunk();
      const i16 = new Int16Array(buf);
      for (const v of i16) {
        expect(v).toBeGreaterThanOrEqual(-32768);
        expect(v).toBeLessThanOrEqual(32767);
      }
      expect(rms(buf)).toBeGreaterThan(0);
      globalPeak = Math.max(globalPeak, peak(buf));
    }
    // ≈ −18 dBFS ≈ 0.126 FS ≈ 4120 int16; assert the neighborhood, not the point.
    expect(globalPeak).toBeGreaterThan(1500);
    expect(globalPeak).toBeLessThan(12000);
  });

  it('cyclePreset() walks all four presets in fixed order and wraps', () => {
    const gen = new MockPcmGenerator({ seed: 1, preset: 'dusk' });
    const seen: MockPreset[] = [gen.preset];
    for (let i = 0; i < 4; i++) seen.push(gen.cyclePreset());
    expect(seen).toEqual(['dusk', 'glass', 'ember', 'tide', 'dusk']);
  });

  it('nudge() changes the bytes but keeps the preset', () => {
    const a = new MockPcmGenerator({ seed: 11, preset: 'glass' });
    const b = new MockPcmGenerator({ seed: 11, preset: 'glass' });
    a.nudge();
    expect(a.preset).toBe('glass');
    // Same seed, but a nudged: the streams diverge.
    const ba = toBytes(a.nextChunk());
    const bb = toBytes(b.nextChunk());
    expect(ba).not.toEqual(bb);
  });

  it('setPreset() changes the output (new style, deterministic)', () => {
    const a = new MockPcmGenerator({ seed: 4, preset: 'dusk' });
    const b = new MockPcmGenerator({ seed: 4, preset: 'dusk' });
    b.setPreset('tide');
    expect(b.preset).toBe('tide');
    const bChunk = toBytes(b.nextChunk());
    expect(toBytes(a.nextChunk())).not.toEqual(bChunk);

    // Same seed + same setPreset call → identical bytes.
    const c = new MockPcmGenerator({ seed: 4, preset: 'dusk' });
    c.setPreset('tide');
    expect(toBytes(c.nextChunk())).toEqual(bChunk);
  });

  it('setSeed() rewinds: the same sequence replays byte-identically', () => {
    const gen = new MockPcmGenerator({ seed: 77, preset: 'ember' });
    const first = chunks(gen, 4).map(toBytes);
    gen.nudge();
    gen.cyclePreset();
    gen.setSeed(77);
    const second = chunks(gen, 4).map(toBytes);
    expect(second).toEqual(first);
    expect(gen.preset).toBe('ember'); // back to the constructor preset
  });
});
