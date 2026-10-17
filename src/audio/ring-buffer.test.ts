import { describe, expect, it } from 'vitest';
import { CHANNELS } from './constants.ts';
import { Float32FrameRingBuffer } from './ring-buffer.ts';

/** Interleaved stereo: frame id f -> [f + 0.5, -(f + 0.5)] so L !== R. */
function seq(startFrame: number, frames: number): Float32Array {
  const a = new Float32Array(frames * CHANNELS);
  for (let f = 0; f < frames; f++) {
    a[f * CHANNELS] = startFrame + f + 0.5;
    a[f * CHANNELS + 1] = -(startFrame + f + 0.5);
  }
  return a;
}

function expectFrames(actual: Float32Array, firstFrameId: number, frames: number): void {
  expect(actual.length).toBe(frames * CHANNELS);
  for (let f = 0; f < frames; f++) {
    expect(actual[f * CHANNELS]).toBe(firstFrameId + f + 0.5);
    expect(actual[f * CHANNELS + 1]).toBe(-(firstFrameId + f + 0.5));
  }
}

describe('Float32FrameRingBuffer', () => {
  it('reads back exactly what was written', () => {
    const ring = new Float32FrameRingBuffer(16);
    expect(ring.write(seq(0, 8))).toBe(8);
    expect(ring.availableFrames).toBe(8);
    const out = new Float32Array(8 * CHANNELS);
    expect(ring.read(out, 8)).toBe(8);
    expectFrames(out, 0, 8);
    expect(ring.availableFrames).toBe(0);
  });

  it('preserves interleaved stereo pairs', () => {
    const ring = new Float32FrameRingBuffer(4);
    ring.write(seq(0, 2));
    const out = new Float32Array(2 * CHANNELS);
    ring.read(out, 2);
    expect(out[0]).toBe(0.5);
    expect(out[1]).toBe(-0.5);
    expect(out[2]).toBe(1.5);
    expect(out[3]).toBe(-1.5);
  });

  it('keeps integrity across wrap-around', () => {
    const ring = new Float32FrameRingBuffer(8);
    ring.write(seq(0, 6));
    const tmp = new Float32Array(4 * CHANNELS);
    expect(ring.read(tmp, 4)).toBe(4); // consume 4, write head now wraps
    expectFrames(tmp, 0, 4);
    ring.write(seq(6, 6)); // spans the physical end -> two-segment copy
    expect(ring.availableFrames).toBe(8);
    const out = new Float32Array(8 * CHANNELS);
    expect(ring.read(out, 8)).toBe(8);
    expectFrames(out, 4, 8); // frames 4..11 in order
  });

  it('supports partial reads', () => {
    const ring = new Float32FrameRingBuffer(16);
    ring.write(seq(0, 10));
    const out = new Float32Array(4 * CHANNELS);
    expect(ring.read(out, 4)).toBe(4);
    expectFrames(out, 0, 4);
    expect(ring.availableFrames).toBe(6);
    expect(ring.read(out, 4)).toBe(4);
    expectFrames(out, 4, 4);
    expect(ring.availableFrames).toBe(2);
  });

  it('reads fewer frames than requested when drained', () => {
    const ring = new Float32FrameRingBuffer(16);
    ring.write(seq(0, 3));
    const out = new Float32Array(10 * CHANNELS);
    expect(ring.read(out, 10)).toBe(3);
    expectFrames(out.subarray(0, 3 * CHANNELS), 0, 3);
    expect(ring.availableFrames).toBe(0);
  });

  it('drops oldest on overflow and counts them', () => {
    const ring = new Float32FrameRingBuffer(4);
    // Input larger than capacity: oldest *input* frames are dropped.
    expect(ring.write(seq(0, 6))).toBe(4);
    expect(ring.droppedFrames).toBe(2);
    // Without draining, a further write evicts already-buffered oldest frames.
    ring.write(seq(6, 3)); // 4 buffered (ids 2..5) + 3 new -> drop 3 oldest
    expect(ring.droppedFrames).toBe(5);
    const out = new Float32Array(5 * CHANNELS);
    expect(ring.read(out, 5)).toBe(4);
    expectFrames(out.subarray(0, 4 * CHANNELS), 5, 4); // frames 5..8 survive
    expect(ring.droppedFrames).toBe(5);
  });

  it('drops everything when a single write exceeds capacity', () => {
    const ring = new Float32FrameRingBuffer(4);
    ring.write(seq(0, 3));
    ring.write(seq(3, 10)); // keeps only last 4 (frames 9..12)
    expect(ring.droppedFrames).toBe(9); // 6 skipped input + 3 evicted
    const out = new Float32Array(4 * CHANNELS);
    expect(ring.read(out, 4)).toBe(4);
    expectFrames(out, 9, 4);
  });

  it('reset() clears contents, positions and counters', () => {
    const ring = new Float32FrameRingBuffer(4);
    ring.write(seq(0, 6));
    ring.read(new Float32Array(2 * CHANNELS), 2);
    ring.reset();
    expect(ring.availableFrames).toBe(0);
    expect(ring.droppedFrames).toBe(0);
    const out = new Float32Array(4 * CHANNELS);
    expect(ring.read(out, 4)).toBe(0);
    // Still functional after reset.
    ring.write(seq(100, 2));
    expect(ring.read(out, 2)).toBe(2);
    expectFrames(out.subarray(0, 2 * CHANNELS), 100, 2);
  });

  it('floors non-frame-aligned input lengths', () => {
    const ring = new Float32FrameRingBuffer(8);
    expect(ring.write(new Float32Array(3))).toBe(1); // 3 samples = 1 frame + tail
    expect(ring.availableFrames).toBe(1);
  });

  it('keeps FIFO order over many randomized writes/reads', () => {
    const CAP = 97;
    const ring = new Float32FrameRingBuffer(CAP);
    let expectedIds: number[] = [];
    let nextFrame = 0;
    let expectedDropped = 0;
    let s = 0x12345;
    const rand = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    for (let iter = 0; iter < 600; iter++) {
      const w = Math.floor(rand() * 30);
      ring.write(seq(nextFrame, w));
      for (let k = 0; k < w; k++) expectedIds.push(nextFrame + k);
      nextFrame += w;
      const drop = Math.max(0, expectedIds.length - CAP);
      expectedDropped += drop;
      expectedIds = expectedIds.slice(drop);
      const r = Math.floor(rand() * 40);
      const out = new Float32Array(r * CHANNELS);
      const got = ring.read(out, r);
      expect(got).toBe(Math.min(r, expectedIds.length));
      for (let f = 0; f < got; f++) {
        const id = expectedIds[f] ?? -1;
        expect(out[f * CHANNELS]).toBe(id + 0.5);
        expect(out[f * CHANNELS + 1]).toBe(-(id + 0.5));
      }
      expectedIds = expectedIds.slice(got);
      expect(ring.availableFrames).toBe(expectedIds.length);
      expect(ring.droppedFrames).toBe(expectedDropped);
    }
  });
});
