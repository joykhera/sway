import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { MusicSessionController, StreamLevels } from './contracts.ts';

// Honest signal math for the metrics panel. Every number shown is derived from
// measured `StreamLevels` (controller.subscribeStats, ~10 Hz) — nothing invented.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Lowest pitch the readout trusts; below this the estimate is treated as silence. */
export const MIN_PITCH_HZ = 20;
/** dBFS floor: quieter than this reads as the floor value. */
export const DBFS_FLOOR = -60;

export type NearestNote = {
  /** e.g. `A4` (A4 = 440 Hz, equal temperament). */
  name: string;
  midi: number;
  /** Signed offset from the nearest note, rounded to whole cents (−50..+50). */
  cents: number;
};

/** Nearest equal-tempered note and cents offset for a frequency, A4 = 440 Hz. */
export function nearestNote(hz: number): NearestNote {
  const exact = 12 * Math.log2(hz / 440) + 69;
  const midi = Math.round(exact);
  const idx = ((midi % 12) + 12) % 12;
  const cents = Math.round((exact - midi) * 100);
  return { name: `${NOTE_NAMES[idx]}${Math.floor(midi / 12) - 1}`, midi, cents: cents === 0 ? 0 : cents };
}

/** Nearest equal-tempered note name for a frequency, A4 = 440 Hz. */
export function noteName(hz: number): string {
  return nearestNote(hz).name;
}

