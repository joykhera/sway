// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicSessionController, SessionUiState, StreamLevels, Vote } from './contracts.ts';
import {
  displayFill,
  FALLBACK_FILL_MS,
  FILL_FADE_MS,
  FILL_HOLD_MS,
  ThumbsControls,
} from './ThumbsControls.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const UP = "like what you're hearing";
const DOWN = 'hear something different';
const noop = () => { };

const BASE: StreamLevels = { energy: 0.3, brightnessHz: 900, pitchHz: 220, bufferedMs: 2000, underruns: 0, generation: 1 };

function makeFake() {
  const statsListeners = new Set<(l: StreamLevels) => void>();
  const controller: MusicSessionController = {
    start: vi.fn(() => Promise.resolve()),
    vote: vi.fn<(v: Vote) => void>(),
    stop: vi.fn(),
    subscribe(listener: (s: SessionUiState) => void) {
      listener({ status: 'playing' });
      return () => { };
    },
    subscribeStats(listener) {
      statsListeners.add(listener);
      listener(BASE);
      return () => statsListeners.delete(listener);
    },
  };
  return {
    controller,
    steer: (steerProgress: number | null, steerVote: Vote | null) =>
      act(() => {
        for (const fn of [...statsListeners]) fn({ ...BASE, steerProgress, steerVote });
      }),
  };
}

function renderThumbs(props: Partial<Parameters<typeof ThumbsControls>[0]> = {}) {
  return render(<ThumbsControls onVote={noop} lastVote={null} {...props} />);
}

const fillOf = (el: HTMLElement) => Number(el.style.getPropertyValue('--fill') || '0');
const live = () => screen.getByRole('status');

describe('displayFill', () => {
  it('eases out, holds below full until progress is exactly 1', () => {
    expect(displayFill(0)).toBe(0);
    expect(displayFill(0.2)).toBeGreaterThan(0.2); // fast start
    expect(displayFill(0.5)).toBeCloseTo(0.875, 3);
    expect(displayFill(0.9)).toBeLessThan(0.97);
    expect(displayFill(0.999)).toBeLessThan(1);
    expect(displayFill(1)).toBe(1);
    expect(displayFill(Number.NaN)).toBe(0);
  });
});

