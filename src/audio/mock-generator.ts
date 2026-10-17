// Deterministic fake PCM source for keyless dev/testing (handoff: "mock audio
// mode"). Emits a soft, listenable pad as interleaved stereo s16le — the same
// wire shape the relay forwards — so the player and controller can be built
// without a Lyria session.
//
// Determinism contract: two generators with the same `{seed, preset}` that
// receive the same method-call sequence produce byte-identical output. All
// randomness flows through one seeded mulberry32.

import { BYTES_PER_SAMPLE, CHANNELS, DEFAULT_SAMPLE_RATE_HZ } from './constants.ts';

export type MockPreset = 'dusk' | 'glass' | 'ember' | 'tide';

/** `cyclePreset()` walks this fixed order. */
const PRESET_ORDER: readonly MockPreset[] = ['dusk', 'glass', 'ember', 'tide'];

const MIN_CHUNK_MS = 10;
const MAX_CHUNK_MS = 60;
/** `nudge()` interpolates partial gains/freqs over this much generated audio. */
const NUDGE_RAMP_MS = 200;
/** With `splitOdd`, every Nth chunk ends mid-frame (odd int16 count). */
const SPLIT_EVERY_NTH_CHUNK = 7;
const PEAK_LINEAR = Math.pow(10, -18 / 20); // ≈ −18 dBFS
const TWO_PI = Math.PI * 2;

/** mulberry32: small, fast, deterministic seeded PRNG → [0, 1). */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type WaveShape = 'sine' | 'triangle';

type PartialDef = {
  /** Multiplier of the preset root frequency. */
  ratio: number;
  /** Relative level (0..1) before normalization. */
  gain: number;
  shape: WaveShape;
  /** Symmetric L/R detune (total spread, cents) for stereo width. */
  widthCents: number;
};

type PresetDef = {
  rootHz: number;
  /** Slow amplitude LFO. */
  lfoHz: number;
  lfoDepth: number;
  partials: readonly PartialDef[];
};

// Distinct root pitch + brightness per preset; 2–3 detuned partials each.
const PRESETS: Record<MockPreset, PresetDef> = {
  dusk: {
    rootHz: 110,
    lfoHz: 0.07,
    lfoDepth: 0.35,
    partials: [
      { ratio: 1, gain: 1.0, shape: 'sine', widthCents: 4 },
      { ratio: 1.5, gain: 0.4, shape: 'sine', widthCents: 6 },
      { ratio: 2.004, gain: 0.15, shape: 'triangle', widthCents: 3 },
    ],
  },
  glass: {
    rootHz: 392,
    lfoHz: 0.11,
    lfoDepth: 0.25,
    partials: [
      { ratio: 1, gain: 0.8, shape: 'sine', widthCents: 5 },
      { ratio: 2.997, gain: 0.32, shape: 'sine', widthCents: 7 },
      { ratio: 4.01, gain: 0.18, shape: 'triangle', widthCents: 4 },
    ],
  },
  ember: {
    rootHz: 164.81,
    lfoHz: 0.09,
    lfoDepth: 0.3,
    partials: [
      { ratio: 1, gain: 0.9, shape: 'triangle', widthCents: 5 },
      { ratio: 2.0, gain: 0.45, shape: 'sine', widthCents: 4 },
      { ratio: 3.005, gain: 0.16, shape: 'sine', widthCents: 8 },
    ],
  },
  tide: {
    rootHz: 130.81,
    lfoHz: 0.05,
    lfoDepth: 0.45,
    partials: [
      { ratio: 1, gain: 1.0, shape: 'sine', widthCents: 3 },
      { ratio: 1.007, gain: 0.55, shape: 'sine', widthCents: 5 }, // slow beating
      { ratio: 2.5, gain: 0.22, shape: 'triangle', widthCents: 6 },
    ],
  },
};

/** Per-partial runtime state: continuous phases plus the nudge ramp endpoints. */
type PartialState = {
  /** Per-channel phase in cycles, [L, R]. */
  phase: [number, number];
  detL: number;
  detR: number;
  gain: number;
  gainStart: number;
  gainTarget: number;
  freqMul: number;
  freqStart: number;
  freqTarget: number;
};

export type MockPcmGeneratorOptions = {
  sampleRateHz?: number;
  seed?: number;
  preset?: MockPreset;
  /**
   * When on, every 7th emitted chunk ends mid-frame (byte length ≡ 2 mod 4).
   * Deliberate: exercises the player's mid-frame split handling.
   */
  splitOdd?: boolean;
};

export class MockPcmGenerator {
  private readonly sr: number;
  private readonly splitOdd: boolean;
  private readonly initialPreset: MockPreset;

  private rng!: () => number;
  private presetName!: MockPreset;
  private def!: PresetDef;
  private parts!: PartialState[];
  private norm!: number;
  private lfoPhase!: number;
  private lfoGain!: number;
  private rampPos!: number;
  private rampTotal!: number;
  /** Position in the continuous interleaved-int16 stream (parity = channel). */
  private streamPos!: number;
  private chunksEmitted!: number;

  constructor(opts: MockPcmGeneratorOptions = {}) {
    this.sr = opts.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    this.splitOdd = opts.splitOdd ?? false;
    this.initialPreset = opts.preset ?? 'dusk';
    this.setSeed(opts.seed ?? 1);
  }

  /** The preset currently being generated. */
  get preset(): MockPreset {
    return this.presetName;
  }

