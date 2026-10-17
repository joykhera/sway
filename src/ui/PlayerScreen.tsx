import { useCallback, useEffect, useState } from 'react';
import type { ListeningPurpose, MusicSessionController, SessionUiState, Vote } from './contracts.ts';
import { useSessionState } from './use-session-state.ts';
import { StatusChip } from './StatusChip.tsx';
import { ThumbsControls } from './ThumbsControls.tsx';
import { Visualizer } from './Visualizer.tsx';
import './ui.css';

export type PlayerScreenProps = {
  controller: MusicSessionController;
};

const VOTE_FLASH_MS = 700;
const PURPOSES: { value: ListeningPurpose; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'relax', label: 'Relax' },
  { value: 'energy', label: 'Energy' },
  { value: 'explore', label: 'Explore' },
  { value: 'crazy', label: 'Crazy' },
];

function memoryStatus(state: SessionUiState, purposeLabel: string): string | null {
  switch (state.memory) {
    case 'loading': return 'Loading this browser’s preferences…';
    case 'saving': return `Saving ${purposeLabel} feedback on this browser…`;
    case 'unavailable': return 'Local saving unavailable. Preferences are not being saved.';
    case 'ready': {
      const votes = state.savedVotes;
      if (votes === undefined) return 'Local memory ready.';
      if (votes === 0) return `No saved feedback for ${purposeLabel} yet.`;
      return `${purposeLabel} · ${votes} saved ${votes === 1 ? 'vote' : 'votes'} on this browser.`;
    }
    default: return null;
  }
}

/**
 * The whole visible app: a centered pre-start view, or the live session view
 * (status chip · breathing ring · thumbs · end session). Purpose is optional
 * pre-session setup; the listening view stays focused on the music and feedback.
 */
