// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { MusicSessionController, SessionUiState, Vote } from './contracts.ts';
import { PlayerScreen } from './PlayerScreen.tsx';

afterEach(cleanup);

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
    for (const label of ['Focus', 'Relax', 'Energy', 'Explore']) {
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

  it('whispers the musical signature when the controller emits one', async () => {
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
    render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    const whisper = screen.getByText(/lofi/);
    expect(whisper.className).toBe('signature-whisper');
    expect(whisper.textContent).toBe(
      'lofi · piano · calm · sparse — "warm ambient pads"',
    );
    expect(screen.getByText(/warm ambient pads/)).toBeTruthy();
  });

  it('whispers partial signatures — absent fields drop out', async () => {
    const f = makeFake({
      status: 'playing',
      signature: { mood: 'calm', focus: 'soft keys' },
    });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelector('.signature-whisper')?.textContent).toBe(
      'calm — "soft keys"',
    );
  });

  it('renders no whisper line while the signature is absent', async () => {
    const f = makeFake({ status: 'playing' });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelector('.signature-whisper')).toBeNull();
  });

  it('renders no whisper line for an empty signature object', async () => {
    const f = makeFake({ status: 'playing', signature: {} });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelector('.signature-whisper')).toBeNull();
  });

  it('updates the whisper on a signature-only emission, status untouched', async () => {
    const f = makeFake({ status: 'playing' });
    const { container } = render(<PlayerScreen controller={f.controller} />);
    await act(async () => { });
    expect(container.querySelector('.signature-whisper')).toBeNull();
    await act(async () => {
      f.emit({ status: 'playing', signature: { genre: 'ambient', texture: 'drone' } });
    });
    expect(container.querySelector('.signature-whisper')?.textContent).toBe(
      'ambient · drone',
    );
    expect(screen.getByText('playing')).toBeTruthy(); // chip label unchanged
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
