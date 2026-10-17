// Fixed-capacity interleaved-stereo frame ring over a flat Float32Array.
// Pure DSP: no DOM, no Node APIs — runs in the AudioWorklet and in node tests.

import { CHANNELS } from './constants.ts';

/**
 * Ring buffer addressed in *frames* (one frame = CHANNELS interleaved floats).
 *
 * Writes never block: if the buffer is full, the OLDEST frames are evicted to
 * make room, and evictions accumulate in `droppedFrames`. Input larger than the
 * whole capacity keeps only its newest `capacityFrames` frames (the skipped
 * prefix counts as dropped too).
 *
 * All copies go through at most two contiguous `subarray().set()` spans, so
 * cost is O(1) per frame with no per-sample loops.
 */
export class Float32FrameRingBuffer {
  readonly capacityFrames: number;
  private readonly buf: Float32Array;
  private readFrame = 0;
  private writeFrame = 0;
  private size = 0;
  private dropped = 0;

  constructor(capacityFrames: number) {
    this.capacityFrames = Math.max(1, Math.floor(capacityFrames));
    this.buf = new Float32Array(this.capacityFrames * CHANNELS);
  }

  /** Frames currently buffered and readable. */
  get availableFrames(): number {
    return this.size;
  }

  /** Cumulative frames evicted because the ring was full. Reset by `reset()`. */
  get droppedFrames(): number {
    return this.dropped;
  }

  /**
   * Store as many of `frames` as the capacity allows, evicting the oldest
   * buffered (or oldest incoming) frames when full.
   * Returns the number of input frames actually stored (<= input frames).
   */
  write(frames: Float32Array): number {
    const cap = this.capacityFrames;
    let inFrames = Math.floor(frames.length / CHANNELS);
    let srcFrame = 0;
    if (inFrames > cap) {
      const skip = inFrames - cap;
      this.dropped += skip;
      srcFrame = skip;
      inFrames = cap;
    }
    const overflow = this.size + inFrames - cap;
    if (overflow > 0) {
      this.dropped += overflow;
      this.readFrame = (this.readFrame + overflow) % cap;
      this.size -= overflow;
    }
    const first = Math.min(inFrames, cap - this.writeFrame);
    this.buf.set(
      frames.subarray(srcFrame * CHANNELS, (srcFrame + first) * CHANNELS),
      this.writeFrame * CHANNELS,
    );
    const second = inFrames - first;
    if (second > 0) {
      this.buf.set(
        frames.subarray((srcFrame + first) * CHANNELS, (srcFrame + inFrames) * CHANNELS),
        0,
      );
    }
    this.writeFrame = (this.writeFrame + inFrames) % cap;
    this.size += inFrames;
    return inFrames;
  }

  /**
   * Copy up to `framesWanted` frames (interleaved) into `out`, preserving
   * channel order. Returns frames actually copied (<= availableFrames).
   */
  read(out: Float32Array, framesWanted: number): number {
    const cap = this.capacityFrames;
    const n = Math.min(framesWanted, this.size, Math.floor(out.length / CHANNELS));
    if (n <= 0) return 0;
    const first = Math.min(n, cap - this.readFrame);
    out.set(this.buf.subarray(this.readFrame * CHANNELS, (this.readFrame + first) * CHANNELS), 0);
    const second = n - first;
    if (second > 0) {
      out.set(this.buf.subarray(0, second * CHANNELS), first * CHANNELS);
    }
    this.readFrame = (this.readFrame + n) % cap;
    this.size -= n;
    return n;
  }

  reset(): void {
    this.readFrame = 0;
    this.writeFrame = 0;
    this.size = 0;
    this.dropped = 0;
  }
}