export function PlayerScreen({ controller }: PlayerScreenProps) {
  const state = useSessionState(controller);
  const [lastVote, setLastVote] = useState<{ v: Vote; at: number } | null>(null);
  const [localPurpose, setLocalPurpose] = useState<ListeningPurpose>('explore');
  const [memoryAction, setMemoryAction] = useState<'export' | 'reset' | null>(null);
  const [memoryNotice, setMemoryNotice] = useState<{ text: string; error: boolean } | null>(null);
  const purpose = state.purpose ?? localPurpose;
  const purposeLabel = PURPOSES.find(option => option.value === purpose)!.label;
  const savedVotes = state.savedVotes;
  const memoryText = memoryStatus(state, purposeLabel);

  const exportFeedback = async () => {
    if (!controller.exportFeedback || memoryAction) return;
    setMemoryAction('export');
    setMemoryNotice(null);
    try {
      const json = await controller.exportFeedback();
      JSON.parse(json); // Avoid handing the listener a mislabeled non-JSON file.
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = `sway-feedback-${new Date().toISOString().slice(0, 10)}.json`;
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        // Let the browser begin reading the URL before releasing its bytes.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setMemoryNotice({ text: 'Feedback export prepared.', error: false });
    } catch {
      setMemoryNotice({ text: 'Could not export feedback. Try again.', error: true });
    } finally {
      setMemoryAction(null);
    }
  };

  const resetPreferences = async () => {
    if (!controller.resetPreferences || memoryAction) return;
    setMemoryAction('reset');
    setMemoryNotice(null);
    try {
      await controller.resetPreferences();
      setMemoryNotice({ text: 'All saved profiles and feedback cleared from this browser.', error: false });
    } catch {
      setMemoryNotice({ text: 'Could not confirm the reset. Saved data may remain.', error: true });
    } finally {
      setMemoryAction(null);
    }
  };

  // 'error' is terminal-but-recoverable: the pre-start view offers the way back
  // (start() accepts 'error'), with lastError shown for context.
  const active =
    state.status !== 'idle' && state.status !== 'stopped' && state.status !== 'error';

  // Brief visual pulse on the voted side; auto-clears.
  useEffect(() => {
    if (!lastVote) return;
    const timer = setTimeout(() => setLastVote(null), VOTE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [lastVote]);

  const handleVote = useCallback(
    (v: Vote) => {
      controller.vote(v); // synchronous, never blocks the button
      setLastVote({ v, at: Date.now() });
    },
    [controller],
  );

  // Arrow keys steer only while a session is active.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleVote('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleVote('down');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, handleVote]);

  if (!active) {
    return (
      <main className="app app--prestart">
        <section className="prestart">
          <h1 className="wordmark">sway</h1>
          <p className="tagline">infinite instrumental stream — it learns what you like</p>
          {state.status === 'stopped' ? <p className="prestart__hint">session ended</p> : null}
          {state.status === 'error' ? (
            <p className="prestart__hint prestart__hint--error" role="alert">
              {state.lastError ?? 'something went wrong'}
            </p>
          ) : null}
          {controller.setPurpose ? (
            <fieldset className="purpose-choice" disabled={memoryAction === 'reset'}>
              <legend>start with</legend>
              <div className="purpose-choice__options">
                {PURPOSES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={memoryAction === 'reset'}
                    aria-pressed={purpose === option.value}
                    onClick={() => {
                      // An explicit choice during restoration must win even if
                      // it matches the temporary default shown before storage loads.
                      if (option.value === purpose && state.memory !== 'loading') return;
                      controller.setPurpose?.(option.value);
                      setLocalPurpose(option.value);
                      setMemoryNotice(null);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {state.memory === 'ready' || state.memory === 'saving' ? (
                <p className="purpose-choice__hint">Each profile keeps its own preferences on this browser.</p>
              ) : null}
            </fieldset>
          ) : null}
          <button
            type="button"
            className="start-button"
            aria-label="start listening"
            disabled={memoryAction === 'reset'}
            onClick={() => {
              // Called synchronously inside the gesture (autoplay policy). Never awaited —
              // errors surface through session state, not this promise.
              controller.start().catch(() => { });
              setMemoryNotice(null);
            }}
          >
            start listening
          </button>
          {memoryText || controller.exportFeedback || controller.resetPreferences ? (
            <div className="local-memory">
              {memoryText ? <p className="local-memory__status" role="status">{memoryText}</p> : null}
              <div className="local-memory__actions">
                {controller.exportFeedback ? (
                  <button type="button" aria-label="export feedback as JSON" disabled={memoryAction !== null}
                    onClick={() => { void exportFeedback(); }}>
                    {memoryAction === 'export' ? 'preparing export…' : 'export feedback'}
                  </button>
                ) : null}
                {controller.resetPreferences ? (
                  <button type="button" aria-label="reset all saved profiles and feedback on this browser"
                    disabled={memoryAction !== null || state.memory === 'loading'}
                    onClick={() => { void resetPreferences(); }}>
                    {memoryAction === 'reset' ? 'resetting…' : 'reset all profiles'}
                  </button>
                ) : null}
              </div>
              {memoryNotice ? (
                <p className={`local-memory__notice${memoryNotice.error ? ' local-memory__notice--error' : ''}`}
                  role={memoryNotice.error ? 'alert' : 'status'}>{memoryNotice.text}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app app--live">
      <header className="app__top">
        <StatusChip status={state.status} lastError={state.lastError} />
      </header>
      <div className="app__stage">
        <Visualizer active={active} lastVote={lastVote} />
      </div>
      <footer className="app__controls">
        <ThumbsControls onVote={handleVote} lastVote={lastVote} />
        <button
          type="button"
          className="end-session"
          aria-label="end session"
          onClick={() => controller.stop()}
        >
          end session
        </button>
        {state.memory ? (
          <p className="local-memory__live" role="status">
            {state.memory === 'ready' && savedVotes !== undefined && savedVotes > 0
              ? 'Saved on this browser.' : memoryText}
          </p>
        ) : null}
      </footer>
    </main>
  );
}
