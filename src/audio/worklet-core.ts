// PcmWorkletCore: the pure streaming-PCM engine consumed by the AudioWorklet
// wrapper (pcm-worklet.ts) and by node unit tests. Pipeline:
//   bytes -> PcmByteAssembler -> decodeS16le -> StreamingResampler -> ring
//   render(): ring -> interleaved float stereo at the AudioContext rate,
//           with preroll/reprime gating and underrun zero-fill.
// No DOM, no Node APIs, no timers.

import {
  CHANNELS,
  DEFAULT_SAMPLE_RATE_HZ,
  PREROLL_MS,
  RENDER_QUANTUM_FRAMES,
  REPRIME_MS,
  RING_CAPACITY_MS,
} from './constants.ts';
import { decodeS16le, framesFromBytes, PcmByteAssembler } from './decode.ts';
import { Float32FrameRingBuffer } from './ring-buffer.ts';
import { StreamingResampler } from './resample.ts';

/**
 * Streaming PCM engine. Interleaved stereo s16le bytes in; interleaved stereo
 * floats at `outputSampleRateHz` out. All methods are allocation-free per
 * render once buffers have grown (scratch/output buffers grow, never shrink).
 */
export class PcmWorkletCore {
  private readonly outputRateHz: number;
  private sourceRateHz: number;
  private readonly prerollFrames: number;
  private readonly reprimeFrames: number;

  private readonly assembler = new PcmByteAssembler();
  private readonly resampler: StreamingResampler;
  private readonly ring: Float32FrameRingBuffer;

  private scratchDecoded = new Float32Array(0);
  private scratchResampled = new Float32Array(0);
  private outBuf = new Float32Array(RENDER_QUANTUM_FRAMES * CHANNELS);

  /** True while output is held silent waiting for the (re)prime threshold. */
  private priming = true;
  /** False until the first successful prime; picks preroll vs reprime. */
  private hasPrimed = false;
  private underruns = 0;
  private fadeTail = new Float32Array(0);
  private fadeFrame = 0;
  private fadeFrames = 0;

  constructor(opts: {
    outputSampleRateHz?: number;
    capacityMs?: number;
    prerollMs?: number;
    reprimeMs?: number;
  } = {}) {
    this.outputRateHz = opts.outputSampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    const capacityMs = opts.capacityMs ?? RING_CAPACITY_MS;
    this.ring = new Float32FrameRingBuffer(
      Math.ceil((this.outputRateHz * capacityMs) / 1000),
    );
    this.prerollFrames = Math.ceil((this.outputRateHz * (opts.prerollMs ?? PREROLL_MS)) / 1000);
    this.reprimeFrames = Math.ceil((this.outputRateHz * (opts.reprimeMs ?? REPRIME_MS)) / 1000);
    // Until configure() says otherwise, assume the Lyria default rate.
    this.sourceRateHz = DEFAULT_SAMPLE_RATE_HZ;
    this.resampler = new StreamingResampler(this.sourceRateHz, this.outputRateHz);
  }

  /**
   * Announce the source PCM rate. Safe to call repeatedly mid-stream: the
   * resampler's carry/phase is reset, but already-buffered (already resampled)
   * audio keeps playing.
   */
  configure(sourceSampleRateHz: number): void {
    this.sourceRateHz = sourceSampleRateHz;
    this.resampler.setSourceRate(sourceSampleRateHz);
  }

