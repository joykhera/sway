// Chunked linear-interpolation resampler for interleaved stereo float PCM.
// Pure DSP: no DOM, no Node APIs — runs in the AudioWorklet and in node tests.

import { CHANNELS } from './constants.ts';

/**
 * Resamples interleaved stereo float frames from `sourceRateHz` to
 * `outputRateHz` using linear interpolation on both channels.
 *
 * Streaming model: the interpolation point sits between `prevL/prevR` (the last
 * consumed input frame) and the next buffered input frame, at fractional offset
 * `phase` in [0, 1). The last input frame of every `push` is retained as the
 * next call's anchor, so feeding the same stream in arbitrary chunks yields
 * bit-identical output to one big push. `phase` stays in [0,1) at every emit,
 * so output positions never drift with stream length.
 *
 * Equal rates (`step === 1`) take a passthrough fast path: no interpolation,
 * no 1-frame latency, output identical to input.
 */
export class StreamingResampler {
  private readonly outputRateHz: number;
  private sourceRateHz: number;
  /** Input frames advanced per output frame. <1 upsamples, >1 downsamples. */
  private step: number;
  private phase = 0;
  private prevL = 0;
  private prevR = 0;
  private hasPrev = false;

  constructor(sourceRateHz: number, outputRateHz: number) {
    if (!(sourceRateHz > 0) || !(outputRateHz > 0)) {
      throw new RangeError(
        `StreamingResampler: sample rates must be > 0, got ${sourceRateHz} -> ${outputRateHz}`,
      );
    }
    this.sourceRateHz = sourceRateHz;
    this.outputRateHz = outputRateHz;
    this.step = sourceRateHz / outputRateHz;
  }

  /**
   * Resample `inputFrames` (interleaved L/R pairs) into `out` (interleaved).
   * Returns output frames produced (limited by `out` capacity and by how many
   * input frames can be interpolated — the last input frame is always kept as
   * the next call's anchor).
   */
  push(inputFrames: Float32Array, out: Float32Array): number {
    const m = Math.floor(inputFrames.length / CHANNELS);
    const outCap = Math.floor(out.length / CHANNELS);
    if (this.step === 1) {
      const n = Math.min(m, outCap);
      out.set(inputFrames.subarray(0, n * CHANNELS));
      return n;
    }
    let i = 0; // index of the next input frame to consume
    if (!this.hasPrev) {
      if (m === 0) return 0;
      this.prevL = inputFrames[0] ?? 0;
      this.prevR = inputFrames[1] ?? 0;
      this.hasPrev = true;
      i = 1;
    }
    // A previous push may have ended mid-skip (phase >= 1, input exhausted —
    // only possible when step > 1). Resume consuming before emitting.
    while (this.phase >= 1 && i < m) {
      this.prevL = inputFrames[i * CHANNELS] ?? 0;
      this.prevR = inputFrames[i * CHANNELS + 1] ?? 0;
      i++;
      this.phase -= 1;
    }
    let produced = 0;
    while (produced < outCap && this.phase < 1 && i < m) {
      const nextL = inputFrames[i * CHANNELS] ?? 0;
      const nextR = inputFrames[i * CHANNELS + 1] ?? 0;
      const t = this.phase;
      out[produced * CHANNELS] = this.prevL + (nextL - this.prevL) * t;
      out[produced * CHANNELS + 1] = this.prevR + (nextR - this.prevR) * t;
      produced++;
      this.phase += this.step;
      // Consume input frames the interpolation point has moved past.
      while (this.phase >= 1 && i < m) {
        this.prevL = inputFrames[i * CHANNELS] ?? 0;
        this.prevR = inputFrames[i * CHANNELS + 1] ?? 0;
        i++;
        this.phase -= 1;
      }
    }
    return produced;
  }

  /**
   * Switch the assumed source rate (e.g. the relay re-announces a different
   * format mid-stream). Resets carry and phase, so the next push starts a fresh
   * interpolation — frames already resampled are unaffected.
   */
  setSourceRate(newRateHz: number): void {
    if (!(newRateHz > 0)) {
      throw new RangeError(`StreamingResampler.setSourceRate: rate must be > 0, got ${newRateHz}`);
    }
    this.sourceRateHz = newRateHz;
    this.step = newRateHz / this.outputRateHz;
    this.resetCarry();
  }

  /** Drop carried phase/anchor state; rates are unchanged. */
  reset(): void {
    this.resetCarry();
  }

  /**
   * Upper-bound estimate of the frames `push` would emit for `inputFramesCount`
   * input frames. Safe for sizing output scratch buffers (never underestimates).
   */
  pendingOutputFrames(inputFramesCount: number): number {
    if (this.step === 1) return Math.max(0, Math.floor(inputFramesCount));
    return Math.max(0, Math.ceil(inputFramesCount / this.step) + 1);
  }

  private resetCarry(): void {
    this.phase = 0;
    this.prevL = 0;
    this.prevR = 0;
    this.hasPrev = false;
  }
}
