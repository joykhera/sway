import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { ListeningPurpose, MusicSessionController, Vote } from './contracts.ts';
import { useSessionState } from './use-session-state.ts';
import { MetricsPanel } from './MetricsPanel.tsx';
import { NowPlayingPanel } from './NowPlayingPanel.tsx';
import { ThumbsControls } from './ThumbsControls.tsx';
import { Visualizer } from './Visualizer.tsx';
import type { VisualizerProps } from './Visualizer.tsx';
import './ui.css';
import './hud.css';

export type PlayerScreenProps = {
  controller: MusicSessionController;
};

const VOTE_FLASH_MS = 700;
const PURPOSES: { value: ListeningPurpose; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'relax', label: 'Relax' },
  { value: 'energy', label: 'Energy' },
  { value: 'explore', label: 'Explore' },
];

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
 * The whole visible app: a centered pre-start view, or the live session view —
 * the audio organism filling the viewport with the chrome floating over it:
 * hud corner panels (what's playing · measured signal) above, thumb lenses and
 * end session below. Purpose is optional pre-session setup; start, like, and
 * dislike are the only controls.
 */
export function PlayerScreen({ controller }: PlayerScreenProps) {
  const state = useSessionState(controller);
  const [lastVote, setLastVote] = useState<{ v: Vote; at: number } | null>(null);
  const [purpose, setPurpose] = useState<ListeningPurpose>('explore');

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
        <div className="app__stage">
          <StageVisualizer controller={controller} active={false} lastVote={null} />
        </div>
        <section className="prestart">
          <h1 className="wordmark">sway</h1>
          {state.status === 'stopped' ? (
            <p className="prestart__hint">session ended</p>
          ) : null}
          {state.status === 'error' ? (
            <p className="prestart__hint prestart__hint--error" role="alert">
              {state.lastError ?? 'something went wrong'}
            </p>
          ) : null}
          {controller.setPurpose ? (
            <fieldset className="purpose-choice">
              <legend className="sr-only">start with</legend>
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
      <div className="app__stage">
        <StageVisualizer controller={controller} active={active} lastVote={lastVote} />
      </div>
      <div className="app__scrim" aria-hidden="true" />
      <div className="hud">
        <NowPlayingPanel state={state} controller={controller} />
        <MetricsPanel controller={controller} />
      </div>
      <footer className="app__controls">
        <ThumbsControls onVote={handleVote} lastVote={lastVote} controller={controller} />
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