describe('ThumbsControls', () => {
  it('renders both buttons with their aria labels', () => {
    renderThumbs();
    expect(screen.getByLabelText(UP)).toBeTruthy();
    expect(screen.getByLabelText(DOWN)).toBeTruthy();
  });

  it('buttons are never disabled', () => {
    renderThumbs();
    for (const label of [UP, DOWN]) {
      const btn = screen.getByLabelText(label) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.type).toBe('button');
    }
  });

  it('fires onVote("up") and onVote("down") synchronously', () => {
    const onVote = vi.fn();
    renderThumbs({ onVote });
    fireEvent.click(screen.getByLabelText(UP));
    expect(onVote).toHaveBeenCalledTimes(1);
    expect(onVote).toHaveBeenLastCalledWith('up');
    fireEvent.click(screen.getByLabelText(DOWN));
    expect(onVote).toHaveBeenCalledTimes(2);
    expect(onVote).toHaveBeenLastCalledWith('down');
    expect((screen.getByLabelText(DOWN) as HTMLButtonElement).disabled).toBe(false);
  });

  it('applies the voted class on the matching side only', () => {
    const { rerender } = renderThumbs();
    const up = screen.getByLabelText(UP);
    const down = screen.getByLabelText(DOWN);
    expect(up.className).not.toContain('thumb--voted');
    expect(down.className).not.toContain('thumb--voted');

    rerender(<ThumbsControls onVote={noop} lastVote={{ v: 'down', at: 123 }} />);
    expect(down.className).toContain('thumb--voted');
    expect(up.className).not.toContain('thumb--voted');

    rerender(<ThumbsControls onVote={noop} lastVote={{ v: 'up', at: 124 }} />);
    expect(up.className).toContain('thumb--voted');
    expect(down.className).not.toContain('thumb--voted');

    rerender(<ThumbsControls onVote={noop} lastVote={null} />);
    expect(up.className).not.toContain('thumb--voted');
    expect(down.className).not.toContain('thumb--voted');
  });

  it('fills the clicked lens from controller steerProgress, completes at 1, then clears', () => {
    vi.useFakeTimers();
    const f = makeFake();
    const onVote = vi.fn();
    renderThumbs({ onVote, controller: f.controller });
    const up = screen.getByLabelText(UP);
    const down = screen.getByLabelText(DOWN);
    expect(up.getAttribute('aria-busy')).toBeNull();
    expect(live().textContent).toBe('');

    fireEvent.click(up);
    expect(onVote).toHaveBeenCalledWith('up');
    expect(up.getAttribute('aria-busy')).toBe('true');
    expect(down.getAttribute('aria-busy')).toBeNull();
    expect(up.className).toContain('thumb--filling');
    expect(live().textContent).toBe('changing…');

    f.steer(0.1, 'up');
    const a = fillOf(up);
    f.steer(0.4, 'up');
    const b = fillOf(up);
    f.steer(0.8, 'up');
    const c = fillOf(up);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThan(1);
    expect(up.dataset.deep).toBeDefined(); // glyph inverts past ~60%
    expect(fillOf(down)).toBe(0);

    // The local fallback timer must not override the real feed.
    act(() => vi.advanceTimersByTime(FALLBACK_FILL_MS + 500));
    expect(up.getAttribute('aria-busy')).toBe('true');
    expect(fillOf(up)).toBe(c);

    f.steer(1, 'up');
    expect(fillOf(up)).toBe(1);
    expect(up.getAttribute('aria-busy')).toBeNull();
    expect(up.className).toContain('thumb--done');
    expect(live().textContent).toBe('now playing your change');

    // Lingering p===1 samples after completion don't restart anything.
    f.steer(1, 'up');
    act(() => vi.advanceTimersByTime(FILL_HOLD_MS));
    expect(up.className).toContain('thumb--fading');
    act(() => vi.advanceTimersByTime(FILL_FADE_MS));
    expect(up.className).not.toContain('thumb--fading');
    expect(up.className).not.toContain('thumb--done');
    expect(fillOf(up)).toBe(0);
    expect(live().textContent).toBe('');

    f.steer(null, null);
    expect(up.getAttribute('aria-busy')).toBeNull();
  });

  it('a new vote restarts the fill on the clicked lens and clears the other', () => {
    const f = makeFake();
    renderThumbs({ controller: f.controller });
    const up = screen.getByLabelText(UP);
    const down = screen.getByLabelText(DOWN);

    fireEvent.click(up);
    f.steer(0.5, 'up');
    expect(fillOf(up)).toBeGreaterThan(0);

    fireEvent.click(down);
    expect(fillOf(up)).toBe(0);
    expect(up.getAttribute('aria-busy')).toBeNull();
    expect(down.getAttribute('aria-busy')).toBe('true');

    f.steer(0.6, 'up'); // stale sample for the old vote: ignored
    expect(fillOf(down)).toBe(0);
    f.steer(0.2, 'down');
    expect(fillOf(down)).toBeGreaterThan(0);
    expect(fillOf(up)).toBe(0);
  });

  it('accepts a 100 ms cached transition with a synchronous fresh progress sample', () => {
    vi.useFakeTimers();
    const f = makeFake();
    renderThumbs({ controller: f.controller, onVote: v => f.steer(0, v) });
    const down = screen.getByLabelText(DOWN);
    fireEvent.click(down);
    act(() => vi.advanceTimersByTime(100));
    f.steer(1, 'down');
    expect(down.getAttribute('aria-busy')).toBeNull();
    expect(fillOf(down)).toBe(1);
    expect(live().textContent).toBe('now playing your change');
  });

  it('ignores a stale p===1 right after a click', () => {
    const f = makeFake();
    renderThumbs({ controller: f.controller });
    const up = screen.getByLabelText(UP);
    fireEvent.click(up);
    f.steer(1, 'up');
    expect(up.getAttribute('aria-busy')).toBe('true');
    expect(fillOf(up)).toBe(0);
  });

  it('falls back to a local timed fill without a controller', () => {
    vi.useFakeTimers();
    renderThumbs();
    const down = screen.getByLabelText(DOWN);
    fireEvent.click(down);
    expect(down.getAttribute('aria-busy')).toBe('true');

    act(() => vi.advanceTimersByTime(FALLBACK_FILL_MS * 0.3));
    const a = fillOf(down);
    act(() => vi.advanceTimersByTime(FALLBACK_FILL_MS * 0.4));
    const b = fillOf(down);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);

    act(() => vi.advanceTimersByTime(FALLBACK_FILL_MS * 0.3 + 100));
    expect(fillOf(down)).toBe(1);
    expect(down.getAttribute('aria-busy')).toBeNull();
    expect(live().textContent).toBe('now playing your change');

    act(() => vi.advanceTimersByTime(FILL_HOLD_MS + FILL_FADE_MS));
    expect(fillOf(down)).toBe(0);
    expect(down.className).toBe('thumb thumb--down');
  });

  it('falls back to the timer when the controller never reports steerProgress', () => {
    vi.useFakeTimers();
    const f = makeFake();
    renderThumbs({ controller: f.controller });
    const up = screen.getByLabelText(UP);
    fireEvent.click(up);
    f.steer(null, null); // old controller path: nothing pending
    act(() => vi.advanceTimersByTime(FALLBACK_FILL_MS + 100));
    expect(fillOf(up)).toBe(1);
    expect(up.getAttribute('aria-busy')).toBeNull();
  });
});
