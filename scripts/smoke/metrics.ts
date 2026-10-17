/** Pure metric helpers for the Lyria smoke test. */

export const BURST_THRESHOLD = 1.1;

/** Audio seconds received per wall second. null when wall time is not positive. */
export function burstRatio(audioSec: number, wallSec: number): number | null {
  if (!(wallSec > 0) || !Number.isFinite(audioSec)) return null;
  return audioSec / wallSec;
}

/**
 * True when at least `minRun` consecutive ratios exceed `threshold`
 * (nulls break a run).
 */
export function sustainedAbove(
  ratios: ReadonlyArray<number | null>,
  threshold = BURST_THRESHOLD,
  minRun = 3,
): boolean {
  let run = 0;
  for (const r of ratios) {
    if (r !== null && r > threshold) {
      run++;
      if (run >= minRun) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

export interface Summary {
  count: number;
  min: number;
  median: number;
  max: number;
  mean: number;
}

export function summarize(values: ReadonlyArray<number>): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return { count: n, min: sorted[0] ?? 0, median, max: sorted[n - 1] ?? 0, mean: sum / n };
}

/** Differences between consecutive values (e.g. chunk arrival gaps). */
export function diffs(values: ReadonlyArray<number>): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    out.push((values[i] ?? 0) - (values[i - 1] ?? 0));
  }
  return out;
}

/** "m:ss.s" for a millisecond offset. */
export function fmtOffset(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
