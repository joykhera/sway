import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { MusicSessionController } from './contracts.ts';
import { useStreamLevels } from './use-stream-levels.ts';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Nearest equal-tempered note for a frequency, A4 = 440 Hz. */
export function noteName(hz: number): string {
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  const idx = ((midi % 12) + 12) % 12;
  return `${NOTE_NAMES[idx]}${Math.floor(midi / 12) - 1}`;
}

/** Lyria lands ~2 s blocks; the beam's period re-estimates from real gaps. */
const DEFAULT_GEN_PERIOD_MS = 2000;
/** Blocks closer together than this are one burst — one sweep, not a flicker. */
const MIN_SWEEP_GAP_MS = 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The honest signal readout: dominant-partial pitch as Hz + nearest note,
 * spectral-brightness proxy, rendered energy, and buffer depth — everything
 * measured from real audio, nothing invented. ~10 Hz from `subscribeStats`.
 *
 * Beneath it runs the generation beam: each newly landed audio block restarts
 * a phosphor sweep that runs fast then settles (ease-out), its head tinted by
 * the current pitch — a quiet measure line marking the stream's real cadence.
 */
export function TelemetryStrip({ controller }: { controller: MusicSessionController }) {
  const levels = useStreamLevels(controller);
  const pitch = levels.pitchHz !== null && levels.pitchHz > 20;
  const parts = [
    pitch
      ? `${Math.round(levels.pitchHz as number)} hz ${noteName(levels.pitchHz as number)}`
      : 'silent',
    `${(levels.brightnessHz / 1000).toFixed(1)} khz`,
    `${Math.round(levels.energy * 100)}%`,
    `buf ${(levels.bufferedMs / 1000).toFixed(1)} s`,
  ];
  if (levels.underruns > 0) parts.push(`${levels.underruns} dropout${levels.underruns === 1 ? '' : 's'}`);

  // A new block of generated music lands when `generation` bumps — the worklet
  // counts real PCM pushes, so the beam tracks the stream's true cadence.
  // Rapid pump-bursts (mock upstream's 100 ms pieces) collapse into one sweep:
  // a restart requires a real gap since the last beam start. Driven with WAAPI
  // rather than CSS keyframes so re-renders can't disturb a running sweep.
  const beamRef = useRef<HTMLSpanElement | null>(null);
  const prevGen = useRef({ seq: 0, at: 0, periodMs: DEFAULT_GEN_PERIOD_MS });
  useEffect(() => {
    const p = prevGen.current;
    const now = performance.now();
    if (levels.generation <= p.seq) return;
    p.seq = levels.generation;
    const gap = now - p.at;
    if (p.at !== 0 && gap < MIN_SWEEP_GAP_MS) return;
    if (p.at !== 0) {
      p.periodMs = clamp(0.6 * p.periodMs + 0.4 * gap, MIN_SWEEP_GAP_MS, 12000);
    }
    p.at = now;
    const el = beamRef.current;
    if (!el || typeof el.animate !== 'function') return;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(
      [{ width: '0%' }, { width: '100%' }],
      {
        duration: p.periodMs,
        easing: 'cubic-bezier(0.07, 0.9, 0.18, 1)',
        fill: 'forwards',
      },
    );
  }, [levels]);

  const pitchT = pitch ? clamp(Math.log2((levels.pitchHz as number) / 55) / 4, 0, 1) : 0.35;
  const beamStyle = {
    '--beam-hue': `${(36 + (208 - 36) * pitchT).toFixed(1)}`,
  } as CSSProperties;

  return (
    <div className="signal">
      <p className="telemetry">{parts.join(' · ')}</p>
      <div className="gen-beam" aria-hidden="true">
        <span className="gen-beam__fill" ref={beamRef} style={beamStyle} />
      </div>
    </div>
  );
}
