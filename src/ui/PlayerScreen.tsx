import { useCallback, useEffect, useState } from 'react';
import type { ListeningPurpose, MusicSessionController, Vote } from './contracts.ts';
import { useSessionState } from './use-session-state.ts';
import { StatusChip } from './StatusChip.tsx';
import { ThumbsControls } from './ThumbsControls.tsx';
import { FlowVisualizer, Visualizer } from './Visualizer.tsx';
import { supportsFlowRenderer } from './viz/flow-renderer.ts';
import './ui.css';

export type PlayerScreenProps = {
  controller: MusicSessionController;
};

const VOTE_FLASH_MS = 700;

/** The full-screen piece needs WebGL2 and motion; `?ring` keeps the original ring for comparison. */
function wantsFlow(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).has('ring')) return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return supportsFlowRenderer();
}
const PURPOSES: { value: ListeningPurpose; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'relax', label: 'Relax' },
  { value: 'energy', label: 'Energy' },
  { value: 'explore', label: 'Explore' },
];

/**
 * The whole visible app: a centered pre-start view, or the live session view
 * (status chip · breathing ring · thumbs · end session). Purpose is optional
 * pre-session setup; the listening view stays focused on the music and feedback.
 */
export function PlayerScreen({ controller }: PlayerScreenProps) {
  const state = useSessionState(controller);
  const [lastVote, setLastVote] = useState<{ v: Vote; at: number } | null>(null);
  const [purpose, setPurpose] = useState<ListeningPurpose>('explore');
  const [flow, setFlow] = useState(wantsFlow);

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
            <fieldset className="purpose-choice">
              <legend>start with</legend>
              <div className="purpose-choice__options">
                {PURPOSES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={purpose === option.value}
                    onClick={() => {
                      if (option.value === purpose) return;
                      controller.setPurpose?.(option.value);
                      setPurpose(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {state.status === 'stopped' ? (
                <p className="purpose-choice__hint">Changing this starts a fresh preference session.</p>
              ) : null}
            </fieldset>
          ) : null}
          <button
            type="button"
            className="start-button"
            aria-label="start listening"
            onClick={() => {
              // Called synchronously inside the gesture (autoplay policy). Never awaited —
              // errors surface through session state, not this promise.
              controller.start().catch(() => { });
            }}
          >
            start listening
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app app--live">
      {flow ? (
        <FlowVisualizer active={active} lastVote={lastVote} source={controller} onUnavailable={() => setFlow(false)} />
      ) : null}
      <header className="app__top">
        <StatusChip status={state.status} lastError={state.lastError} />
      </header>
      <div className="app__stage">
        {flow ? null : <Visualizer active={active} lastVote={lastVote} />}
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
      </footer>
    </main>
  );
}
