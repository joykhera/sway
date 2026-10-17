import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { MusicSessionController, MusicSignature, Vote } from './contracts.ts';
import { useSessionState } from './use-session-state.ts';
import { StatusChip } from './StatusChip.tsx';
import { ThumbsControls } from './ThumbsControls.tsx';
import { Visualizer } from './Visualizer.tsx';
import type { VisualizerProps } from './Visualizer.tsx';
import './ui.css';

export type PlayerScreenProps = {
  controller: MusicSessionController;
};

const VOTE_FLASH_MS = 700;

/**
 * The audio lane's Visualizer rebuild drinks live telemetry straight from the
 * controller (`subscribeStats`) — its `controller` prop lands with that work.
 * Widening the props here keeps this file honest before and after: extra props
 * are ignored by the current ring, required by the organism to come.
 */
const StageVisualizer: ComponentType<
  VisualizerProps & { controller: MusicSessionController }
> = Visualizer;

/**
 * Render the stream's musical identity as one whispered line —
 * `lofi · piano · calm · sparse — "warm ambient pads"`. Blank fields drop out;
 * a lone focus still whispers. Null when there is nothing to say, so the UI
 * stays silent rather than wearing an empty label.
 */
function signatureLine(signature: MusicSignature | undefined): string | null {
  if (!signature) return null;
  const parts = [
    signature.genre,
    signature.instrument,
    signature.mood,
    signature.texture,
  ]
    .map((field) => field?.trim())
    .filter((field): field is string => Boolean(field));
  const focus = signature.focus?.trim();
  const head = parts.join(' · ');
  const line = focus ? (head ? `${head} — "${focus}"` : `"${focus}"`) : head;
  return line.length > 0 ? line : null;
}

/**
 * The whole visible app: a centered pre-start view, or the live session view —
 * the audio organism filling the viewport with the chrome floating over it as
 * liquid glass (status pill · signature whisper · thumb lenses · end session).
 * Start, like, and dislike are the only controls.
 */
export function PlayerScreen({ controller }: PlayerScreenProps) {
  const state = useSessionState(controller);
  const [lastVote, setLastVote] = useState<{ v: Vote; at: number } | null>(null);

  // 'error' is terminal-but-recoverable: the pre-start view offers the way back
  // (start() accepts 'error'), with lastError shown for context.
  const active =
    state.status !== 'idle' && state.status !== 'stopped' && state.status !== 'error';

  const whisper = active ? signatureLine(state.signature) : null;

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
        <div className="app__stage">
          <StageVisualizer controller={controller} active={false} lastVote={null} />
        </div>
        <section className="prestart">
          <h1 className="wordmark">sway</h1>
          <p className="tagline">infinite instrumental stream — it learns what you like</p>
          {state.status === 'stopped' ? (
            <p className="prestart__hint">session ended</p>
          ) : null}
          {state.status === 'error' ? (
            <p className="prestart__hint prestart__hint--error">
              {state.lastError ?? 'something went wrong'}
            </p>
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
      <div className="app__stage">
        <StageVisualizer controller={controller} active={active} lastVote={lastVote} />
      </div>
      <header className="app__top">
        <StatusChip status={state.status} lastError={state.lastError} />
      </header>
      {whisper ? <p className="signature-whisper">{whisper}</p> : null}
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
