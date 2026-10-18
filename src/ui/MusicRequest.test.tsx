// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicSessionController, SessionUiState } from './contracts.ts';
import type { MusicIntent } from '../shared/intent.ts';
import { MusicRequest } from './MusicRequest.tsx';

afterEach(cleanup);

const intent = (extra: Partial<MusicIntent> = {}): MusicIntent => ({
  schemaVersion: 1, summary: 'Warm jazz for reading.', purposeHint: null, requiredFeatures: [],
  excludedFeatures: [], featureHints: [], contextPrompt: '', avoid: [], references: [], ...extra,
});
const controller = (): MusicSessionController => ({
  start: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), vote: vi.fn(), subscribe: () => () => {},
  interpretText: vi.fn().mockResolvedValue(undefined), clearIntent: vi.fn(),
});
const input = () => screen.getByRole('textbox', { name: 'Music request (optional)' }) as HTMLInputElement;
const submit = () => fireEvent.submit(screen.getByRole('form', { name: 'describe your music' }));

describe('MusicRequest', () => {
  it('is optional for legacy controllers and keeps an empty prestart pill quiet', () => {
    const c = controller();
    const onPendingChange = vi.fn();
    const view = render(<MusicRequest controller={c} state={{ status: 'idle' }} onPendingChange={onPendingChange} />);
    expect(input().value).toBe('');
    expect(input().maxLength).toBe(1200);
    expect((screen.getByRole('button', { name: 'Apply music request' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear music request' })).toBeNull();
    expect(screen.queryByText('request details')).toBeNull();
    view.rerender(<MusicRequest controller={{ ...c, interpretText: undefined }} state={{ status: 'idle' }} onPendingChange={onPendingChange} />);
    expect(screen.queryByRole('region', { name: 'music request' })).toBeNull();
  });

  it('submits trimmed text once, stays editable while loading, and never starts playback', async () => {
    let finish!: () => void;
    const c = controller();
    c.interpretText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onPendingChange = vi.fn();
    render(<MusicRequest controller={c} state={{ status: 'idle' }} onPendingChange={onPendingChange} />);
    fireEvent.change(input(), { target: { value: '  warm jazz  ' } });
    submit(); submit();
    expect(c.interpretText).toHaveBeenCalledExactlyOnceWith('warm jazz');
    expect((screen.getByRole('button', { name: 'Apply music request' }) as HTMLButtonElement).disabled).toBe(true);
    expect(input().disabled).toBe(false);
    expect(screen.getByRole('status', { name: 'Applying music request' })).toBeTruthy();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    await act(async () => { finish(); });
    expect(c.start).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps submitted text and focus after success without showing generated content', async () => {
    let finish!: () => void;
    const c = controller();
    c.interpretText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onPendingChange = vi.fn();
    const view = render(<MusicRequest controller={c} state={{ status: 'idle' }} onPendingChange={onPendingChange} />);
    input().focus();
    fireEvent.change(input(), { target: { value: 'jazz' } });
    submit();
    await act(async () => {
      view.rerender(<MusicRequest controller={c} state={{ status: 'idle', intentStatus: 'ready', intentText: 'jazz', intent: intent({
        requiredFeatures: ['jazz'], excludedFeatures: ['percussion'], avoid: ['vocals'], contextPrompt: 'internal prompt',
        references: [{ id: 'one', title: 'Reference source', url: 'https://example.com/music' }],
      }) }} onPendingChange={onPendingChange} />);
      finish();
    });
    expect(input().value).toBe('jazz');
    expect(document.activeElement).toBe(input());
    expect(screen.queryByRole('status')).toBeNull();
    expect(view.container.querySelector('details, a, .music-request__summary, .music-request__applied')).toBeNull();
    expect(screen.queryByText(/Warm jazz|Keep:|Avoid:|Reference source|internal prompt/)).toBeNull();
  });

  it('does not revert a newer draft when a slow response arrives', async () => {
    let finish!: () => void;
    const c = controller();
    c.interpretText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onPendingChange = vi.fn();
    const view = render(<MusicRequest controller={c} state={{ status: 'idle' }} onPendingChange={onPendingChange} />);
    fireEvent.change(input(), { target: { value: 'jazz' } }); submit();
    fireEvent.change(input(), { target: { value: 'jazz with brushed drums' } });
    await act(async () => {
      view.rerender(<MusicRequest controller={c} state={{ status: 'idle', intentStatus: 'ready', intentText: 'jazz', intent: intent() }} onPendingChange={onPendingChange} />);
      finish();
    });
    expect(input().value).toBe('jazz with brushed drums');
    expect(screen.queryByText('Warm jazz for reading.')).toBeNull();
  });

  it('reflects restored intent without autoplay or overwriting an in-progress draft', () => {
    const c = controller();
    const onPendingChange = vi.fn();
    const view = render(<MusicRequest controller={c} state={{ status: 'idle', memory: 'loading' }} onPendingChange={onPendingChange} />);
    fireEvent.change(input(), { target: { value: 'quiet piano' } });
    const restored: SessionUiState = { status: 'idle', memory: 'ready', intentText: 'jazz', intent: intent(), intentStatus: 'ready' };
    view.rerender(<MusicRequest controller={c} state={restored} onPendingChange={onPendingChange} />);
    expect(input().value).toBe('quiet piano');
    expect(c.interpretText).not.toHaveBeenCalled();
    expect(c.start).not.toHaveBeenCalled();
    view.unmount();
    render(<MusicRequest controller={c} state={restored} onPendingChange={onPendingChange} />);
    expect(input().value).toBe('jazz');
  });

  it.each(['clarify', 'unsupported', 'error'] as const)('shows a compact %s response and keeps the applied music', (status) => {
    const c = controller();
    render(<MusicRequest controller={c} compact state={{ status: 'playing', intent: intent(), intentText: 'jazz',
      intentStatus: status, intentMessage: 'Please add a little more detail.' }} onPendingChange={vi.fn()} />);
    expect(screen.getByRole(status === 'clarify' ? 'status' : 'alert').textContent).toBe('Please add a little more detail.');
    expect(screen.queryByText('Warm jazz for reading.')).toBeNull();
    expect(input().value).toBe('jazz');
    expect(c.stop).not.toHaveBeenCalled();
  });

  it('shows ready-state constraint messages without replacing a new draft', () => {
    const c = controller();
    const onPendingChange = vi.fn();
    const state: SessionUiState = { status: 'playing', intent: intent(), intentText: 'jazz', intentStatus: 'ready' };
    const view = render(<MusicRequest controller={c} compact state={state} onPendingChange={onPendingChange} />);
    fireEvent.change(input(), { target: { value: 'a different direction' } });
    view.rerender(<MusicRequest controller={c} compact state={{ ...state, intentMessage: 'That style conflicts with your request.' }} onPendingChange={onPendingChange} />);
    expect(screen.getByRole('status').textContent).toBe('That style conflicts with your request.');
    expect(input().value).toBe('a different direction');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps thrown details private, allows retry, and cancels late errors on Clear', async () => {
    const c = controller();
    c.interpretText = vi.fn().mockRejectedValue(new Error('secret provider JSON'));
    render(<MusicRequest controller={c} state={{ status: 'idle' }} onPendingChange={vi.fn()} />);
    fireEvent.change(input(), { target: { value: 'jazz' } });
    await act(async () => { submit(); });
    expect(screen.getByRole('alert').textContent).toBe('Could not apply that. Try again.');
    expect(screen.queryByText(/secret provider/)).toBeNull();
    let reject!: (reason: Error) => void;
    c.interpretText = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    submit();
    fireEvent.click(screen.getByRole('button', { name: 'Clear music request' }));
    expect(c.clearIntent).toHaveBeenCalledOnce();
    expect(input().value).toBe('');
    await act(async () => { reject(new Error('late failure')); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables submission when interpretation is unavailable', () => {
    const c = controller();
    render(<MusicRequest controller={c} state={{ status: 'idle', intentAvailable: false }} onPendingChange={vi.fn()} />);
    fireEvent.change(input(), { target: { value: 'jazz' } }); submit();
    expect((screen.getByRole('button', { name: 'Apply music request' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Text requests are unavailable right now.')).toBeTruthy();
    expect(c.interpretText).not.toHaveBeenCalled();
  });

  it('keeps the inline loader through the audio transition and permits a new request', async () => {
    const c = controller();
    const onPendingChange = vi.fn();
    const state = { status: 'playing', intentText: 'jazz', intentStatus: 'ready' as const, intentApplying: true };
    const view = render(<MusicRequest controller={c} compact state={state} onPendingChange={onPendingChange} />);
    expect(input().value).toBe('jazz');
    expect(screen.getByRole('status', { name: 'Applying music request' })).toBeTruthy();
    expect(input().disabled).toBe(false);
    fireEvent.change(input(), { target: { value: 'piano' } });
    await act(async () => { submit(); });
    expect(c.interpretText).toHaveBeenCalledExactlyOnceWith('piano');
    expect(screen.getByRole('status', { name: 'Applying music request' })).toBeTruthy();
    view.rerender(<MusicRequest controller={c} compact state={{ ...state, intentText: 'piano', intentApplying: false }} onPendingChange={onPendingChange} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(input().value).toBe('piano');
    expect(c.start).not.toHaveBeenCalled();
  });

  it('ignores a cleared request completion while a newer request is still pending', async () => {
    let rejectOld!: (error: Error) => void;
    let finishNew!: () => void;
    const c = controller();
    c.interpretText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishNew = resolve; }));
    const onPendingChange = vi.fn();
    render(<MusicRequest controller={c} state={{ status: 'playing' }} onPendingChange={onPendingChange} />);
    fireEvent.change(input(), { target: { value: 'jazz' } }); submit();
    fireEvent.click(screen.getByRole('button', { name: 'Clear music request' }));
    expect(document.activeElement).toBe(input());
    fireEvent.change(input(), { target: { value: 'piano' } }); submit();
    await act(async () => { rejectOld(new Error('old failure')); });
    expect(input().value).toBe('piano');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status', { name: 'Applying music request' })).toBeTruthy();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    await act(async () => { finishNew(); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });
});
