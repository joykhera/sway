// Turns an analyser's spectrum into a few slow, musical control signals.
// Each band is auto-gained against its own recent floor and peak, so quiet
// ambient and loud electronic both use the full 0..1 range.

/** Structural slice of `AnalyserNode` so tests can feed synthetic spectra. */
export interface AnalyserLike {
  readonly frequencyBinCount: number;
  readonly context: { readonly sampleRate: number };
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
}

export type Bands = {
  /** Low end (30–160 Hz): swells the ring. */
  bass: number;
  /** Body (160 Hz–2 kHz): stirs the turbulence. */
  mid: number;
  /** Air (2–10 kHz): sparkle. */
  high: number;
  /** 1 on a detected onset, decaying over ~0.2 s. */
  beat: number;
};

type Range = { lo: number; hi: number };
const BASS: Range = { lo: 30, hi: 160 };
const MID: Range = { lo: 160, hi: 2000 };
const HIGH: Range = { lo: 2000, hi: 10000 };
const ONSET: Range = { lo: 30, hi: 300 };

/** Fraction of the gap closed in `dt` seconds by an exponential follower with time constant `tau`. */
const follow = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

class Band {
  private floor = 1;
  private peak = 0;
  private env = 0;

  /** `raw` is 0..1; returns the auto-gained, enveloped level. */
  update(raw: number, dt: number): number {
    this.peak = raw > this.peak ? raw : this.peak + (raw - this.peak) * follow(dt, 4);
    this.floor = raw < this.floor ? raw : this.floor + (raw - this.floor) * follow(dt, 8);
    const level = Math.min(1, Math.max(0, (raw - this.floor) / Math.max(this.peak - this.floor, 0.08)));
    // Fast attack, slower release: it breathes with the music instead of twitching.
    this.env += (level - this.env) * follow(dt, level > this.env ? 0.04 : 0.3);
    return this.env;
  }
}

export class BandTracker {
  private data: Uint8Array<ArrayBuffer> | null = null;
  private prev: Uint8Array<ArrayBuffer> | null = null;
  private readonly bass = new Band();
  private readonly mid = new Band();
  private readonly high = new Band();
  private fluxMean = 0;
  private fluxVar = 0;
  private beat = 0;
  private lastBeat = -Infinity;

  /** `now` in seconds. A null analyser (not playing yet) yields a slow idle breath. */
  update(analyser: AnalyserLike | null, dt: number, now: number): Bands {
    this.beat *= Math.exp(-dt / 0.2);
    if (!analyser) {
      return {
        bass: 0.25 + 0.15 * Math.sin(now * 0.7),
        mid: 0.3 + 0.1 * Math.sin(now * 0.43 + 1),
        high: 0.1,
        beat: this.beat,
      };
    }
    const bins = analyser.frequencyBinCount;
    if (this.data?.length !== bins) {
      this.data = new Uint8Array(bins);
      this.prev = new Uint8Array(bins);
    }
    const data = this.data;
    const prev = this.prev!;
    analyser.getByteFrequencyData(data);
    const hzPerBin = analyser.context.sampleRate / (bins * 2);
    const span = ({ lo, hi }: Range) =>
      [Math.max(1, Math.floor(lo / hzPerBin)), Math.min(bins - 1, Math.ceil(hi / hzPerBin))] as const;
    const average = (range: Range) => {
      const [a, b] = span(range);
      let sum = 0;
      for (let i = a; i <= b; i++) sum += data[i]!;
      return sum / ((b - a + 1) * 255);
    };

    // Spectral flux over the low end, against an adaptive threshold.
    const [a, b] = span(ONSET);
    let flux = 0;
    for (let i = a; i <= b; i++) flux += Math.max(0, data[i]! - prev[i]!);
    flux /= (b - a + 1) * 255;
    prev.set(data);
    const k = follow(dt, 1);
    const deviation = flux - this.fluxMean;
    this.fluxMean += deviation * k;
    this.fluxVar += (deviation * deviation - this.fluxVar) * k;
    if (flux > this.fluxMean + 2 * Math.sqrt(this.fluxVar) + 0.01 && now - this.lastBeat > 0.18) {
      this.beat = 1;
      this.lastBeat = now;
    }

    return {
      bass: this.bass.update(average(BASS), dt),
      mid: this.mid.update(average(MID), dt),
      high: this.high.update(average(HIGH), dt),
      beat: this.beat,
    };
  }
}
