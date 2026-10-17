import { describe, expect, it } from 'vitest';
import { BYTES_PER_FRAME } from './constants.ts';
import { PcmWorkletCore } from './worklet-core.ts';

const RATE = 48000;

/** Interleaved stereo s16le sine (identical L/R) at `frames` total frames. */
function pcmSine(frames: number, rate = RATE, freq = 440, amp = 20000): Uint8Array {
  const b = new Uint8Array(frames * BYTES_PER_FRAME);
  const v = new DataView(b.buffer);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp);
    v.setInt16(i * BYTES_PER_FRAME, s, true);
    v.setInt16(i * BYTES_PER_FRAME + 2, s, true);
  }
  return b;
}

/** Constant-value PCM: every sample = `value` (int16), stereo. */
function pcmConstant(frames: number, value: number): Uint8Array {
  const b = new Uint8Array(frames * BYTES_PER_FRAME);
  const v = new DataView(b.buffer);
  for (let i = 0; i < frames * 2; i++) v.setInt16(i * 2, value, true);
  return b;
}

function makeCore(overrides: {
  outputSampleRateHz?: number;
  capacityMs?: number;
  prerollMs?: number;
  reprimeMs?: number;
} = {}) {
  return new PcmWorkletCore({
    outputSampleRateHz: RATE,
    capacityMs: 5000,
    prerollMs: 50, // 2400 frames @ 48 kHz
    reprimeMs: 10, // 480 frames
    ...overrides,
  });
}

function isAllZero(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}

describe('PcmWorkletCore', () => {
  it('gates output with silence until prerollMs worth is buffered', () => {
    const core = makeCore(); // preroll 2400 frames
    core.pushPcm(pcmSine(2000));
    const sil = core.render(128);
    expect(sil.length).toBe(256);
    expect(isAllZero(sil)).toBe(true);
    expect(core.getStats().priming).toBe(true);
    // Buffer was not consumed while priming.
    expect(core.getStats().bufferedMs).toBeCloseTo((2000 / RATE) * 1000, 3);

    core.pushPcm(pcmSine(400)); // now exactly 2400
    const audio = core.render(128);
    expect(core.getStats().priming).toBe(false);
    expect(isAllZero(audio)).toBe(false);
  });

  it('renders the decoded PCM values once primed', () => {
    const core = makeCore({ prerollMs: 1 }); // 48 frames
    core.pushPcm(pcmConstant(100, 8192));
    const out = core.render(100);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(8192 / 32768, 6);
    }
  });

  it('underrun mid-render zero-fills the remainder and re-primes at reprimeMs', () => {
    const core = makeCore({ prerollMs: 1, reprimeMs: 10 }); // 48 / 480 frames
    core.pushPcm(pcmSine(48));
    const out = core.render(100); // only 48 available
    expect(isAllZero(out.subarray(0, 48 * 2))).toBe(false);
    expect(isAllZero(out.subarray(48 * 2))).toBe(true);
    const s1 = core.getStats();
    expect(s1.underruns).toBe(1);
    expect(s1.priming).toBe(true);

    // Not enough to reach reprime (480) yet.
    core.pushPcm(pcmSine(400));
    expect(isAllZero(core.render(64))).toBe(true);
    expect(core.getStats().priming).toBe(true);

    core.pushPcm(pcmSine(100)); // 500 >= 480 -> reprimed
    expect(isAllZero(core.render(64))).toBe(false);
    expect(core.getStats().priming).toBe(false);
  });

  it('decodes correctly when PCM pushes split frames at odd byte offsets', () => {
    const core = makeCore({ prerollMs: 0 });
    const whole = pcmSine(100); // 400 bytes
    const expected = (() => {
      const ref = makeCore({ prerollMs: 0 });
      ref.pushPcm(whole);
      return ref.render(100).slice();
    })();

    // Split at byte 201 (mid-frame: 50 frames + 1 dangling byte).
    core.pushPcm(whole.subarray(0, 201));
    core.pushPcm(whole.subarray(201, 203)); // 2 more bytes -> still mid-frame
    core.pushPcm(whole.subarray(203));
    const out = core.render(100);
    expect(out).toEqual(expected);
    expect(core.getStats().underruns).toBe(0);
  });

  it('configure() mid-stream resamples subsequent chunks', () => {
    const core = makeCore({ prerollMs: 1 });
    core.configure(48000);
    core.pushPcm(pcmSine(480, RATE)); // 10 ms passthrough
    core.render(48); // prime; consumes 48 frames -> 432 left (9 ms)
    expect(core.getStats().bufferedMs).toBeCloseTo(9, 3);

    core.configure(44100);
    core.pushPcm(pcmSine(441, 44100)); // 10 ms of source audio
    // Resampled to ~480 output frames: bufferedMs ~ 9 + 10.
    expect(core.getStats().bufferedMs).toBeCloseTo(19, 0);

    // Repeated configures are safe.
    core.configure(44100);
    core.configure(48000);
    core.pushPcm(pcmSine(48, RATE));
  });

  it('bufferedMs tracks pushed-minus-rendered duration at the output rate', () => {
    const core = makeCore({ prerollMs: 0 });
    core.pushPcm(pcmSine(4800)); // 100 ms
    expect(core.getStats().bufferedMs).toBeCloseTo(100, 5);
    core.render(480); // render 10 ms
    expect(core.getStats().bufferedMs).toBeCloseTo(90, 5);
    core.render(4800 - 480 - 2000); // drain to 2000 frames
    expect(core.getStats().bufferedMs).toBeCloseTo((2000 / RATE) * 1000, 5);
  });

  it('while priming, buffered audio is not consumed', () => {
    const core = makeCore(); // 2400-frame preroll
    core.pushPcm(pcmSine(1000));
    core.render(64); // silent, no consumption
    core.render(64);
    expect(core.getStats().bufferedMs).toBeCloseTo((1000 / RATE) * 1000, 3);
  });

  it('droppedFrames reports ring overflow', () => {
    const core = makeCore({ prerollMs: 0, capacityMs: 1 }); // 48-frame ring
    core.pushPcm(pcmSine(96));
    expect(core.getStats().droppedFrames).toBe(48);
    expect(core.getStats().bufferedMs).toBeCloseTo(1, 5);
  });

  it('reset() clears buffer, carry, and counters; re-primes from scratch', () => {
    const core = makeCore({ prerollMs: 1, reprimeMs: 10 });
    core.pushPcm(pcmSine(48));
    core.render(100); // prime + underrun
    core.reset();
    const s = core.getStats();
    expect(s.priming).toBe(true);
    expect(s.underruns).toBe(0);
    expect(s.bufferedMs).toBe(0);
    expect(s.droppedFrames).toBe(0);
    expect(isAllZero(core.render(64))).toBe(true);
    // Re-prime requires a fresh preroll fill.
    core.pushPcm(pcmSine(48));
    expect(isAllZero(core.render(48))).toBe(false);
  });
});
