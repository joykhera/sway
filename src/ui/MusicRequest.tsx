import { useEffect, useId, useRef, useState } from 'react';
import type { MusicSessionController, SessionUiState } from './contracts.ts';
import { INTENT_LIMITS } from '../shared/intent.ts';
import './music-request.css';

type Props = {
  controller: MusicSessionController;
  state: SessionUiState & { intentApplying?: boolean };
  compact?: boolean;
  onPendingChange(pending: boolean): void;
};

/** Text supplies a direction. Applying it never starts the audio. */
export function MusicRequest({ controller, state, compact = false, onPendingChange }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(state.intentText ?? '');
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  const previousText = useRef(state.intentText ?? '');
  const operation = useRef(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    const before = previousText.current;
    const after = state.intentText ?? '';
    // Restoration and slow replies must not overwrite a draft being edited.
    if (draftRef.current === before) {
      draftRef.current = after;
      setDraft(after);
    }
    previousText.current = after;
  }, [state.intentText]);

  useEffect(() => {
    pendingRef.current = false;
    setPending(false);
    return () => {
      operation.current++;
      onPendingChange(false);
    };
  }, [controller, onPendingChange]);

  if (!controller.interpretText) return null;
  const requestPending = pending || state.intentStatus === 'loading';
  const loading = requestPending || state.intentApplying === true;
  const available = state.intentAvailable !== false;
  const alert = Boolean(localError || state.intentStatus === 'error' || state.intentStatus === 'unsupported' || !available);
  // Successful interpretation has no content panel. Messages only explain a
  // failed/blocked action or ask for the detail needed to proceed.
  const message = localError ?? (requestPending ? undefined : state.intentMessage
    ?? (state.intentStatus === 'clarify' ? 'What mood or instruments did you have in mind?'
      : state.intentStatus === 'unsupported' ? 'Try a mood, style, or instrument.'
        : state.intentStatus === 'error' ? 'Could not apply that. Try again.'
          : !available ? 'Text requests are unavailable right now.' : undefined));

  const submit = async () => {
    const text = draftRef.current.trim();
    if (!text || requestPending || pendingRef.current || !available) return;
    const current = ++operation.current;
    pendingRef.current = true;
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
    setPending(false);
    setLocalError(null);
    onPendingChange(false);
    draftRef.current = '';
    setDraft('');
    controller.clearIntent?.();
    input.current?.focus();
  };

  return (
    <section className={`music-request${compact ? ' music-request--live' : ''}`} aria-label="music request">
      <form id={`${id}-form`} aria-label="describe your music"
        onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="sr-only" htmlFor={`${id}-input`}>Music request (optional)</label>
        <div className="music-request__pill">
          <input ref={input} id={`${id}-input`} value={draft} type="text" maxLength={INTENT_LIMITS.text}
            placeholder="A mood, a song, a direction…" autoComplete="off" enterKeyHint="send"
            aria-describedby={message ? `${id}-message` : undefined}
            onChange={event => {
              draftRef.current = event.target.value;
              setDraft(event.target.value);
              setLocalError(null);
            }} />
          {loading ? <span className="music-request__loading" role="status" aria-label="Applying music request">
            <span className="music-request__spinner" aria-hidden="true" />
            <span className="sr-only">Applying music request</span>
          </span> : null}
          {controller.clearIntent && (draft || state.intent || message || loading) ? (
            <button type="button" className="music-request__clear" aria-label="Clear music request" onClick={clear}>
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
          <button type="submit" className="music-request__submit" aria-label="Apply music request"
            disabled={requestPending || !available || !draft.trim()}>
            <span aria-hidden="true">↑</span>
          </button>
        </div>
      </form>
      {message ? <p id={`${id}-message`} className={`music-request__message${alert ? ' music-request__message--error' : ''}`}
        role={alert ? 'alert' : 'status'}>{message}</p> : null}
    </section>
  );
}