/** `+3¢` / `−12¢` / `±0¢` — typographic minus, explicit sign. */
export function formatCents(cents: number): string {
  if (cents === 0) return '±0¢';
  return `${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

/**
 * RMS amplitude (0..1, full scale = 1) → dBFS: 20·log10(rms), floored at
 * {@link DBFS_FLOOR}. Null when there is no signal at all (rms ≤ 0 / NaN).
 */
export function toDbfs(rms: number, floor = DBFS_FLOOR): number | null {
  if (!Number.isFinite(rms) || rms <= 0) return null;
  return Math.max(floor, 20 * Math.log10(rms));
}

/** Slowest tempo the estimator will report. */
export const TEMPO_MIN_BPM = 40;
/** Fastest tempo the estimator will report. */
export const TEMPO_MAX_BPM = 200;
/** Seconds of energy history required before a tempo estimate is attempted. */
export const TEMPO_MIN_SECONDS = 8;
/**
 * Normalized autocorrelation peak required to report a tempo. Below this the
 * energy envelope has no clear periodicity and the honest answer is nothing.
 */
export const TEMPO_MIN_CONFIDENCE = 0.35;
/** EMA weight applied to each new raw tempo estimate (per stats tick). */
const TEMPO_EMA_ALPHA = 0.25;

export type TempoOptions = {
  minBpm?: number;
  maxBpm?: number;
  /** Seconds of history required before estimating. Default {@link TEMPO_MIN_SECONDS}. */
  minSeconds?: number;
  /** Autocorrelation peak required to report. Default {@link TEMPO_MIN_CONFIDENCE}. */
  minConfidence?: number;
};

/**
 * Tempo estimate from the energy/RMS envelope via autocorrelation — the classic
 * beat-periodicity approach. The envelope is mean-subtracted, then correlated
 * against itself at every lag whose implied tempo falls in `minBpm..maxBpm`.
 * A lag wins only if it is a *strict local maximum* of the correlation (so a
 * slow swell or drift whose true period lies outside the range can't win by
 * sitting at the nearest boundary) AND its normalized correlation clears
 * `minConfidence`. A parabola through the peak and its neighbours then refines
 * the lag to sub-sample resolution. Returns null for silence, a flat envelope,
 * too little history, or no clear periodicity — never an invented number.
 *
 * `energies` is oldest-first, assumed ~uniformly sampled at `sampleRateHz`
 * (the stats feed ticks ~10 Hz, so this is a coarse but honest estimate).
 */
export function estimateTempoBpm(
  energies: readonly number[],
  sampleRateHz: number,
  options: TempoOptions = {},
): number | null {
  const {
    minBpm = TEMPO_MIN_BPM,
    maxBpm = TEMPO_MAX_BPM,
    minSeconds = TEMPO_MIN_SECONDS,
    minConfidence = TEMPO_MIN_CONFIDENCE,
  } = options;

  const n = energies.length;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return null;
  if (n < Math.ceil(sampleRateHz * minSeconds)) return null;

  let mean = 0;
  for (const e of energies) mean += e;
  mean /= n;
  const x = new Float64Array(n);
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const v = energies[i]! - mean;
    x[i] = v;
    varSum += v * v;
  }
  if (varSum < 1e-12) return null; // flat envelope → no beat information

  const acf = (lag: number): number => {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i]! * x[i + lag]!;
    return s / varSum;
  };

  // ±1 slack on the lag bounds so neighbours always exist for the
  // strict-local-max check and the parabolic refinement below.
  const lagMin = Math.max(2, Math.round((60 * sampleRateHz) / maxBpm));
  const lagMax = Math.min(n - 2, Math.floor((60 * sampleRateHz) / minBpm));
  if (lagMax < lagMin) return null;

  let bestLag = -1;
  let best = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const v = acf(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || best < minConfidence) return null;

  // The peak must beat its immediate neighbours — proof of in-range
  // periodicity, not the shoulder of an out-of-range period or drift.
  const y0 = acf(bestLag - 1);
  const y2 = acf(bestLag + 1);
  if (!(best > y0 && best > y2)) return null;

  // Sub-sample refinement: vertex of the parabola through the acf peak.
  let lag = bestLag;
  const denom = y0 - 2 * best + y2;
  if (denom < 0) {
    const shift = (0.5 * (y0 - y2)) / denom;
    lag = bestLag + Math.max(-0.5, Math.min(0.5, shift));
  }

  const bpm = (60 * sampleRateHz) / lag;
  if (!Number.isFinite(bpm) || bpm < minBpm || bpm > maxBpm) return null;
  return bpm;
}

export type SignalSample = {
  /** performance.now()-style ms timestamp. */
  t: number;
  pitchHz: number | null;
  energy: number;
};

export type SignalMetrics = {
  levels: StreamLevels;
  /** Rolling sample history, oldest first, spanning ≤ `historyMs`. */
  history: readonly SignalSample[];
  /**
   * Smoothed tempo estimate in BPM from the energy envelope, or null until
   * enough history exists / when no clear beat periodicity is present.
   */
  tempo: number | null;
};

export type SignalMetricsOptions = {
  /**
   * How much history is kept (sparklines + tempo estimation — tempo needs
   * ~10–12 s of energy samples to see several bars). Default 5000 ms.
   */
  historyMs?: number;
  now?: () => number;
};

const ZERO_LEVELS: StreamLevels = {
  energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0, generation: 0,
};
const EMPTY: SignalMetrics = {
  levels: ZERO_LEVELS, history: [], tempo: null,
};

/** Append a sample and drop everything older than `historyMs` (pure). */
export function pushSample(
  history: readonly SignalSample[],
  sample: SignalSample,
  historyMs: number,
): SignalSample[] {
  const cutoff = sample.t - historyMs;
  const next = history.filter((s) => s.t >= cutoff && s.t <= sample.t);
  next.push(sample);
  return next;
}

/**
 * Live signal metrics: the latest `StreamLevels`, a rolling history (sparkline
 * source), and a tempo estimate autocorrelated from the energy envelope and
 * EMA-smoothed across ticks. Re-renders per stats tick — keep usage to small
 * text leaves (MetricsPanel), never the stage.
 */
export function useSignalMetrics(
  controller: MusicSessionController,
  options: SignalMetricsOptions = {},
): SignalMetrics {
  const { historyMs = 5000 } = options;
  const nowRef = useRef(options.now);
  nowRef.current = options.now;
  const cache = useRef<SignalMetrics>(EMPTY);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!controller.subscribeStats) return () => { };
      return controller.subscribeStats((levels) => {
        const t = (nowRef.current ?? (() => performance.now()))();
        const history = pushSample(
          cache.current.history,
          { t, pitchHz: levels.pitchHz, energy: levels.energy },
          historyMs,
        );

        // Effective sample rate from the actual timestamps — the feed is
        // ~10 Hz but not contractually exact, so measure rather than assume.
        const first = history[0];
        const last = history[history.length - 1];
        const spanMs = first && last ? last.t - first.t : 0;
        const sampleRateHz = spanMs > 0 ? ((history.length - 1) / spanMs) * 1000 : 0;

        const raw = estimateTempoBpm(history.map((s) => s.energy), sampleRateHz);
        const prev = cache.current.tempo;
        const tempo =
          raw === null ? null : prev === null ? raw : prev + TEMPO_EMA_ALPHA * (raw - prev);

        cache.current = { levels, history, tempo };
        onChange();
      });
    },
    [controller, historyMs],
  );
  const getSnapshot = useCallback(() => cache.current, []);

  return useSyncExternalStore(subscribe, getSnapshot);
}
