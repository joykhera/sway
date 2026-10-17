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
  it('replaces a long queued stream with a unity-gain crossfade and counts only the destination', () => {
    const core = makeCore({ prerollMs: 1 });
    core.pushPcm(pcmConstant(RATE * 4, 8192));
    core.render(128);
    core.replacePcm(pcmConstant(RATE * 3, -8192), RATE, 250);
    expect(core.getStats().bufferedMs).toBe(3000);
    expect(core.getStats().priming).toBe(true);
    const out = core.render(RATE / 4).slice();
    expect(out[0]).toBe(.25);
    expect(out[out.length - 1]).toBe(-.25);
    expect(out[RATE / 4]).toBeCloseTo(0, 4);
    expect(core.getStats()).toMatchObject({ priming: false, bufferedMs: 2750, underruns: 0 });
    expect([...core.render(128)].every(sample => sample === -.25)).toBe(true);
  });

  it('resets byte carry and resampler across a format-changing replacement', () => {
    const core = makeCore({ prerollMs: 1 });
    core.pushPcm(pcmConstant(4800, 32767));
    core.pushPcm(new Uint8Array([255, 127, 255]));
    core.render(128);
    core.replacePcm(pcmConstant(24000 * 3, -8192), 24000, 0);
    expect(core.getStats().bufferedMs).toBeCloseTo(3000, 0);
    expect([...core.render(128)].every(sample => sample === -.25)).toBe(true);
    expect(core.getStats().priming).toBe(false);
  });

  it('measures the rendered 100 ms crossfade, then tracks the replacement signal', () => {
    const core = makeCore({ prerollMs: 1 });
    core.pushPcm(pcmConstant(RATE * 3, 8192));
    core.render(128);
    core.replacePcm(pcmConstant(RATE * 3, -8192), RATE, 100);
    const out = core.render(RATE / 10).slice();
    const rms = Math.sqrt(out.reduce((sum, sample) => sum + sample * sample, 0) / out.length);
    expect(out[0]).toBe(.25);
    expect(out.at(-1)).toBe(-.25);
    expect(rms).toBeLessThan(.2); // Mixing opposite signs must not report either lane's .25 RMS.
    expect(core.getStats().energyRms).toBeCloseTo(rms, 8);
    expect(core.getStats()).toMatchObject({ chunksReceived: 1, priming: false });

    core.replacePcm(pcmSine(RATE * 3, RATE, 880), RATE, 100);
    for (let i = 0; i < 200; i++) core.render(128);
    const stats = core.getStats();
    expect(stats.pitchHz).toBeGreaterThan(800);
    expect(stats.pitchHz).toBeLessThan(960);
    expect(stats.brightnessHz).toBeGreaterThan(400);
    expect(stats.brightnessHz).toBeLessThan(480);
    expect(stats.energyRms).toBeGreaterThan(.4);
    expect(stats.energyRms).toBeLessThan(.46);
  });

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

  describe('rendered-signal telemetry', () => {
    it('reports ~0 energy, 0 brightness, and null pitch on silence', () => {
      const core = makeCore({ prerollMs: 0 });
      core.pushPcm(pcmConstant(4800, 0)); // 100 ms of digital silence
      for (let i = 0; i < 20; i++) core.render(128);
      const s = core.getStats();
      expect(s.energyRms).toBe(0);
      expect(s.brightnessHz).toBe(0);
      expect(s.pitchHz).toBeNull();
    });

    it('reports ~0 energy and null pitch while priming emits silence', () => {
      const core = makeCore(); // 2400-frame preroll, not yet met
      core.pushPcm(pcmSine(1000));
      for (let i = 0; i < 10; i++) core.render(128); // all priming zeros
      const s = core.getStats();
      expect(s.priming).toBe(true);
      expect(s.energyRms).toBe(0);
      expect(s.pitchHz).toBeNull();
    });

    it('locks a 440 Hz sine: pitch ≈440, brightness ≈220, energy in (0,1]', () => {
      const core = makeCore({ prerollMs: 0 });
      core.pushPcm(pcmSine(48000, RATE, 440)); // 1 s of tone
      // Render > TELEMETRY_WINDOW_MS (300 ms) so the window is all tone.
      for (let i = 0; i < 200; i++) core.render(128); // 25 600 f ≈ 533 ms
      const s = core.getStats();
      // zcrHz ≈ 2·440 = 880 crossings/s → pitchHz = zcrHz/2 ≈ 440.
      expect(s.pitchHz).not.toBeNull();
      expect(s.pitchHz!).toBeGreaterThanOrEqual(440 * 0.85);
      expect(s.pitchHz!).toBeLessThanOrEqual(440 * 1.15);
      // brightnessHz = zcrHz/4 ≈ 220 for a pure tone (generous tolerance).
      expect(s.brightnessHz).toBeGreaterThanOrEqual(140);
      expect(s.brightnessHz).toBeLessThanOrEqual(300);
      // amp 20000/32768 ≈ 0.61 peak → RMS ≈ 0.43.
      expect(s.energyRms).toBeGreaterThan(0);
      expect(s.energyRms).toBeLessThanOrEqual(1);
      expect(s.energyRms).toBeGreaterThan(0.3);
      expect(s.energyRms).toBeLessThan(0.6);
    });

    it('higher-frequency sine reads proportionally brighter', () => {
      const bright = makeCore({ prerollMs: 0 });
      bright.pushPcm(pcmSine(48000, RATE, 4000));
      for (let i = 0; i < 200; i++) bright.render(128);
      const dark = makeCore({ prerollMs: 0 });
      dark.pushPcm(pcmSine(48000, RATE, 220));
      for (let i = 0; i < 200; i++) dark.render(128);
      expect(bright.getStats().brightnessHz).toBeGreaterThan(
        dark.getStats().brightnessHz,
      );
      expect(dark.getStats().pitchHz!).toBeGreaterThanOrEqual(220 * 0.85);
      expect(dark.getStats().pitchHz!).toBeLessThanOrEqual(220 * 1.15);
    });

    it('window slides: pitch locks on tone, returns to null once it drains', () => {
      const core = makeCore({ prerollMs: 0, reprimeMs: 10 });
      core.pushPcm(pcmConstant(19200, 0)); // 400 ms silence
      for (let i = 0; i < 150; i++) core.render(128); // render all of it
      let s = core.getStats();
      expect(s.energyRms).toBeLessThan(0.002);
      expect(s.pitchHz).toBeNull();

      core.pushPcm(pcmSine(24000, RATE, 440)); // 500 ms of tone
      for (let i = 0; i < 190; i++) core.render(128); // exhausts the ring
      s = core.getStats();
      expect(s.pitchHz).not.toBeNull();
      expect(s.pitchHz!).toBeGreaterThanOrEqual(440 * 0.85);
      expect(s.pitchHz!).toBeLessThanOrEqual(440 * 1.15);

      // ~500 ms of underrun/priming zeros slides the window fully past the tone.
      for (let i = 0; i < 200; i++) core.render(128);
      s = core.getStats();
      expect(s.energyRms).toBeLessThan(0.002);
      expect(s.brightnessHz).toBe(0);
      expect(s.pitchHz).toBeNull();
    });

    it('reset() clears telemetry back to silence defaults', () => {
      const core = makeCore({ prerollMs: 0 });
      core.pushPcm(pcmSine(24000, RATE, 440));
      for (let i = 0; i < 190; i++) core.render(128);
      expect(core.getStats().pitchHz).not.toBeNull();
      core.reset();
      const s = core.getStats();
      expect(s.energyRms).toBe(0);
      expect(s.brightnessHz).toBe(0);
      expect(s.pitchHz).toBeNull();
    });
  });
});