  /** Rewinds the whole stream: same seed → byte-identical sequence. */
  setSeed(seed: number): void {
    this.rng = createRng(seed);
    this.presetName = this.initialPreset;
    this.streamPos = 0;
    this.chunksEmitted = 0;
    this.applyPreset();
  }

  /** Hard switch to another preset — models a hard steer; may click once. */
  setPreset(p: MockPreset): void {
    this.presetName = p;
    this.applyPreset();
  }

  /** Advances to the next preset in the fixed order (wraps), returns it. */
  cyclePreset(): MockPreset {
    const i = PRESET_ORDER.indexOf(this.presetName);
    const next = PRESET_ORDER[(i + 1) % PRESET_ORDER.length]!;
    this.setPreset(next);
    return next;
  }

  /** Small within-style drift: ramps partial gains/freqs over ~200 ms of audio. */
  nudge(): void {
    for (const st of this.parts) {
      st.gainStart = st.gain;
      st.freqStart = st.freqMul;
      st.gainTarget = st.gain * (1 + (this.rng() - 0.5) * 0.3); // ±15% level
      st.freqTarget = st.freqMul * (1 + (this.rng() - 0.5) * 0.02); // ±1% pitch
    }
    this.rampPos = 0;
    this.rampTotal = Math.max(1, Math.round((NUDGE_RAMP_MS * this.sr) / 1000));
  }

  /**
   * One seeded-random-duration chunk: 10–60 ms (capped by `maxMs`) of
   * interleaved stereo s16le. Phase-continuous across calls — the chunk is a
   * slice of one continuous int16 stream, so when `splitOdd` fires a chunk can
   * end (and the next can begin) mid-frame.
   */
  nextChunk(maxMs = MAX_CHUNK_MS): ArrayBuffer {
    const hi = Math.max(1, Math.min(MAX_CHUNK_MS, maxMs));
    const lo = Math.min(MIN_CHUNK_MS, hi);
    const ms = lo + this.rng() * (hi - lo);
    const frames = Math.max(1, Math.round((ms * this.sr) / 1000));

    const splitHere =
      this.splitOdd && this.chunksEmitted % SPLIT_EVERY_NTH_CHUNK === SPLIT_EVERY_NTH_CHUNK - 1;
    const int16Count = frames * CHANNELS + (splitHere ? 1 : 0);
    const buf = new ArrayBuffer(int16Count * BYTES_PER_SAMPLE);
    const view = new DataView(buf);

    for (let i = 0; i < int16Count; i++) {
      const channel = (this.streamPos & 1) as 0 | 1;
      if (channel === 0) this.stepModulators(); // once per frame, on the L sample
      const v = this.renderChannel(channel);
      view.setInt16(i * BYTES_PER_SAMPLE, v, true);
      this.streamPos++;
    }
    this.chunksEmitted++;
    return buf;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private applyPreset(): void {
    const def = PRESETS[this.presetName];
    this.def = def;
    this.lfoPhase = 0;
    this.lfoGain = 1;
    this.rampPos = 0;
    this.rampTotal = 0;
    let sum = 0;
    this.parts = def.partials.map((spec) => {
      sum += spec.gain;
      const det = Math.pow(2, spec.widthCents / 2400); // ± half the spread per side
      return {
        phase: [0, 0],
        detL: 1 / det,
        detR: det,
        gain: spec.gain,
        gainStart: spec.gain,
        gainTarget: spec.gain,
        freqMul: 1,
        freqStart: 1,
        freqTarget: 1,
      };
    });
    // Peak ≈ −18 dBFS at the LFO crest with all partials in phase.
    this.norm = PEAK_LINEAR / (sum * (1 + def.lfoDepth));
  }

  /** Per-frame modulation: amplitude LFO + the nudge interpolation ramp. */
  private stepModulators(): void {
    this.lfoGain = 1 + this.def.lfoDepth * Math.sin(TWO_PI * this.lfoPhase);
    this.lfoPhase += this.def.lfoHz / this.sr;
    if (this.lfoPhase >= 1) this.lfoPhase -= 1;

    if (this.rampPos < this.rampTotal) {
      const t = this.rampPos / this.rampTotal;
      for (const st of this.parts) {
        st.gain = st.gainStart + (st.gainTarget - st.gainStart) * t;
        st.freqMul = st.freqStart + (st.freqTarget - st.freqStart) * t;
      }
      this.rampPos++;
    } else {
      for (const st of this.parts) {
        st.gain = st.gainTarget;
        st.freqMul = st.freqTarget;
      }
    }
  }

  /** One channel sample as a quantized int16; advances that channel's phases. */
  private renderChannel(channel: 0 | 1): number {
    const { partials, rootHz } = this.def;
    let s = 0;
    for (let p = 0; p < partials.length; p++) {
      const spec = partials[p]!;
      const st = this.parts[p]!;
      const freq = rootHz * spec.ratio * st.freqMul * (channel === 0 ? st.detL : st.detR);
      const phase = st.phase[channel];
      s += st.gain * waveSample(spec.shape, phase);
      let next = phase + freq / this.sr;
      if (next >= 1) next -= 1;
      st.phase[channel] = next;
    }
    const q = Math.round(s * this.norm * this.lfoGain * 32767);
    return q > 32767 ? 32767 : q < -32768 ? -32768 : q;
  }
}

/** `phase` in cycles, 0 ≤ phase < 1. */
function waveSample(shape: WaveShape, phase: number): number {
  if (shape === 'triangle') return 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1;
  return Math.sin(TWO_PI * phase);
}
