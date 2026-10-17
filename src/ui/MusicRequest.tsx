import { useEffect, useId, useRef, useState } from 'react';
import type { MusicSessionController, SessionUiState } from './contracts.ts';
import { INTENT_LIMITS } from '../shared/intent.ts';

type Props = {
  controller: MusicSessionController;
  state: SessionUiState;
  compact?: boolean;
  disabled?: boolean;
  onPendingChange(pending: boolean): void;
};

function sourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** A request changes musical direction; it never starts playback on its own. */
export function MusicRequest({ controller, state, compact = false, disabled = false, onPendingChange }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(state.intentText ?? '');
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const operation = useRef(0);
  const pendingRef = useRef(false);
  const previousText = useRef(state.intentText ?? '');

  useEffect(() => {
    const before = previousText.current;
    const after = state.intentText ?? '';
    // A response must not overwrite a new draft typed while the request was pending.
    setDraft(current => current === before ? after : current);
    previousText.current = after;
  }, [state.intentText]);

  useEffect(() => () => {
    operation.current++;
    onPendingChange(false);
  }, [controller, onPendingChange]);

  if (!controller.interpretText) return null;
  const loading = pending || state.intentStatus === 'loading';
  const available = state.intentAvailable !== false;
  const alert = localError || state.intentStatus === 'error' || state.intentStatus === 'unsupported' || !available;
  const message = localError
    ?? (loading ? 'Finding a direction for your music…'
      : state.intentMessage ?? (!available ? 'Text requests are unavailable right now.'
        : state.intentStatus === 'clarify' ? 'Add a little more detail about the music you want.'
          : state.intentStatus === 'unsupported' ? 'Try describing a mood, instrument, or scene.'
            : state.intentStatus === 'error' ? 'Could not apply your request. Please try again.' : undefined));
  const showForm = !compact || expanded;
  const references = state.intent?.references?.flatMap(reference => {
    const url = sourceUrl(reference.url);
    return url ? [{ ...reference, url }] : [];
  }) ?? [];

  const submit = async () => {
    const text = draft.trim();
    if (!text || loading || pendingRef.current || !available || disabled) return;
    const current = ++operation.current;
    pendingRef.current = true;
    setPending(true);
    setLocalError(null);
    onPendingChange(true);
    try {
      await controller.interpretText!(text);
    } catch {
      // Provider details and exceptions are not product copy.
      if (current === operation.current) setLocalError('Could not apply your request. Please try again.');
    } finally {
      if (current === operation.current) {
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
    onPendingChange(false);
    setLocalError(null);
    setDraft('');
    controller.clearIntent?.();
  };

  return (
    <section className={`music-request${compact ? ' music-request--compact' : ''}`} aria-label="music request">
      {compact ? (
        <button type="button" className="music-request__toggle" aria-expanded={expanded}
          aria-controls={`${id}-form`} onClick={() => setExpanded(value => !value)}>
          {expanded ? 'close request' : state.intent ? 'edit request' : 'add a request'}
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      ) : null}
      {showForm ? (
        <form id={`${id}-form`} className="music-request__form" aria-label="describe your music"
          onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label htmlFor={`${id}-input`}>What would you like to hear? <span>(optional)</span></label>
          <div className="music-request__entry">
            <input id={`${id}-input`} type="text" value={draft} maxLength={INTENT_LIMITS.text} disabled={disabled}
              placeholder="Warm jazz for a rainy afternoon"
              onChange={event => { setDraft(event.target.value); setLocalError(null); }}
              aria-describedby={message ? `${id}-message` : undefined} />
            <button type="submit" className="music-request__apply"
              disabled={disabled || loading || !available || !draft.trim()}>
              {loading ? 'applying…' : 'Apply'}
            </button>
          </div>
          {controller.clearIntent && (draft || state.intent || state.intentStatus && state.intentStatus !== 'idle' || localError) ? (
            <button type="button" className="music-request__clear" disabled={disabled} onClick={clear}>clear request</button>
          ) : null}
        </form>
      ) : null}
      {message ? <p id={`${id}-message`} className={`music-request__message${alert ? ' music-request__message--error' : ''}`}
        role={alert ? 'alert' : 'status'}>{message}</p> : null}
      {state.intent?.summary ? <p className="music-request__summary">{state.intent.summary}</p> : null}
      {showForm && references.length > 0 ? (
        <ul className="music-request__sources" aria-label="request sources">
          {references.map(reference => <li key={reference.id}>
            <a href={reference.url} target="_blank" rel="noopener noreferrer">{reference.title}</a>
          </li>)}
        </ul>
      ) : null}
    </section>
  );
}
