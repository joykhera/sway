import type { ReactNode } from 'react';
import type { MusicSessionController } from './contracts.ts';
import {
  DBFS_FLOOR,
  MIN_PITCH_HZ,
  formatCents,
  nearestNote,
  toDbfs,
  useSignalMetrics,
} from './use-signal-metrics.ts';
import type { SignalSample } from './use-signal-metrics.ts';

const DASH = '—';
const SPARK_W = 72;
const SPARK_H = 14;
const HISTORY_MS = 5000;
/** Pitch sparkline spans A1..A6 on a log axis. */
const SPARK_PITCH_LO = 55;
const SPARK_PITCH_HI = 1760;

/**
 * Polyline segments for a sparkline over the last `spanMs` (x by time, ending at
 * the newest sample). Null values break the line instead of being interpolated.
 */
export function sparkSegments(
  history: readonly SignalSample[],
  value: (s: SignalSample) => number | null,
  lo: number,
  hi: number,
  spanMs = HISTORY_MS,
  w = SPARK_W,
  h = SPARK_H,
): string[] {
  const last = history[history.length - 1];
  if (!last) return [];
  const start = last.t - spanMs;
  const segments: string[] = [];
  let current: string[] = [];
  for (const s of history) {
    const v = value(s);
    if (v === null || !Number.isFinite(v)) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      continue;
    }
    const x = ((s.t - start) / spanMs) * w;
    const k = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    const y = h - 1 - k * (h - 2);
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(' '));
  return segments;
}

function Sparkline({ segments, label }: { segments: string[]; label: string }) {
  return (
    <svg
      className="metric__spark"
      data-spark={label}
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      aria-hidden="true"
      focusable="false"
    >
      {segments.map((points, i) => (
        <polyline key={i} points={points} />
      ))}
    </svg>
  );
}

function Metric({
  name,
  value,
  unit,
  sub,
  extra,
}: {
  name: string;
  value: string;
  unit?: string;
  sub?: ReactNode;
  extra?: ReactNode;
}) {
  const empty = value === DASH;
  return (
    <div className={`metric${empty ? ' metric--empty' : ''}`} data-metric={name}>
      <dt className="metric__label">{name}</dt>
      <dd className="metric__body">
        <span className="metric__value">
          {value}
          {unit && !empty ? <span className="metric__unit"> {unit}</span> : null}
        </span>
        {sub ? <span className="metric__sub">{sub}</span> : null}
        {extra}
      </dd>
    </div>
  );
}

/**
 * Top-right readout of measured signal quantities, ~10 Hz from `subscribeStats`:
 * pitch (Hz, nearest note, cents), RMS level (dBFS + meter), pitch jitter
 * (σ of successive Δcents; relative period jitter %), spectral brightness,
 * and buffer health. `—` whenever the measurement is silent or absent.
 */
export function MetricsPanel({ controller }: { controller: MusicSessionController }) {
  const { levels, history, jitter } = useSignalMetrics(controller, { historyMs: HISTORY_MS });

  const hz = levels.pitchHz !== null && levels.pitchHz > MIN_PITCH_HZ ? levels.pitchHz : null;
  const note = hz !== null ? nearestNote(hz) : null;
  const db = toDbfs(levels.energy);
  const meter = db === null ? 0 : (db - DBFS_FLOOR) / -DBFS_FLOOR;

  const pitchSpark = sparkSegments(
    history,
    (s) => (s.pitchHz !== null && s.pitchHz > MIN_PITCH_HZ ? Math.log2(s.pitchHz) : null),
    Math.log2(SPARK_PITCH_LO),
    Math.log2(SPARK_PITCH_HI),
  );
  const levelSpark = sparkSegments(history, (s) => toDbfs(s.energy), DBFS_FLOOR, 0);

  return (
    <section className="metrics" aria-label="signal metrics">
      <dl className="metrics__list">
        <Metric
          name="pitch"
          value={hz !== null ? hz.toFixed(1) : DASH}
          unit="Hz"
          sub={note ? `${note.name} ${formatCents(note.cents)}` : undefined}
          extra={<Sparkline segments={pitchSpark} label="pitch" />}
        />
        <Metric
          name="level"
          value={db !== null ? db.toFixed(1).replace('-', '−') : DASH}
          unit="dBFS"
          extra={
            <>
              <span className="metric__meter" aria-hidden="true">
                <span className="metric__meter-fill" style={{ width: `${(meter * 100).toFixed(1)}%` }} />
              </span>
              <Sparkline segments={levelSpark} label="level" />
            </>
          }
        />
        <Metric
          name="jitter"
          value={jitter.cents !== null ? jitter.cents.toFixed(1) : DASH}
          unit="¢"
          sub={jitter.percent !== null ? `${jitter.percent.toFixed(2)} %` : undefined}
        />
        <Metric
          name="brightness"
          value={levels.brightnessHz > 0 ? (levels.brightnessHz / 1000).toFixed(2) : DASH}
          unit="kHz"
        />
        <Metric name="buffer" value={(levels.bufferedMs / 1000).toFixed(2)} unit="s" />
        <Metric name="dropouts" value={String(levels.underruns)} />
        <Metric name="blocks" value={String(levels.generation)} />
      </dl>
    </section>
  );
}
