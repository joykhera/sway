import { describe, expect, it } from 'vitest';
import { BandTracker, type AnalyserLike } from './audio-bands.ts';
import { DEFAULT_LOOK, lookForBlend, mixLook } from './looks.ts';

/** 1024 bins at 48 kHz → ~23.4 Hz per bin. `fill(hz)` returns the byte level at that frequency. */
function fakeAnalyser(fill: (hz: number) => number): AnalyserLike & { set(f: (hz: number) => number): void } {
  let current = fill;
  return {
    frequencyBinCount: 1024,
    context: { sampleRate: 48_000 },
    getByteFrequencyData(array) {
      for (let i = 0; i < array.length; i++) array[i] = current((i * 48_000) / 2048);
    },
    set(f) { current = f; },
  };
}

const frames = (tracker: BandTracker, analyser: AnalyserLike, n: number, t0 = 0) => {
  let bands = tracker.update(analyser, 1 / 60, t0);
  for (let i = 1; i < n; i++) bands = tracker.update(analyser, 1 / 60, t0 + i / 60);
  return bands;
};

describe('BandTracker', () => {
  it('breathes gently with no analyser', () => {
    const bands = new BandTracker().update(null, 1 / 60, 1);
    expect(bands.bass).toBeGreaterThan(0);
    expect(bands.beat).toBe(0);
  });

  it('auto-gains each band against its own recent range', () => {
    const tracker = new BandTracker();
    const analyser = fakeAnalyser(() => 60);
    frames(tracker, analyser, 120);
    analyser.set((hz) => (hz < 160 ? 200 : 60)); // bass jumps, the rest stays put
    const bands = frames(tracker, analyser, 30, 2);
    expect(bands.bass).toBeGreaterThan(0.8);
    expect(bands.mid).toBeLessThan(0.1);
  });

  it('fires a beat on a low-end onset, then decays', () => {
    const tracker = new BandTracker();
    const analyser = fakeAnalyser(() => 50);
    frames(tracker, analyser, 120);
    analyser.set((hz) => (hz < 300 ? 220 : 50));
    expect(tracker.update(analyser, 1 / 60, 2).beat).toBe(1);
    const later = frames(tracker, analyser, 60, 2.02);
    expect(later.beat).toBeLessThan(0.05);
  });
});

describe('looks', () => {
  it('falls back to the default look with nothing audible', () => {
    expect(lookForBlend({})).toEqual(DEFAULT_LOOK);
  });

  it('takes palette from mood and motion from genre', () => {
    const calm = lookForBlend({ ambient: 0.45, calm: 0.3 });
    const wild = lookForBlend({ electronic: 0.45, energetic: 0.3 });
    expect(calm.colorA).not.toEqual(wild.colorA);
    expect(wild.swirl).toBeGreaterThan(calm.swirl);
    expect(wild.trail).toBeLessThan(calm.trail);
  });

  it('blends by weight within a group', () => {
    const half = lookForBlend({ ambient: 1, electronic: 1 });
    const ambient = lookForBlend({ ambient: 1 });
    const electronic = lookForBlend({ electronic: 1 });
    expect(half.swirl).toBeCloseTo((ambient.swirl + electronic.swirl) / 2);
  });

  it('mixLook interpolates numbers and colors', () => {
    const a = lookForBlend({ calm: 1 });
    const b = lookForBlend({ energetic: 1 });
    expect(mixLook(a, b, 0)).toEqual(a);
    const mid = mixLook(a, b, 0.5);
    expect(mid.colorA[0]).toBeCloseTo((a.colorA[0] + b.colorA[0]) / 2);
    expect(mixLook(a, b, 1).colorA).toEqual(b.colorA);
  });
});
