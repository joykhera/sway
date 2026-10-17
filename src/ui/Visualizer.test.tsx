// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MusicSessionController,
  SessionUiState,
  StreamLevels,
  Vote,
} from './contracts.ts';
import { BASE_PARAMS, PALETTE, PUNCH, Visualizer, paramsForSignature, stepPunch } from './Visualizer.tsx';

afterEach(cleanup);

const LEVELS: StreamLevels = {
  energy: 0.5,
  brightnessHz: 2400,
  pitchHz: 220,
  bufferedMs: 900,
  underruns: 0,
  generation: 0,
};

const PLAYING: SessionUiState = {
  status: 'playing',
  signature: { genre: 'ambient', mood: 'calm', instrument: 'felt piano' },
};

function makeFake(withStats = true) {
  const stateListeners = new Set<(s: SessionUiState) => void>();
  const statsListeners = new Set<(l: StreamLevels) => void>();
  const controller: MusicSessionController = {
    start: vi.fn(() => Promise.resolve()),
    vote: vi.fn<(v: Vote) => void>(),
    stop: vi.fn(),
    subscribe(listener) {
      stateListeners.add(listener);
      listener(PLAYING);
      return () => stateListeners.delete(listener);
    },
  };
  if (withStats) {
    controller.subscribeStats = (listener) => {
      statsListeners.add(listener);
      listener(LEVELS);
      return () => statsListeners.delete(listener);
    };
  }
  return {
    controller,
    stateListeners,
    statsListeners,
    emitState: (s: SessionUiState) => { for (const l of [...stateListeners]) l(s); },
    emitStats: (l: StreamLevels) => { for (const fn of [...statsListeners]) fn(l); },
  };
}

// jsdom has no WebGL — the component renders its calm-fallback container.
const getStage = (container: HTMLElement) => container.querySelector('.visualizer');

describe('Visualizer', () => {
  it('renders a stage-filling container', () => {
    const { container } = render(<Visualizer active={true} />);
    const el = getStage(container);
    expect(el).toBeTruthy();
    expect(el?.getAttribute('aria-hidden')).toBe('true');
  });

  it('registers state and stats subscriptions on mount', () => {
    const f = makeFake();
    render(<Visualizer active={true} controller={f.controller} />);
    expect(f.stateListeners.size).toBe(1);
    expect(f.statsListeners.size).toBe(1);
  });

  it('unsubscribes from both feeds on unmount', () => {
    const f = makeFake();
    const { unmount } = render(<Visualizer active={true} controller={f.controller} />);
    unmount();
    expect(f.stateListeners.size).toBe(0);
    expect(f.statsListeners.size).toBe(0);
    act(() => {
      f.emitStats(LEVELS);
      f.emitState({ status: 'stopped' });
    });
  });

  it('works when the controller lacks subscribeStats', () => {
    const f = makeFake(false);
    const { container, unmount } = render(<Visualizer active={true} controller={f.controller} />);
    expect(getStage(container)).toBeTruthy();
    act(() => f.emitState({ status: 'playing', signature: { genre: 'techno' } }));
    unmount();
    expect(f.stateListeners.size).toBe(0);
  });

  it('absorbs stats ticks, signature morphs, and votes without crashing', () => {
    const f = makeFake();
    const { rerender } = render(<Visualizer active={true} controller={f.controller} />);
    act(() => {
      f.emitStats({ ...LEVELS, energy: 0.9, pitchHz: 440, generation: 3 });
      f.emitState({ status: 'playing', signature: { genre: 'techno', mood: 'driving' } });
    });
    rerender(<Visualizer active={true} controller={f.controller} lastVote={{ v: 'up', at: Date.now() }} />);
    rerender(<Visualizer active={true} controller={f.controller} lastVote={{ v: 'down', at: Date.now() + 1 }} />);
    rerender(<Visualizer active={true} controller={f.controller} lastVote={null} />);
    expect(getStage(document.querySelector('.app') as HTMLElement ?? document.body)).toBeTruthy();
  });
});

