// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MusicSessionController,
  SessionUiState,
  StreamLevels,
  Vote,
} from './contracts.ts';
import { Visualizer } from './Visualizer.tsx';

afterEach(cleanup);

const LEVELS: StreamLevels = {
  energy: 0.5,
  brightnessHz: 2400,
  pitchHz: 220,
  bufferedMs: 900,
  underruns: 0,
};

const PLAYING: SessionUiState = {
  status: 'playing',
  signature: { genre: 'ambient', mood: 'calm', instrument: 'felt piano' },
};

type Fake = {
  controller: MusicSessionController;
  stateListeners: Set<(s: SessionUiState) => void>;
  statsListeners: Set<(l: StreamLevels) => void>;
  emitState: (s: SessionUiState) => void;
  emitStats: (l: StreamLevels) => void;
};

function makeFake(withStats = true): Fake {
  const stateListeners = new Set<(s: SessionUiState) => void>();
  const statsListeners = new Set<(l: StreamLevels) => void>();
  const controller: MusicSessionController = {
    start: vi.fn(() => Promise.resolve()),
    vote: vi.fn<(v: Vote) => void>(),
    stop: vi.fn(),
    subscribe(listener) {
      stateListeners.add(listener);
      listener(PLAYING); // immediate emit, per contract
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
  if (withStats) {
    controller.subscribeStats = (listener) => {
      statsListeners.add(listener);
      listener(LEVELS); // latest snapshot on subscribe, per contract
      return () => {
        statsListeners.delete(listener);
      };
    };
  }
  return {
    controller,
    stateListeners,
    statsListeners,
    emitState: (s) => {
      for (const l of [...stateListeners]) l(s);
    },
    emitStats: (levels) => {
      for (const l of [...statsListeners]) l(levels);
    },
  };
}

const getCanvas = (container: HTMLElement) =>
  container.querySelector('canvas.visualizer');

describe('Visualizer', () => {
  it('renders a stage-filling canvas', () => {
    const { container } = render(<Visualizer active={true} />);
    const canvas = getCanvas(container);
    expect(canvas).toBeTruthy();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
  });

  it('registers state and stats subscriptions on mount', () => {
    const f = makeFake();
    render(<Visualizer active={true} controller={f.controller} />);
    expect(f.stateListeners.size).toBe(1);
    expect(f.statsListeners.size).toBe(1);
  });

  it('unsubscribes from both feeds on unmount', () => {
    const f = makeFake();
    const { unmount } = render(
      <Visualizer active={true} controller={f.controller} />,
    );
    expect(f.stateListeners.size).toBe(1);
    expect(f.statsListeners.size).toBe(1);
    unmount();
    expect(f.stateListeners.size).toBe(0);
    expect(f.statsListeners.size).toBe(0);
    // late emissions must not reach the unmounted tree
    act(() => {
      f.emitStats(LEVELS);
      f.emitState({ status: 'stopped' });
    });
  });

  it('works when the controller lacks subscribeStats', () => {
    const f = makeFake(false);
    const { container, unmount } = render(
      <Visualizer active={true} controller={f.controller} />,
    );
    expect(getCanvas(container)).toBeTruthy();
    expect(f.stateListeners.size).toBe(1);
    act(() => {
      f.emitState({ status: 'playing', signature: { genre: 'techno' } });
    });
    unmount();
    expect(f.stateListeners.size).toBe(0);
  });

  it('renders without a controller (ambient drift only)', () => {
    const { container } = render(<Visualizer active={false} />);
    expect(getCanvas(container)).toBeTruthy();
  });

  it('absorbs stats ticks, signature morphs, and underrun spikes without crashing', () => {
    const f = makeFake();
    render(<Visualizer active={true} controller={f.controller} />);
    act(() => {
      f.emitStats({ ...LEVELS, energy: 0.9, pitchHz: 440 });
      f.emitState({
        status: 'playing',
        signature: { genre: 'techno', mood: 'driving', texture: 'granular' },
      });
      f.emitStats({ ...LEVELS, underruns: 3, pitchHz: null });
      f.emitStats({ ...LEVELS, energy: 0 });
    });
    expect(f.statsListeners.size).toBe(1);
  });

  it('accepts vote pulses and active flips without crashing', () => {
    const f = makeFake();
    const { container, rerender } = render(
      <Visualizer active={false} controller={f.controller} />,
    );
    rerender(
      <Visualizer
        active={false}
        controller={f.controller}
        lastVote={{ v: 'up', at: Date.now() }}
      />,
    );
    rerender(
      <Visualizer
        active={true}
        controller={f.controller}
        lastVote={{ v: 'down', at: Date.now() }}
      />,
    );
    rerender(<Visualizer active={true} controller={f.controller} lastVote={null} />);
    expect(getCanvas(container)).toBeTruthy();
  });
});
