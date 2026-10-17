// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MusicSessionController, StreamLevels } from './contracts.ts';
import { MetricsPanel } from './MetricsPanel.tsx';
import { estimateTempoBpm, useSignalMetrics } from './use-signal-metrics.ts';

afterEach(cleanup);

const ZERO: StreamLevels = {
  energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0, generation: 0,
};

/** Minimal controller: emits the given stats synchronously on subscribe, then on demand. */
function makeController(initial: Partial<StreamLevels> = {}) {
  const levels: StreamLevels = { ...ZERO, ...initial };
  let listener: ((l: StreamLevels) => void) | null = null;
  const controller: MusicSessionController = {
    start: () => Promise.resolve(),
    vote: () => { },
    stop: () => { },
    subscribe: () => () => { },
    subscribeStats: (l) => {
      listener = l;
      l(levels);
      return () => {
        listener = null;
      };
    },
  };
  return {
    controller,
    emit(patch: Partial<StreamLevels>) {
      Object.assign(levels, patch);
      listener?.(levels);
    },
  };
}

describe('MetricsPanel', () => {
  it('shows exactly three metrics: pitch, level, tempo', () => {
    const { controller } = makeController({ pitchHz: 440, energy: 0.5 });
    const { container } = render(<MetricsPanel controller={controller} />);
    const names = [...container.querySelectorAll('[data-metric]')].map((el) =>
      el.getAttribute('data-metric'),
    );
    expect(names).toEqual(['pitch', 'level', 'tempo']);
    for (const gone of ['jitter', 'brightness', 'buffer', 'dropouts', 'blocks']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('formats pitch as Hz + nearest note + cents, level as dBFS', () => {
    const { controller } = makeController({ pitchHz: 440, energy: 0.5 });
    const { container } = render(<MetricsPanel controller={controller} />);

    const pitch = container.querySelector('[data-metric="pitch"]');
    expect(pitch?.textContent).toContain('440.0');
    expect(pitch?.textContent).toContain('A4');
    expect(pitch?.textContent).toContain('±0¢');

    const level = container.querySelector('[data-metric="level"]');
    // 20·log10(0.5) ≈ −6.02 dBFS (typographic minus)
    expect(level?.textContent).toContain('−6.0');
    expect(level?.textContent).toContain('dBFS');
  });

  it('shows — for tempo until enough periodic energy history accumulates', () => {
    const { controller } = makeController({ pitchHz: 440, energy: 0.5 });
    const { container } = render(<MetricsPanel controller={controller} />);
    const tempo = container.querySelector('[data-metric="tempo"]');
    expect(tempo?.textContent).toContain('—');
    expect(tempo?.textContent).not.toContain('BPM');
  });

  it('shows — for pitch when the estimate is absent', () => {
    const { controller } = makeController({ pitchHz: null, energy: 0 });
    const { container } = render(<MetricsPanel controller={controller} />);
    const pitch = container.querySelector('[data-metric="pitch"]');
    expect(pitch?.textContent).toContain('—');
  });
});

describe('estimateTempoBpm', () => {
  const FS = 10; // stats feed ticks ~10 Hz
  const times = (seconds: number) =>
    Array.from({ length: Math.round(seconds * FS) }, (_, i) => i / FS);

  it('finds a 120 BPM sinusoidal energy envelope', () => {
    const energy = times(12).map((t) => 0.5 + 0.4 * Math.sin(2 * Math.PI * 2 * t)); // 2 Hz = 120 BPM
    const bpm = estimateTempoBpm(energy, FS);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 120)).toBeLessThan(3);
  });

  it('finds percussive beats (energy spikes every 0.5 s → 120 BPM)', () => {
    const energy = times(12).map((_, i) => (i % 5 === 0 ? 1 : 0.05));
    const bpm = estimateTempoBpm(energy, FS);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 120)).toBeLessThan(3);
  });

  it('resolves a 90 BPM envelope', () => {
    const energy = times(12).map((t) => 0.5 + 0.4 * Math.sin(2 * Math.PI * 1.5 * t)); // 1.5 Hz = 90 BPM
    const bpm = estimateTempoBpm(energy, FS);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 90)).toBeLessThan(3);
  });

  it('returns null for a flat envelope', () => {
    expect(estimateTempoBpm(new Array(120).fill(0.5), FS)).toBeNull();
  });

  it('returns null for silence', () => {
    expect(estimateTempoBpm(new Array(120).fill(0), FS)).toBeNull();
  });

  it('returns null with too little history', () => {
    const energy = times(3).map((t) => 0.5 + 0.4 * Math.sin(2 * Math.PI * 2 * t));
    expect(estimateTempoBpm(energy, FS)).toBeNull();
  });

  it('returns null for uncorrelated noise — no periodicity, no number', () => {
    let s = 12345; // deterministic LCG pseudo-noise
    const energy = Array.from(
      { length: 120 },
      () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648,
    );
    expect(estimateTempoBpm(energy, FS)).toBeNull();
  });

  it('returns null for a slow swell whose period lies outside 40–200 BPM', () => {
    // 0.09 Hz ≈ 5 BPM: its autocorrelation declines monotonically across the
    // searched lag range — there is no in-range peak to report.
    const energy = times(12).map((t) => 0.5 + 0.4 * Math.sin(2 * Math.PI * 0.09 * t));
    expect(estimateTempoBpm(energy, FS)).toBeNull();
  });
});

describe('useSignalMetrics', () => {
  function feed(emit: (p: Partial<StreamLevels>) => void, energyAt: (now: number) => number) {
    let now = 0;
    return {
      now: () => now,
      tick() {
        now += 100; // 10 Hz
        emit({ energy: energyAt(now / 1000) });
      },
    };
  }

  it('estimates tempo from the live energy feed once enough history exists', () => {
    const { controller, emit } = makeController();
    const clock = feed(emit, (t) => 0.5 + 0.4 * Math.sin(2 * Math.PI * 2 * t)); // 120 BPM
    const { result } = renderHook(() =>
      useSignalMetrics(controller, { historyMs: 12_000, now: clock.now }),
    );
    act(() => {
      for (let i = 0; i < 120; i++) clock.tick();
    });
    expect(result.current.tempo).not.toBeNull();
    expect(Math.abs(result.current.tempo! - 120)).toBeLessThan(5);
  });

  it('keeps tempo null when the energy envelope has no periodicity', () => {
    const { controller, emit } = makeController();
    const clock = feed(emit, () => 0.5); // steady level, no beat
    const { result } = renderHook(() =>
      useSignalMetrics(controller, { historyMs: 12_000, now: clock.now }),
    );
    act(() => {
      for (let i = 0; i < 120; i++) clock.tick();
    });
    expect(result.current.tempo).toBeNull();
  });
});
