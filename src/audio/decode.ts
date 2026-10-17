// s16le -> float32 PCM decode, plus reassembly of frames split across chunks.
// Pure DSP: no DOM, no Node APIs — runs in the AudioWorklet and in node tests.

import { BYTES_PER_FRAME, BYTES_PER_SAMPLE, CHANNELS } from './constants.ts';

/** Whole interleaved stereo frames contained in `byteLength` bytes. */
export function framesFromBytes(byteLength: number): number {
  return Math.floor(byteLength / BYTES_PER_FRAME);
}

/**
 * Decode interleaved stereo s16le into interleaved floats scaled by 1/32768,
 * so -32768 maps to exactly -1. Reads little-endian via DataView, so views with
 * any `byteOffset` into a larger buffer are handled correctly.
 *
 * Decodes at most `framesFromBytes(bytes.byteLength)` frames and at most the
 * capacity of `out`; trailing bytes that don't complete a 4-byte frame are
 * ignored (carry them across calls with `PcmByteAssembler`). Returns the number
 * of frames written into `out`.
 */
export function decodeS16le(bytes: Uint8Array, out: Float32Array): number {
  const frames = Math.min(
    framesFromBytes(bytes.byteLength),
    Math.floor(out.length / CHANNELS),
  );
  if (frames <= 0) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * BYTES_PER_FRAME);
  const samples = frames * CHANNELS;
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * BYTES_PER_SAMPLE, true) / 32768;
  }
  return frames;
}

/**
 * Carries 0..(BYTES_PER_FRAME-1) leftover bytes between pushes so chunks that
 * split a 4-byte stereo frame still decode exactly.
 *
 * `push(bytes)` returns a fresh Uint8Array holding the frame-aligned prefix of
 * the logical stream `carry ++ bytes` (length is a multiple of BYTES_PER_FRAME);
 * the unaligned tail is retained internally for the next call.
 */
export class PcmByteAssembler {
  private carry = new Uint8Array(BYTES_PER_FRAME);
  private carryLen = 0;

  /** Bytes currently held over for the next push (0..BYTES_PER_FRAME-1). */
  get carriedBytes(): number {
    return this.carryLen;
  }

  push(bytes: Uint8Array): Uint8Array {
    const carryLen = this.carryLen;
    const total = carryLen + bytes.byteLength;
    const alignedLen = total - (total % BYTES_PER_FRAME);
    const out = new Uint8Array(alignedLen);
    if (alignedLen >= carryLen) {
      // Aligned output consumes all carried bytes plus `needed` new bytes.
      if (carryLen > 0) out.set(this.carry.subarray(0, carryLen), 0);
      const needed = alignedLen - carryLen;
      if (needed > 0) out.set(bytes.subarray(0, needed), carryLen);
      // Whatever remains of `bytes` (0..3 bytes) becomes the new carry.
      const leftoverLen = total - alignedLen;
      if (leftoverLen > 0) {
        this.carry.set(bytes.subarray(bytes.byteLength - leftoverLen), 0);
      }
      this.carryLen = leftoverLen;
    } else {
      // Total < BYTES_PER_FRAME: nothing to emit, append the input to carry.
      this.carry.set(bytes, carryLen);
      this.carryLen = total;
    }
    return out;
  }

  reset(): void {
    this.carryLen = 0;
  }
}
