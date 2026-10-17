// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { MusicSessionController, SessionUiState, Vote } from './contracts.ts';
import { PlayerScreen } from './PlayerScreen.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const UP = "like what you're hearing";
const DOWN = 'hear something different';

type Fake = {
  controller: MusicSessionController;
  start: Mock<() => Promise<void>>;
  vote: Mock<(v: Vote) => void>;
  stop: Mock<() => void>;
  emit: (s: SessionUiState) => void;
  listenerCount: () => number;
};

function makeFake(initial: SessionUiState = { status: 'idle' }): Fake {
  let state = initial;
  const listeners = new Set<(s: SessionUiState) => void>();
  const start = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const vote = vi.fn<(v: Vote) => void>();
  const stop = vi.fn<() => void>();
  return {
    controller: {
      start,
      vote,
      stop,
      subscribe(listener) {
        listeners.add(listener);
        listener(state); // immediate emit, per contract
        return () => {
          listeners.delete(listener);
        };
      },
    },
    start,
    vote,
    stop,
    emit(s) {
      state = s;
      for (const l of [...listeners]) l(s);
    },
    listenerCount: () => listeners.size,
  };
}

describe('PlayerScreen — pre-start view', () => {
  it('idle shows the wordmark and a start button that calls start() once', () => {
    const f = makeFake();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('sway')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('stopped shows a subtle "session ended" hint above the button', () => {
    const f = makeFake({ status: 'stopped' });
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('session ended')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('error shows the pre-start view with the lastError text and a working Start button', () => {
    const f = makeFake({
      status: 'error',
      lastError: 'Could not reconnect to the music service',
    });
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('sway')).toBeTruthy();
    expect(screen.getByText('Could not reconnect to the music service')).toBeTruthy();
    // live-session chrome stays hidden — no thumbs, no "end session"
    expect(screen.queryByLabelText(UP)).toBeNull();
    expect(screen.queryByLabelText(DOWN)).toBeNull();
    expect(screen.queryByRole('button', { name: 'end session' })).toBeNull();
    // Start is the way back — start() accepts 'error'
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('error without lastError still shows a fallback message', () => {
    const f = makeFake({ status: 'error' });
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'start listening' })).toBeTruthy();
  });

  it('arrow keys do not vote while in error state', () => {
    const f = makeFake({ status: 'error', lastError: 'quota exhausted' });
    render(<PlayerScreen controller={f.controller} />);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(f.vote).not.toHaveBeenCalled();
  });

  it('arrow keys do not vote while idle', () => {
    const f = makeFake({ status: 'idle' });
    render(<PlayerScreen controller={f.controller} />);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(f.vote).not.toHaveBeenCalled();
  });

  it('omits purpose setup when the controller does not support it', () => {
    const f = makeFake();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.queryByRole('group', { name: 'start with' })).toBeNull();
  });

  it('defaults to Explore without resetting the controller', () => {
    const f = makeFake();
    const setPurpose = vi.fn();
    f.controller.setPurpose = setPurpose;
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByRole('group', { name: 'start with' })).toBeTruthy();
    for (const label of ['Focus', 'Relax', 'Energy', 'Explore', 'Crazy']) {
      expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed'))
        .toBe(label === 'Explore' ? 'true' : 'false');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(setPurpose).not.toHaveBeenCalled();
  });

  it('applies a changed purpose synchronously, ignores a repeat, and starts inside the click gesture', () => {
    const f = makeFake();
    const calls: string[] = [];
    f.controller.setPurpose = vi.fn((purpose) => { calls.push(purpose); });
    f.start.mockImplementation(() => {
      calls.push('start');
      return new Promise(() => { }); // audio initialization may remain pending
    });
    render(<PlayerScreen controller={f.controller} />);

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(calls).toEqual(['focus']);
    expect(screen.getByRole('button', { name: 'Focus' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(calls).toEqual(['focus']);

    // This listener observes the same event after React's handler, before any
    // microtask. A deferred start would lose the browser's autoplay gesture.
    let callsDuringGesture: string[] | undefined;
    window.addEventListener('click', () => { callsDuringGesture = [...calls]; }, { once: true });
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(callsDuringGesture).toEqual(['focus', 'start']);
  });

  it('hides purpose setup while playing and retains the choice across Stop/Start', () => {
    const f = makeFake();
    const setPurpose = vi.fn();
    f.controller.setPurpose = setPurpose;
    render(<PlayerScreen controller={f.controller} />);
    fireEvent.click(screen.getByRole('button', { name: 'Relax' }));
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    act(() => { f.emit({ status: 'playing' }); });
    expect(screen.queryByRole('group', { name: 'start with' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'end session' }));
    expect(f.stop).toHaveBeenCalledTimes(1);
    act(() => { f.emit({ status: 'stopped' }); });
    expect(screen.getByRole('button', { name: 'Relax' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Relax' }));
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(setPurpose).toHaveBeenCalledExactlyOnceWith('relax');
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it('returns a failed session to Start with its error and no voting shortcuts', () => {
    const f = makeFake({ status: 'playing' });
    render(<PlayerScreen controller={f.controller} />);
    act(() => { f.emit({ status: 'error', lastError: 'Audio could not start' }); });
    expect(screen.getByRole('alert').textContent).toBe('Audio could not start');
    expect(screen.queryByLabelText(UP)).toBeNull();
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(f.vote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});

describe('PlayerScreen — browser preferences', () => {
  it('records an explicit default choice during loading, then ignores the same choice once ready', () => {
    const f = makeFake({ status: 'idle', purpose: 'explore', memory: 'loading' });
    const setPurpose = vi.fn();
    f.controller.setPurpose = setPurpose;
    render(<PlayerScreen controller={f.controller} />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(setPurpose).toHaveBeenCalledExactlyOnceWith('explore');
    act(() => { f.emit({ status: 'idle', purpose: 'explore', memory: 'ready', savedVotes: 0 }); });
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(setPurpose).toHaveBeenCalledTimes(1);
  });

  it('allows Crazy and Start during restoration, then reflects the controller purpose', () => {
    const f = makeFake({ status: 'idle', memory: 'loading' });
    const setPurpose = vi.fn();
    f.controller.setPurpose = setPurpose;
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('Loading this browser’s preferences…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Crazy' }));
    expect(setPurpose).toHaveBeenCalledExactlyOnceWith('crazy');
    expect(screen.getByRole('button', { name: 'Crazy' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(f.start).toHaveBeenCalledTimes(1);

    act(() => { f.emit({ status: 'idle', purpose: 'energy', memory: 'ready', savedVotes: 3 }); });
    expect(screen.getByRole('button', { name: 'Energy' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Crazy' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Energy' }));
    expect(setPurpose).toHaveBeenCalledTimes(1); // restored selection is authoritative
    expect(screen.getByText('Energy · 3 saved votes on this browser.')).toBeTruthy();
  });

  it('shows per-profile persistence instead of claiming a switch resets learning', () => {
    const f = makeFake({ status: 'stopped', purpose: 'crazy', memory: 'ready', savedVotes: 1 });
    f.controller.setPurpose = vi.fn();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('Crazy · 1 saved vote on this browser.')).toBeTruthy();
    expect(screen.getByText('Each profile keeps its own preferences on this browser.')).toBeTruthy();
    expect(screen.queryByText(/starts a fresh preference session/)).toBeNull();
  });

  it('reflects saving and unavailable states without claiming unsuccessful writes were saved', () => {
    const f = makeFake({ status: 'idle', purpose: 'crazy', memory: 'saving', savedVotes: 0 });
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('Saving Crazy feedback on this browser…')).toBeTruthy();
    act(() => { f.emit({ status: 'idle', purpose: 'crazy', memory: 'unavailable', savedVotes: 0 }); });
    expect(screen.getByText('Some changes may not be saved on this browser.')).toBeTruthy();
    expect(screen.queryByText(/saved vote/)).toBeNull();
    expect((screen.getByRole('button', { name: 'start listening' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows no browser-memory claims or actions for unsupported mock controllers', () => {
    const f = makeFake();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.queryByText(/saved|saving|browser/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /export|reset/i })).toBeNull();
  });

  it('downloads the controller JSON locally and releases the object URL', async () => {
    vi.useFakeTimers();
    const json = '{"profiles":{"crazy":{"votes":2}},"feedback":[]}';
    const f = makeFake({ status: 'idle', memory: 'ready', savedVotes: 2 });
    f.controller.exportFeedback = vi.fn().mockResolvedValue(json);
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:sway-feedback');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let download: { href: string; name: string } | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      download = { href: this.href, name: this.download };
    });
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'export feedback as JSON' })); });
    expect(f.controller.exportFeedback).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob?.type).toBe('application/json');
    expect(blob?.size).toBe(new Blob([json]).size);
    expect(download).toEqual({ href: 'blob:sway-feedback', name: expect.stringMatching(/^sway-feedback-\d{4}-\d{2}-\d{2}\.json$/) });
    expect(document.querySelector('a[download]')).toBeNull();
    expect(screen.getByText('Feedback export prepared.')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:sway-feedback');
  });

  it('reports failed export and reset without claiming a download or cleared preferences', async () => {
    const f = makeFake({ status: 'idle', memory: 'unavailable' });
    f.controller.exportFeedback = vi.fn().mockRejectedValue(new Error('read failed'));
    f.controller.resetPreferences = vi.fn().mockRejectedValue(new Error('transaction failed'));
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'export feedback as JSON' })); });
    expect(screen.getByRole('alert').textContent).toBe('Could not export feedback. Try again.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'reset all saved profiles and feedback on this browser' })); });
    expect(screen.getByRole('alert').textContent).toBe('Could not confirm the reset. Saved data may remain.');
    expect(screen.queryByText(/cleared from this browser/)).toBeNull();
  });

  it('clears all profiles only on explicit reset, blocks overlapping actions, and keeps the current profile', async () => {
    let finishReset!: () => void;
    const f = makeFake({ status: 'stopped', purpose: 'crazy', memory: 'ready', savedVotes: 4 });
    f.controller.setPurpose = vi.fn();
    f.controller.resetPreferences = vi.fn(() => new Promise<void>(resolve => { finishReset = resolve; }));
    render(<PlayerScreen controller={f.controller} />);
    expect(f.controller.resetPreferences).not.toHaveBeenCalled();
    const reset = screen.getByRole('button', { name: 'reset all saved profiles and feedback on this browser' }) as HTMLButtonElement;
    fireEvent.click(reset);
    expect(reset.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(f.start).not.toHaveBeenCalled();
    expect(f.controller.setPurpose).not.toHaveBeenCalled();
    await act(async () => {
      f.emit({ status: 'stopped', purpose: 'crazy', memory: 'ready', savedVotes: 0 });
      finishReset();
    });
    expect(f.controller.resetPreferences).toHaveBeenCalledTimes(1);
    expect(screen.getByText('All saved profiles and feedback cleared from this browser.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Crazy' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('No saved feedback for Crazy yet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'start listening' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps only concise memory status on the live screen', () => {
    const f = makeFake({ status: 'playing', purpose: 'crazy', memory: 'ready', savedVotes: 4 });
    f.controller.setPurpose = vi.fn();
    f.controller.exportFeedback = vi.fn();
    f.controller.resetPreferences = vi.fn();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('Saved on this browser.')).toBeTruthy();
    expect(screen.getByLabelText(UP)).toBeTruthy();
    expect(screen.getByLabelText(DOWN)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'start with' })).toBeNull();
    expect(screen.queryByRole('button', { name: /export|reset/i })).toBeNull();
  });
});

describe('PlayerScreen — active session view', () => {
  it.each(['connecting', 'playing', 'reconnecting', 'unavailable'])(
    'status %s renders thumbs that are never disabled',
    async (status) => {
      const f = makeFake({ status });
      render(<PlayerScreen controller={f.controller} />);
      await act(async () => { }); // flush the subscribe → emit → re-render cycle
      const up = screen.getByLabelText(UP) as HTMLButtonElement;
      const down = screen.getByLabelText(DOWN) as HTMLButtonElement;
      expect(up.disabled).toBe(false);
      expect(down.disabled).toBe(false);
      expect(screen.queryByRole('button', { name: 'start listening' })).toBeNull();
    },
  );

  it('clicking thumbs votes synchronously (up then down)', async () => {
    const f = makeFake({ status: 'playing' });
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    fireEvent.click(screen.getByLabelText(UP));
    expect(f.vote).toHaveBeenCalledTimes(1);
    expect(f.vote).toHaveBeenLastCalledWith('up');
    fireEvent.click(screen.getByLabelText(DOWN));
    expect(f.vote).toHaveBeenCalledTimes(2);
    expect(f.vote).toHaveBeenLastCalledWith('down');
  });

  it('three rapid clicks produce three vote calls', async () => {
    const f = makeFake({ status: 'playing' });
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    const up = screen.getByLabelText(UP);
    fireEvent.click(up);
    fireEvent.click(up);
    fireEvent.click(up);
    expect(f.vote).toHaveBeenCalledTimes(3);
  });

  it('shows the mapped label plus lastError text when unavailable', async () => {
    const f = makeFake({ status: 'unavailable', lastError: 'relay offline' });
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(screen.getByText('temporarily unavailable')).toBeTruthy();
    expect(screen.getByText('relay offline')).toBeTruthy();
  });

  it('renders an unknown status verbatim in the chip', async () => {
    const f = makeFake({ status: 'buffering_hard' });
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(screen.getByText('buffering_hard')).toBeTruthy();
  });

  it('ArrowUp / ArrowDown vote while a session is active', async () => {
    const f = makeFake({ status: 'playing' });
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(f.vote).toHaveBeenCalledTimes(2);
    expect(f.vote.mock.calls[0]?.[0]).toBe('up');
    expect(f.vote.mock.calls[1]?.[0]).toBe('down');
  });

  it('shows the musical identity in the now-playing panel when the controller emits one', async () => {
    const f = makeFake({
      status: 'playing',
      signature: {
        genre: 'lofi',
        instrument: 'piano',
        mood: 'calm',
        texture: 'sparse',
        focus: 'warm ambient pads',
      },
    });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelector('.now')).toBeTruthy();
    expect(container.querySelector('.now__field[data-field="genre"] .now__value')?.textContent).toBe('lofi');
    expect(container.querySelector('.now__field[data-field="instrument"] .now__value')?.textContent).toBe('piano');
    expect(container.querySelector('.now__field[data-field="mood"] .now__value')?.textContent).toBe('calm');
    expect(container.querySelector('.now__field[data-field="texture"] .now__value')?.textContent).toBe('sparse');
    expect(container.querySelector('.now__focus')?.textContent).toContain('warm ambient pads');
  });

  it('partial signatures drop absent fields', async () => {
    const f = makeFake({
      status: 'playing',
      signature: { mood: 'calm', focus: 'soft keys' },
    });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelectorAll('.now__field')).toHaveLength(1);
    expect(container.querySelector('.now__field[data-field="mood"] .now__value')?.textContent).toBe('calm');
    expect(container.querySelector('.now__focus')?.textContent).toContain('soft keys');
  });

  it('renders no now-playing block while the signature is absent', async () => {
    const f = makeFake({ status: 'playing' });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelector('.now__block')).toBeNull();
  });

  it('updates the panel on a signature-only emission, status untouched', async () => {
    const f = makeFake({ status: 'playing' });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelector('.now__block')).toBeNull();
    await act(async () => {
      f.emit({ status: 'playing', signature: { genre: 'ambient', texture: 'drone' } });
    });
    expect(container.querySelector('.now__field[data-field="genre"] .now__value')?.textContent).toBe('ambient');
    expect(container.querySelector('.now__field[data-field="texture"] .now__value')?.textContent).toBe('drone');
    expect(screen.getByText('playing')).toBeTruthy(); // status label unchanged
  });

  it('"end session" calls stop()', async () => {
    const f = makeFake({ status: 'playing' });
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    fireEvent.click(screen.getByRole('button', { name: 'end session' }));
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('follows controller emissions and detaches the keydown listener on stop', async () => {
    const f = makeFake();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByRole('button', { name: 'start listening' })).toBeTruthy();
    await act(async () => {
      f.emit({ status: 'playing' });
    });
    expect(screen.getByLabelText(UP)).toBeTruthy();
    await act(async () => {
      f.emit({ status: 'stopped' });
    });
    expect(screen.getByRole('button', { name: 'start listening' })).toBeTruthy();
    expect(screen.getByText('session ended')).toBeTruthy();
    // session over → arrows no longer vote
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(f.vote).not.toHaveBeenCalled();
  });

  it('unmount unsubscribes from the controller', async () => {
    const f = makeFake({ status: 'playing' });
    const { unmount } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    // ≥1: PlayerScreen subscribes; the visualizer may subscribe too (signature/telemetry).
    expect(f.listenerCount()).toBeGreaterThanOrEqual(1);
    unmount();
    expect(f.listenerCount()).toBe(0);
    // a later emission must not touch the (unmounted) tree
    await act(async () => {
      f.emit({ status: 'stopped' });
    });
  });
});
