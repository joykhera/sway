import { useEffect, useId, useRef, useState } from 'react';
import type { MusicSessionController, SessionUiState } from './contracts.ts';
import { INTENT_LIMITS } from '../shared/intent.ts';
import type { FeatureId } from '../learner/vocabulary.ts';
import './music-request.css';

type Props = {
  controller: MusicSessionController;
  state: SessionUiState;
  compact?: boolean;
  onPendingChange(pending: boolean): void;
};

function featureLabel(feature: FeatureId): string {
  return feature === 'lofi' ? 'lo-fi' : feature === 'synth' ? 'synthesizer' : feature;
}

function safeSource(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** Text supplies a direction. Applying it never starts the audio. */
export function MusicRequest({ controller, state, compact = false, onPendingChange }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(state.intentText ?? '');
  const [editing, setEditing] = useState(!compact && !state.intent);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const focusInput = useRef(false);
  const focusOpener = useRef(false);
  const draftRef = useRef(draft);
  const previousText = useRef(state.intentText ?? '');
  const submittedText = useRef<string | null>(null);
  const operation = useRef(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    const before = previousText.current;
    const after = state.intentText ?? '';
    // Storage restoration and slow replies may arrive while a new draft is being typed.
    if (draftRef.current === before) {
      draftRef.current = after;
      setDraft(after);
      if (state.intent) setEditing(false);
    }
    if (state.intentStatus === 'ready' && submittedText.current === after
      && draftRef.current.trim() === after) {
      focusOpener.current = document.activeElement === input.current;
      setEditing(false);
    }
    previousText.current = after;
  }, [state.intentText, state.intent, state.intentStatus]);

  useEffect(() => {
    if (editing && focusInput.current) {
      input.current?.focus();
      focusInput.current = false;
    } else if (!editing && focusOpener.current) {
      opener.current?.focus();
      focusOpener.current = false;
    }
  }, [editing]);

  useEffect(() => {
    pendingRef.current = false;
    setPending(false);
    return () => {
      operation.current++;
      onPendingChange(false);
    };
  }, [controller, onPendingChange]);

  if (!controller.interpretText) return null;
  const loading = pending || state.intentStatus === 'loading';
  const available = state.intentAvailable !== false;
  const alert = Boolean(localError || state.intentStatus === 'error' || state.intentStatus === 'unsupported');
  const message = localError ?? (loading ? 'Finding your sound…'
    : state.intentMessage ?? (state.intentStatus === 'clarify' ? 'What mood or instruments did you have in mind?'
      : state.intentStatus === 'unsupported' ? 'Try a mood, style, or instrument.'
        : state.intentStatus === 'error' ? 'Could not apply that. Try again.'
          : !available && editing ? 'Text requests are unavailable right now.' : undefined));
  const avoided = [...new Set([
    ...(state.intent?.excludedFeatures.map(featureLabel) ?? []),
    ...(state.intent?.avoid ?? []),
  ])];
  const constraints = [
    state.intent?.requiredFeatures.length ? `Keep: ${state.intent.requiredFeatures.map(featureLabel).join(', ')}` : '',
    avoided.length ? `Avoid: ${avoided.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  const sources = state.intent?.references.flatMap(reference => {
    const url = safeSource(reference.url);
    return url ? [{ ...reference, url }] : [];
  }) ?? [];

  const open = () => { focusInput.current = true; setEditing(true); };
  const close = () => { focusOpener.current = true; setEditing(false); };
  const submit = async () => {
    const text = draftRef.current.trim();
    if (!text || loading || pendingRef.current || !available) return;
    const current = ++operation.current;
    pendingRef.current = true;
    submittedText.current = text;
    setPending(true);
    setLocalError(null);
    onPendingChange(true);
    try {
      await controller.interpretText!(text);
    } catch {
      // Raw transport/provider errors must never become product copy.
      if (operation.current === current) setLocalError('Could not apply that. Try again.');
    } finally {
      if (operation.current === current) {
        pendingRef.current = false;
        setPending(false);
        onPendingChange(false);
      }
    }
  };
  const clear = () => {
    operation.current++;
    pendingRef.current = false;
    submittedText.current = null;
    setPending(false);
    setLocalError(null);
    onPendingChange(false);
    draftRef.current = '';
    setDraft('');
    controller.clearIntent?.();
    focusOpener.current = compact;
    setEditing(!compact);
    if (!compact) input.current?.focus();
  };

  return (
    <section className={`music-request${compact ? ' music-request--live' : ''}`} aria-label="music request">
      {!editing ? (
        <div className="music-request__rest">
          {state.intent ? <p className="music-request__summary">{state.intent.summary}</p> : null}
          <button ref={opener} className="music-request__edit" type="button" onClick={open}
            aria-label={state.intent || draft ? 'Edit music request' : 'Add a music request'}
            aria-expanded="false" aria-controls={`${id}-form`}>
            {state.intent ? 'edit' : draft ? 'edit request' : 'a mood, a song, a direction'}
            <span aria-hidden="true">{state.intent ? '↗' : '+'}</span>
          </button>
        </div>
      ) : (
        <form id={`${id}-form`} className="music-request__form" aria-label="describe your music"
          onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="sr-only" htmlFor={`${id}-input`}>Music request (optional)</label>
          <div className="music-request__pill">
            <input ref={input} id={`${id}-input`} value={draft} type="text" maxLength={INTENT_LIMITS.text}
              placeholder="A mood, a song, a direction…" autoComplete="off" enterKeyHint="send"
              aria-describedby={message ? `${id}-message` : undefined}
              onKeyDown={event => {
                if (event.key === 'Escape' && (compact || state.intent)) { event.preventDefault(); close(); }
              }}
              onChange={event => {
                draftRef.current = event.target.value;
                setDraft(event.target.value);
                setLocalError(null);
              }} />
            <button type="submit" className="music-request__submit" aria-label={loading ? 'Applying music request' : 'Apply music request'}
              disabled={loading || !available || !draft.trim()}>
              <span aria-hidden="true">{loading ? '···' : '↑'}</span>
            </button>
          </div>
          <div className="music-request__actions">
            {controller.clearIntent && (draft || state.intent || message) ? (
              <button type="button" onClick={clear}>clear request</button>
            ) : <span />}
            {compact || state.intent ? <button type="button" onClick={close}>done</button> : null}
          </div>
        </form>
      )}
      {message ? <p id={`${id}-message`} className={`music-request__message${alert ? ' music-request__message--error' : ''}`}
        role={alert ? 'alert' : 'status'}>{message}</p> : null}
      {editing && state.intent ? <p className="music-request__applied">{state.intent.summary}</p> : null}
      {state.intent && (constraints || sources.length > 0) ? (
        <details className="music-request__details">
          <summary>request details</summary>
          {constraints ? <p>{constraints}</p> : null}
          {sources.length > 0 ? <ul aria-label="request sources">
            {sources.map(source => <li key={source.id}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
            </li>)}
          </ul> : null}
        </details>
      ) : null}
    </section>
  );
}
