import { describe, expect, it } from 'vitest';
import { BYTES_PER_FRAME } from './constants.ts';
import { decodeS16le, framesFromBytes, PcmByteAssembler } from './decode.ts';

function encodeS16le(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i] ?? 0, true);
  }
  return bytes;
}

function decodeAll(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(framesFromBytes(bytes.byteLength) * 2);
  decodeS16le(bytes, out);
  return out;
}

describe('framesFromBytes', () => {
  it('counts only whole stereo frames', () => {
    expect(framesFromBytes(0)).toBe(0);
    expect(framesFromBytes(1)).toBe(0);
    expect(framesFromBytes(3)).toBe(0);
    expect(framesFromBytes(4)).toBe(1);
    expect(framesFromBytes(7)).toBe(1);
    expect(framesFromBytes(8)).toBe(2);
    expect(framesFromBytes(1023)).toBe(255);
    expect(framesFromBytes(1024)).toBe(256);
  });
});

describe('decodeS16le', () => {
  it('maps full-scale values exactly (s/32768)', () => {
    const bytes = encodeS16le([32767, -32768, -32767, 32760]);
    const out = new Float32Array(4);
    expect(decodeS16le(bytes, out)).toBe(2);
    expect(out[0]).toBeCloseTo(32767 / 32768, 7);
    expect(out[1]).toBe(-1);
    expect(out[2]).toBeCloseTo(-32767 / 32768, 7);
    expect(out[3]).toBeCloseTo(32760 / 32768, 7);
  });

  it('decodes negative and zero mid-range values', () => {
    const bytes = encodeS16le([-16384, 16384, 0, -1]);
    const out = new Float32Array(4);
    decodeS16le(bytes, out);
    expect(out[0]).toBeCloseTo(-0.5, 7);
    expect(out[1]).toBeCloseTo(0.5, 7);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(-1 / 32768, 7);
  });

  it('respects byteOffset of a view into a larger buffer', () => {
    const payload = encodeS16le([1000, -1000, 2000, -2000]);
    const padded = new Uint8Array(payload.byteLength + 9);
    padded.set(payload, 5); // odd, non-zero offset on purpose
    const view = padded.subarray(5, 5 + payload.byteLength);
    const out = new Float32Array(4);
    expect(decodeS16le(view, out)).toBe(2);
    expect(out[0]).toBeCloseTo(1000 / 32768, 7);
    expect(out[1]).toBeCloseTo(-1000 / 32768, 7);
    expect(out[2]).toBeCloseTo(2000 / 32768, 7);
    expect(out[3]).toBeCloseTo(-2000 / 32768, 7);
  });

  it('ignores trailing bytes that do not complete a frame', () => {
    const full = encodeS16le([111, -111, 222, -222]);
    const withTail = new Uint8Array(full.byteLength + 2); // half a frame
    withTail.set(full);
    withTail[full.byteLength] = 0x12;
    withTail[full.byteLength + 1] = 0x34;
    const out = new Float32Array(6);
    expect(decodeS16le(withTail, out)).toBe(2);
    expect(out[4]).toBe(0);
    expect(out[5]).toBe(0);
  });

  it('stops at out capacity and reports frames written', () => {
    const bytes = encodeS16le([1, 2, 3, 4, 5, 6]); // 3 frames
    const out = new Float32Array(4); // room for 2 frames
    expect(decodeS16le(bytes, out)).toBe(2);
    expect(out[0]).toBeCloseTo(1 / 32768, 7);
    expect(out[3]).toBeCloseTo(4 / 32768, 7);
  });

  it('returns 0 for empty input', () => {
    expect(decodeS16le(new Uint8Array(0), new Float32Array(8))).toBe(0);
  });
});

describe('PcmByteAssembler', () => {
  // 64 frames of deterministic pseudo-random samples.
  const frameCount = 64;
  const samples: number[] = [];
  for (let i = 0; i < frameCount * 2; i++) {
    samples.push(((i * 2654435761 + 12345) % 65536) - 32768);
  }
  const whole = encodeS16le(samples);
  const expected = decodeAll(whole);

  it.each([1, 2, 3])(
    'split at %d-byte offset produces identical output to single-shot',
    (split) => {
      const asm = new PcmByteAssembler();
      const a = asm.push(whole.subarray(0, split));
      expect(asm.carriedBytes).toBe(split);
      const b = asm.push(whole.subarray(split));
      expect(asm.carriedBytes).toBe(0);
      expect(a.byteLength % BYTES_PER_FRAME).toBe(0);
      expect(b.byteLength % BYTES_PER_FRAME).toBe(0);
      const joined = new Uint8Array(a.byteLength + b.byteLength);
      joined.set(a, 0);
      joined.set(b, a.byteLength);
      expect(decodeAll(joined)).toEqual(expected);
    },
  );

  it('reassembles across many irregular chunk sizes', () => {
    const asm = new PcmByteAssembler();
    const sizes = [1, 5, 2, 7, 3, 61, 4, 13, 2];
    const parts: Uint8Array[] = [];
    let off = 0;
    for (const size of sizes) {
      parts.push(asm.push(whole.subarray(off, off + size)));
      off += size;
    }
    parts.push(asm.push(whole.subarray(off)));
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.byteLength;
    }
    expect(joined.byteLength).toBe(whole.byteLength);
    expect(decodeAll(joined)).toEqual(expected);
    expect(asm.carriedBytes).toBe(0);
  });

  it('carries sub-frame remainders until alignment completes', () => {
    const asm = new PcmByteAssembler();
    expect(asm.push(new Uint8Array(2)).byteLength).toBe(0);
    expect(asm.carriedBytes).toBe(2);
    expect(asm.push(new Uint8Array(1)).byteLength).toBe(0);
    expect(asm.carriedBytes).toBe(3);
    const out = asm.push(new Uint8Array(1));
    expect(out.byteLength).toBe(4);
    expect(asm.carriedBytes).toBe(0);
  });

  it('completes a carried partial frame with the next push', () => {
    const frame0 = encodeS16le([1000, -1000]); // [E8,03,18,FC]
    const asm = new PcmByteAssembler();
    expect(asm.push(frame0.subarray(0, 3)).byteLength).toBe(0);
    expect(asm.carriedBytes).toBe(3);
    // Next push: last byte of frame 0 + one whole frame = 5 bytes -> total 8.
    const next = new Uint8Array(5);
    next.set(frame0.subarray(3), 0);
    next.set(encodeS16le([2000, -2000]), 1);
    const out = asm.push(next);
    expect(out.byteLength).toBe(8);
    expect(asm.carriedBytes).toBe(0);
    const floats = decodeAll(out);
    expect(floats[0]).toBeCloseTo(1000 / 32768, 7);
    expect(floats[1]).toBeCloseTo(-1000 / 32768, 7);
    expect(floats[2]).toBeCloseTo(2000 / 32768, 7);
    expect(floats[3]).toBeCloseTo(-2000 / 32768, 7);
  });

  it('reset() drops the carry', () => {
    const asm = new PcmByteAssembler();
    asm.push(new Uint8Array(3));
    expect(asm.carriedBytes).toBe(3);
    asm.reset();
    expect(asm.carriedBytes).toBe(0);
    expect(asm.push(new Uint8Array(3)).byteLength).toBe(0);
  });
});
