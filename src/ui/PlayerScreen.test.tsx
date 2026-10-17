// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { MusicSessionController, SessionUiState, Vote } from './contracts.ts';
import { PlayerScreen } from './PlayerScreen.tsx';
import type { MusicIntent } from '../shared/intent.ts';

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

const requestIntent = (extra: Partial<MusicIntent> = {}): MusicIntent => ({
  schemaVersion: 1, summary: 'Warm, quiet piano with a little space.', purposeHint: null,
  requiredFeatures: [], excludedFeatures: [], featureHints: [], contextPrompt: '', avoid: [], references: [], ...extra,
});

describe('PlayerScreen — optional music requests', () => {
  it('omits request controls for a legacy or standalone mock controller', () => {
    const f = makeFake();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.queryByRole('region', { name: 'music request' })).toBeNull();
    act(() => { f.emit({ status: 'playing' }); });
    expect(screen.queryByRole('button', { name: 'add a request' })).toBeNull();
  });

  it('applies trimmed text separately before Start and never starts audio on completion', async () => {
    let finish!: () => void;
    const f = makeFake({ status: 'idle', intentAvailable: true });
    f.controller.interpretText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<PlayerScreen controller={f.controller} />);
    const input = screen.getByRole('textbox', { name: /What would you like to hear/ });
    const start = screen.getByRole('button', { name: 'start listening' }) as HTMLButtonElement;
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  gentle piano  ' } });
    fireEvent.submit(screen.getByRole('form', { name: 'describe your music' }));
    expect(f.controller.interpretText).toHaveBeenCalledExactlyOnceWith('gentle piano');
    expect(start.disabled).toBe(true);
    expect(screen.getByText('Finding a direction for your music…')).toBeTruthy();
    fireEvent.click(start);
    expect(f.start).not.toHaveBeenCalled();
    await act(async () => {
      f.emit({ status: 'idle', intentAvailable: true, intentStatus: 'ready', intentText: 'gentle piano', intent: requestIntent() });
      finish();
    });
    expect(screen.getByText('Warm, quiet piano with a little space.')).toBeTruthy();
    expect(f.start).not.toHaveBeenCalled();
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(f.start).toHaveBeenCalledOnce();
  });

  it('keeps live requests compact, supports editing during a request, and leaves thumbs available', async () => {
    let finish!: () => void;
    const f = makeFake({ status: 'playing', intentAvailable: true });
    f.controller.interpretText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'add a request' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const input = screen.getByRole('textbox', { name: /What would you like to hear/ }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'quiet jazz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.change(input, { target: { value: 'quiet jazz with brushes' } });
    expect(input.disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'applying…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(UP));
    fireEvent.click(screen.getByLabelText(DOWN));
    expect(f.vote.mock.calls.map(call => call[0])).toEqual(['up', 'down']);
    await act(async () => {
      f.emit({ status: 'playing', intentAvailable: true, intentText: 'quiet jazz', intentStatus: 'ready', intent: requestIntent() });
      finish();
    });
    expect(input.value).toBe('quiet jazz with brushes');
    fireEvent.click(screen.getByRole('button', { name: 'close request' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Warm, quiet piano with a little space.')).toBeTruthy();
  });

  it('does not cast arrow-key votes while editing and retains shortcuts elsewhere', () => {
    const f = makeFake({ status: 'playing' });
    f.controller.interpretText = vi.fn().mockResolvedValue(undefined);
    render(<PlayerScreen controller={f.controller} />);
    fireEvent.click(screen.getByRole('button', { name: 'add a request' }));
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(f.vote).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(f.vote).toHaveBeenCalledExactlyOnceWith('up');
  });

  it('shows clarification and unsupported messages while retaining an editable request', () => {
    const f = makeFake({ status: 'idle', intentText: 'that soundtrack', intentStatus: 'clarify',
      intentMessage: 'Which soundtrack do you mean?' });
    f.controller.interpretText = vi.fn().mockResolvedValue(undefined);
    render(<PlayerScreen controller={f.controller} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('that soundtrack');
    expect(screen.getByRole('status').textContent).toBe('Which soundtrack do you mean?');
    act(() => { f.emit({ status: 'idle', intentText: 'that soundtrack', intentStatus: 'unsupported',
      intentMessage: 'Describe its musical mood or instruments.' }); });
    expect(screen.getByRole('alert').textContent).toBe('Describe its musical mood or instruments.');
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a safe request failure and keeps ordinary playback available', async () => {
    const f = makeFake({ status: 'idle' });
    f.controller.interpretText = vi.fn().mockRejectedValue(new Error('{"provider":"secret details"}'));
    render(<PlayerScreen controller={f.controller} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'piano' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply' })); });
    expect(screen.getByRole('alert').textContent).toBe('Could not apply your request. Please try again.');
    expect(screen.queryByText(/secret details/)).toBeNull();
    expect((screen.getByRole('button', { name: 'start listening' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables Apply when requests are unavailable without disabling Start', () => {
    const f = makeFake({ status: 'idle', intentAvailable: false, intentText: 'piano' });
    f.controller.interpretText = vi.fn();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByRole('alert').textContent).toBe('Text requests are unavailable right now.');
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'start listening' }));
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.controller.interpretText).not.toHaveBeenCalled();
  });

  it('clears a pending request and ignores its later rejected completion', async () => {
    let reject!: (error: Error) => void;
    const f = makeFake({ status: 'idle', intentText: 'piano' });
    f.controller.interpretText = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    f.controller.clearIntent = vi.fn(() => f.emit({ status: 'idle', intentStatus: 'idle' }));
    render(<PlayerScreen controller={f.controller} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.click(screen.getByRole('button', { name: 'clear request' }));
    expect(f.controller.clearIntent).toHaveBeenCalledOnce();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'start listening' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { reject(new Error('late')); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Finding a direction for your music…')).toBeNull();
  });

  it('renders human interpretation and safe source links, keeping internal fields out of the UI', () => {
    const f = makeFake({ status: 'idle', intentStatus: 'ready', intent: requestIntent({ contextPrompt: 'internal prompt', references: [
      { id: 'one', title: 'Rainy-day music', url: 'https://example.com/music' },
      { id: 'bad', title: 'unsafe reference', url: 'javascript:alert(1)' },
    ] }) });
    f.controller.interpretText = vi.fn();
    render(<PlayerScreen controller={f.controller} />);
    const link = screen.getByRole('link', { name: 'Rainy-day music' });
    expect(link.getAttribute('href')).toBe('https://example.com/music');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByRole('link', { name: 'unsafe reference' })).toBeNull();
    expect(screen.queryByText('internal prompt')).toBeNull();
  });

  it('shows readable enforced constraints before Start and in the collapsed live request', () => {
    const intent = requestIntent({ requiredFeatures: ['lofi', 'synth'], excludedFeatures: ['percussion'] });
    const f = makeFake({ status: 'idle', intentStatus: 'ready', intent });
    f.controller.interpretText = vi.fn();
    render(<PlayerScreen controller={f.controller} />);
    expect(screen.getByText('Keep: lo-fi, synthesizer · Avoid: percussion')).toBeTruthy();
    act(() => { f.emit({ status: 'playing', intentStatus: 'ready', intent }); });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Keep: lo-fi, synthesizer · Avoid: percussion')).toBeTruthy();
    act(() => { f.emit({ status: 'playing', intent: requestIntent({ excludedFeatures: ['synth'] }) }); });
    expect(screen.getByText('Avoid: synthesizer')).toBeTruthy();
    expect(screen.queryByText(/^Keep:/)).toBeNull();
    act(() => { f.emit({ status: 'playing', intent: requestIntent({ featureHints: ['jazz'] }) }); });
    expect(screen.queryByText(/^(Keep|Avoid):/)).toBeNull();
  });
});

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
      return new Promise(() => {}); // audio initialization may remain pending
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