describe('paramsForSignature', () => {
  it('falls back to the base anatomy without a signature', () => {
    expect(paramsForSignature(undefined)).toEqual(BASE_PARAMS);
    expect(paramsForSignature({})).toEqual(BASE_PARAMS);
  });

  it('is deterministic per signature text', () => {
    const a = paramsForSignature({ genre: 'ambient', mood: 'calm' });
    const b = paramsForSignature({ mood: 'calm', genre: 'ambient' });
    expect(a).toEqual(b);
  });

  it('calm signatures drift slower and sit softer than hype ones', () => {
    const calm = paramsForSignature({ mood: 'calm ambient soft' });
    const hype = paramsForSignature({ mood: 'energetic driving hype' });
    expect(calm.speed).toBeLessThan(hype.speed);
    expect(calm.distort).toBeLessThan(hype.distort);
    expect(calm.drift).toBeLessThan(hype.drift);
  });

  it('warm signatures bias the film hue opposite cool ones', () => {
    const warm = paramsForSignature({ mood: 'warm golden' });
    const cool = paramsForSignature({ mood: 'cold blue night' });
    expect(warm.hueBias).toBeLessThan(0);
    expect(cool.hueBias).toBeGreaterThan(0);
  });

  it('clamps every knob to its safe range', () => {
    const p = paramsForSignature({ genre: 'x', focus: 'energetic hype fast intense warm cool granular' });
    expect(p.distort).toBeGreaterThanOrEqual(0.12);
    expect(p.distort).toBeLessThanOrEqual(0.6);
    expect(p.speed).toBeGreaterThanOrEqual(0.6);
    expect(p.speed).toBeLessThanOrEqual(3.4);
    expect(Math.abs(p.hueBias)).toBeLessThanOrEqual(160);
  });
});

/** Relative luminance (sRGB luma) of a #rrggbb color, 0..1. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

describe('PALETTE', () => {
  it('keeps the organism light — every swatch is high-luminance', () => {
    expect(luminance(PALETTE.body)).toBeGreaterThan(0.85);
    expect(luminance(PALETTE.orb)).toBeGreaterThan(0.8);
    for (const form of [PALETTE.formTop, PALETTE.formLeft, PALETTE.formRight, PALETTE.formBottom]) {
      expect(luminance(form)).toBeGreaterThan(0.75);
    }
  });
});

describe('vote punch spring', () => {
  it('displaces continuously — no pop at trigger time', () => {
    const s = { x: 0, v: 0 };
    s.v += PUNCH.impulse; // a vote injects velocity only
    const step = 1 / 60;
    stepPunch(s, step);
    // first frame moves a little, never snaps to full amplitude
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(step * PUNCH.impulse * 1.5);
  });

  it('peaks fast, then settles back to rest in about a second', () => {
    const s = { x: 0, v: PUNCH.impulse };
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      stepPunch(s, 1 / 60);
      peak = Math.max(peak, Math.abs(s.x));
    }
    expect(peak).toBeGreaterThan(0.4); // a felt strike…
    expect(peak).toBeLessThan(1.2); // …but bounded
    expect(Math.abs(s.x)).toBeLessThan(0.01); // fully settled well before 4 s
  });

  it('a second vote mid-flight adds energy without snapping position', () => {
    const s = { x: 0, v: PUNCH.impulse };
    for (let i = 0; i < 10; i++) stepPunch(s, 1 / 60);
    const xBefore = s.x;
    s.v += PUNCH.impulse; // re-punch
    expect(s.x).toBe(xBefore); // position untouched — only velocity changed
    stepPunch(s, 1 / 60);
    expect(Math.abs(s.x - xBefore)).toBeLessThan(0.4); // still a smooth step
    for (let i = 0; i < 400; i++) stepPunch(s, 1 / 60);
    expect(Math.abs(s.x)).toBeLessThan(0.01); // double-tap still settles
  });
});
