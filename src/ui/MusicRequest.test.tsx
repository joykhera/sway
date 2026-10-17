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
    expect(screen.queryByRole('button', { name: 'clear request' })).toBeNull();
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
    expect((screen.getByRole('button', { name: 'Applying music request' }) as HTMLButtonElement).disabled).toBe(true);
    expect(input().disabled).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('Finding your sound…');
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    await act(async () => { finish(); });
    expect(c.start).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it('collapses an applied request and opens its saved text with keyboard focus', async () => {
    let finish!: () => void;
    const c = controller();
    c.interpretText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onPendingChange = vi.fn();
    const view = render(<MusicRequest controller={c} state={{ status: 'idle' }} onPendingChange={onPendingChange} />);
    fireEvent.change(input(), { target: { value: 'jazz' } });
    submit();
    await act(async () => {
      view.rerender(<MusicRequest controller={c} state={{ status: 'idle', intentStatus: 'ready', intentText: 'jazz', intent: intent() }} onPendingChange={onPendingChange} />);
      finish();
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Warm jazz for reading.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit music request' }));
    expect(input().value).toBe('jazz');
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit music request' }));
  });

  it('does not collapse or revert a newer draft when a slow response arrives', async () => {
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
    expect(screen.getByText('Warm jazz for reading.')).toBeTruthy();
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
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit music request' }));
    expect(input().value).toBe('jazz');
  });

  it.each(['clarify', 'unsupported', 'error'] as const)('shows a compact %s response and keeps the applied music', (status) => {
    const c = controller();
    render(<MusicRequest controller={c} compact state={{ status: 'playing', intent: intent(), intentText: 'jazz',
      intentStatus: status, intentMessage: 'Please add a little more detail.' }} onPendingChange={vi.fn()} />);
    expect(screen.getByRole(status === 'clarify' ? 'status' : 'alert').textContent).toBe('Please add a little more detail.');
    expect(screen.getByText('Warm jazz for reading.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit music request' }));
    expect(input().value).toBe('jazz');
    expect(c.stop).not.toHaveBeenCalled();
  });

  it('shows ready-state constraint messages without replacing a new draft', () => {
    const c = controller();
    const onPendingChange = vi.fn();
    const state: SessionUiState = { status: 'playing', intent: intent(), intentText: 'jazz', intentStatus: 'ready' };
    const view = render(<MusicRequest controller={c} compact state={state} onPendingChange={onPendingChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit music request' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'clear request' }));
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

  it('puts readable constraints and safe sources in an initially closed disclosure', () => {
    const c = controller();
    const { container } = render(<MusicRequest controller={c} compact state={{ status: 'playing', intent: intent({
      requiredFeatures: ['lofi', 'synth'], excludedFeatures: ['percussion'], featureHints: ['calm'],
      contextPrompt: 'internal instructions', references: [
        { id: 'one', title: 'Reference recording', url: 'https://example.com/recording' },
        { id: 'bad', title: 'unsafe source', url: 'javascript:alert(1)' },
      ],
    }) }} onPendingChange={vi.fn()} />);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Keep: lo-fi, synthesizer · Avoid: percussion');
    const link = details.querySelector('a')!;
    expect(link.href).toBe('https://example.com/recording');
    expect(link.rel).toBe('noopener noreferrer');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.queryByText('internal instructions')).toBeNull();
  });

  it('offers details for supplemental avoidance alone and combines it with vocabulary exclusions', () => {
    const c = controller();
    const onPendingChange = vi.fn();
    const state: SessionUiState = { status: 'playing', intent: intent({ avoid: ['vocals', 'busy drums'] }) };
    const view = render(<MusicRequest controller={c} compact state={state} onPendingChange={onPendingChange} />);
    const details = view.container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Avoid: vocals, busy drums');
    view.rerender(<MusicRequest controller={c} compact state={{ ...state,
      intent: intent({ excludedFeatures: ['synth'], avoid: ['vocals', 'synthesizer'] }),
    }} onPendingChange={onPendingChange} />);
    expect(details.textContent).toContain('Avoid: synthesizer, vocals');
    expect(details.textContent).not.toContain('vocals, synthesizer');
  });
});