  /** Feed interleaved stereo s16le bytes of any length (splits are carried). */
  pushPcm(bytes: Uint8Array): void {
    const aligned = this.assembler.push(bytes);
    const inFrames = framesFromBytes(aligned.byteLength);
    if (inFrames === 0) return;
    if (this.scratchDecoded.length < inFrames * CHANNELS) {
      this.scratchDecoded = new Float32Array(inFrames * CHANNELS);
    }
    const decoded = decodeS16le(aligned, this.scratchDecoded);
    if (decoded === 0) return;
    const estimate = this.resampler.pendingOutputFrames(decoded);
    if (this.scratchResampled.length < estimate * CHANNELS) {
      this.scratchResampled = new Float32Array(estimate * CHANNELS);
    }
    const produced = this.resampler.push(
      this.scratchDecoded.subarray(0, decoded * CHANNELS),
      this.scratchResampled,
    );
    if (produced > 0) {
      this.ring.write(this.scratchResampled.subarray(0, produced * CHANNELS));
    }
  }

  /** The caller validates/prebuffers the destination before this atomic handoff. */
  replacePcm(bytes: Uint8Array, sourceSampleRateHz: number, fadeMs: number): void {
    const frames = Math.max(0, Math.round(this.outputRateHz * fadeMs / 1000));
    // Capture exactly the outgoing audio that would have rendered next. A
    // bounded tail replaces the whole old queue, including any byte carry.
    const tail = frames ? this.render(frames).slice() : new Float32Array(0);
    this.reset();
    this.configure(sourceSampleRateHz);
    this.pushPcm(bytes);
    this.fadeTail = tail;
    this.fadeFrames = frames;
    this.fadeFrame = 0;
  }

  /**
   * Produce `outFrames` interleaved stereo frames (returned array length is
   * `outFrames * CHANNELS`). While priming — before the first prerollMs' worth
   * of audio arrives, or after an underrun until reprimeMs' worth has
   * re-buffered — returns silence without consuming the ring. A render that
   * can't fill the buffer zero-fills the remainder, counts an underrun, and
   * switches back to priming.
   *
   * The returned array aliases an internal buffer reused by the next call.
   */
  render(outFrames: number): Float32Array {
    const frames = Math.max(0, Math.floor(outFrames));
    const samples = frames * CHANNELS;
    if (this.outBuf.length < samples) this.outBuf = new Float32Array(samples);
    const out = this.outBuf.subarray(0, samples);
    if (this.priming) {
      const threshold = this.hasPrimed ? this.reprimeFrames : this.prerollFrames;
      if (this.ring.availableFrames < threshold) {
        out.fill(0);
        return out;
      }
      this.priming = false;
      this.hasPrimed = true;
    }
    const got = this.ring.read(out, frames);
    if (got < frames) {
      out.subarray(got * CHANNELS).fill(0);
      this.underruns++;
      this.priming = true;
    }
    if (this.fadeFrame < this.fadeFrames) {
      const count = Math.min(frames, this.fadeFrames - this.fadeFrame);
      for (let i = 0; i < count; i++) {
        const progress = this.fadeFrames <= 1 ? 1 : (this.fadeFrame + i) / (this.fadeFrames - 1);
        for (let channel = 0; channel < CHANNELS; channel++) {
          const index = i * CHANNELS + channel;
          out[index] = this.fadeTail[(this.fadeFrame + i) * CHANNELS + channel]! * (1 - progress) + out[index]! * progress;
        }
      }
      this.fadeFrame += count;
      if (this.fadeFrame === this.fadeFrames) this.fadeTail = new Float32Array(0);
    }
    return out;
  }

  getStats(): {
    bufferedMs: number;
    underruns: number;
    droppedFrames: number;
    priming: boolean;
  } {
    return {
      bufferedMs: (this.ring.availableFrames / this.outputRateHz) * 1000,
      underruns: this.underruns,
      droppedFrames: this.ring.droppedFrames,
      priming: this.priming || this.fadeFrame < this.fadeFrames,
    };
  }

  /** Drop all buffered/carried audio and counters; back to initial priming. */
  reset(): void {
    this.assembler.reset();
    this.resampler.reset();
    this.ring.reset();
    this.priming = true;
    this.hasPrimed = false;
    this.underruns = 0;
    this.fadeTail = new Float32Array(0);
    this.fadeFrame = this.fadeFrames = 0;
  }
}
