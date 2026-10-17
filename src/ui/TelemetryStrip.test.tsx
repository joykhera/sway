// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicSessionController, SessionUiState, StreamLevels, Vote } from './contracts.ts';
import { noteName, TelemetryStrip } from './TelemetryStrip.tsx';

afterEach(cleanup);

function makeFake(levels?: StreamLevels) {
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
      listener(levels ?? { energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0, generation: 0 });
      return () => statsListeners.delete(listener);
    },
  };
  return {
    controller,
    emitStats: (l: StreamLevels) => { for (const fn of [...statsListeners]) fn(l); },
  };
}

describe('noteName', () => {
  it('maps reference frequencies to equal-tempered notes', () => {
    expect(noteName(440)).toBe('A4');
    expect(noteName(261.63)).toBe('C4');
    expect(noteName(220)).toBe('A3');
    expect(noteName(55)).toBe('A1');
    expect(noteName(880)).toBe('A5');
  });
});

describe('TelemetryStrip', () => {
  it('renders pitch, brightness, energy and buffer from live levels', () => {
    const f = makeFake({ energy: 0.61, brightnessHz: 2400, pitchHz: 220, bufferedMs: 2700, underruns: 0, generation: 0 });
    const { container } = render(<TelemetryStrip controller={f.controller} />);
    expect(container.querySelector('.telemetry')?.textContent).toBe(
      '220 hz A3 · 2.4 khz · 61% · buf 2.7 s',
    );
  });

  it('reads "silent" and zero buffer when no signal is flowing', () => {
    const f = makeFake();
    const { container } = render(<TelemetryStrip controller={f.controller} />);
    expect(container.querySelector('.telemetry')?.textContent).toContain('silent');
  });

  it('updates on each stats tick and reports dropouts when present', () => {
    const f = makeFake();
    const { container } = render(<TelemetryStrip controller={f.controller} />);
    act(() => {
      f.emitStats({ energy: 0.32, brightnessHz: 1100, pitchHz: 440, bufferedMs: 900, underruns: 2, generation: 3 });
    });
    expect(container.querySelector('.telemetry')?.textContent).toBe(
      '440 hz A4 · 1.1 khz · 32% · buf 0.9 s · 2 dropouts',
    );
  });

  it('stays at zeros when the controller has no stats feed', () => {
    const bare: MusicSessionController = {
      start: vi.fn(() => Promise.resolve()),
      vote: vi.fn(),
      stop: vi.fn(),
      subscribe: () => () => { },
    };
    const { container } = render(<TelemetryStrip controller={bare} />);
    expect(container.querySelector('.telemetry')?.textContent).toContain('0%');
  });

  it('sweeps the generation beam once per landed block, collapsing rapid bursts', () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const had = { animate: proto.animate, getAnimations: proto.getAnimations };
    proto.animate = animate;
    proto.getAnimations = () => [];
    let now = 1000;
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const f = makeFake();
      render(<TelemetryStrip controller={f.controller} />);
      const tick = (generation: number, at: number) => {
        now = at;
        act(() => f.emitStats({ energy: 0.2, brightnessHz: 500, pitchHz: 300, bufferedMs: 2700, underruns: 0, generation }));
      };
      tick(1, 1000);
      tick(2, 1100); // pump-burst: ignored
      tick(3, 3000); // a real ~2 s block gap
      tick(3, 3200); // no new block
      expect(animate).toHaveBeenCalledTimes(2);
      const [, timing] = animate.mock.calls[1] as unknown as [Keyframe[], KeyframeAnimationOptions];
      expect(timing.fill).toBe('forwards');
      expect(timing.duration).toBeCloseTo(2000, -1);
    } finally {
      perf.mockRestore();
      proto.animate = had.animate;
      proto.getAnimations = had.getAnimations;
    }
  });
});
