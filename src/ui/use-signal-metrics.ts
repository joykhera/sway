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

export type PitchJitter = {
  /**
   * σ (population standard deviation) of successive pitch differences in cents,
   * Δᵢ = 1200·log2(fᵢ / fᵢ₋₁), over consecutive voiced estimate pairs.
   */
  cents: number | null;
  /**
   * Relative period jitter in %: mean |Tᵢ − Tᵢ₋₁| / mean T × 100, with T = 1/f,
   * over the same consecutive voiced pairs.
   */
  percent: number | null;
};

const voiced = (hz: number | null | undefined): hz is number =>
  typeof hz === 'number' && Number.isFinite(hz) && hz > MIN_PITCH_HZ;

/**
 * Pitch jitter of a pitch-estimate sequence (oldest first). Only pairs of
 * consecutive voiced estimates count — a silent/null sample breaks the chain,
 * so a phrase gap can't masquerade as a pitch jump. Needs ≥ 2 such pairs;
 * otherwise both values are null.
 */
export function pitchJitter(pitches: readonly (number | null)[]): PitchJitter {
  const diffsCents: number[] = [];
  const periodDiffs: number[] = [];
  const periods = new Set<number>(); // indices of voiced samples that belong to a pair
  for (let i = 1; i < pitches.length; i++) {
    const a = pitches[i - 1];
    const b = pitches[i];
    if (!voiced(a) || !voiced(b)) continue;
    diffsCents.push(1200 * Math.log2(b / a));
    periodDiffs.push(Math.abs(1 / b - 1 / a));
    periods.add(i - 1);
    periods.add(i);
  }
  if (diffsCents.length < 2) return { cents: null, percent: null };

  const mean = diffsCents.reduce((s, d) => s + d, 0) / diffsCents.length;
  const variance = diffsCents.reduce((s, d) => s + (d - mean) ** 2, 0) / diffsCents.length;

  let periodSum = 0;
  for (const i of periods) periodSum += 1 / (pitches[i] as number);
  const meanPeriod = periodSum / periods.size;
  const meanAbsDelta = periodDiffs.reduce((s, d) => s + d, 0) / periodDiffs.length;

  return { cents: Math.sqrt(variance), percent: (meanAbsDelta / meanPeriod) * 100 };
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
  jitter: PitchJitter;
};

export type SignalMetricsOptions = {
  /** Window the jitter is computed over. Default 1500 ms. */
  jitterWindowMs?: number;
  /** How much history is kept (sparklines). Default 5000 ms. */
  historyMs?: number;
  now?: () => number;
};

const ZERO_LEVELS: StreamLevels = {
  energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0, generation: 0,
};
const EMPTY: SignalMetrics = {
  levels: ZERO_LEVELS, history: [], jitter: { cents: null, percent: null },
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
 * Live signal metrics: the latest `StreamLevels` plus a rolling history and
 * pitch jitter over the last ~1.5 s. Re-renders per stats tick — keep usage to
 * small text leaves (MetricsPanel), never the stage.
 */
export function useSignalMetrics(
  controller: MusicSessionController,
  options: SignalMetricsOptions = {},
): SignalMetrics {
  const { jitterWindowMs = 1500, historyMs = 5000 } = options;
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
        const recent = history.filter((s) => s.t >= t - jitterWindowMs).map((s) => s.pitchHz);
        cache.current = { levels, history, jitter: pitchJitter(recent) };
        onChange();
      });
    },
    [controller, historyMs, jitterWindowMs],
  );
  const getSnapshot = useCallback(() => cache.current, []);

  return useSyncExternalStore(subscribe, getSnapshot);
}
