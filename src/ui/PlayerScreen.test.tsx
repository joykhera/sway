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
  it('idle shows the wordmark, tagline, and a start button that calls start() once', () => {
    const f = makeFake();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('sway')).toBeTruthy();
    expect(screen.getByText(/infinite instrumental stream/)).toBeTruthy();
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
    expect(f.listenerCount()).toBe(1);
    unmount();
    expect(f.listenerCount()).toBe(0);
    // a later emission must not touch the (unmounted) tree
    await act(async () => {
      f.emit({ status: 'stopped' });
    });
  });
});
