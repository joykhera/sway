import type { MusicSessionController } from './contracts.ts';
import { useStreamLevels } from './use-stream-levels.ts';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Nearest equal-tempered note for a frequency, A4 = 440 Hz. */
export function noteName(hz: number): string {
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  const idx = ((midi % 12) + 12) % 12;
  return `${NOTE_NAMES[idx]}${Math.floor(midi / 12) - 1}`;
}

/**
 * The honest signal readout: dominant-partial pitch as Hz + nearest note,
 * spectral-brightness proxy, rendered energy, and buffer depth — everything
 * measured from real audio, nothing invented. ~10 Hz from `subscribeStats`.
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
  return <p className="telemetry">{parts.join(' · ')}</p>;
}
