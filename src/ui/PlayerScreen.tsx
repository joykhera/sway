import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListeningPurpose, MusicSessionController, SessionUiState, Vote } from './contracts.ts';
import { useSessionState } from './use-session-state.ts';
import { ThumbsControls } from './ThumbsControls.tsx';
import { FlowVisualizer, Visualizer } from './Visualizer.tsx';
import { supportsFlowRenderer } from './viz/flow-renderer.ts';
import { TasteVerse } from './TasteVerse.tsx';
import { MomentsTray } from './MomentsTray.tsx';
import { MusicRequest } from './MusicRequest.tsx';
import { describeBlend, FEATURE_IDS } from './viz/describe.ts';
import { lookForBlend } from './viz/looks.ts';
import { SessionRecorder, type SessionMoment } from './viz/session-log.ts';
import { createTasteField } from './viz/verse.ts';
import './ui.css';

export type PlayerScreenProps = {
  controller: MusicSessionController;
};

const VOTE_FLASH_MS = 700;
/** How long the "returning to…" caption stays up. */
const RECALL_CAPTION_MS = 6000;

/** The full-screen piece needs WebGL2 and motion; `?ring` keeps the original ring for comparison. */
function wantsFlow(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).has('ring')) return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return supportsFlowRenderer();
}
/** Visually-hidden status line — the only words the live view keeps, for screen readers. */
const SR_LABELS: Record<string, string> = {
  connecting: 'connecting…',
  playing: 'playing',
  reconnecting: 'reconnecting…',
  unavailable: 'temporarily unavailable',
  stopped: 'stopped',
  error: 'something went wrong',
};

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
    case 'unavailable': return 'Some changes may not be saved on this browser.';
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
 * The whole visible app: a centered pre-start view, or the live session view —
 * the audio organism filling the viewport with the chrome floating over it:
 * a quiet optional request above, thumb lenses and end session below.
 * Purpose is optional pre-session setup; text never starts playback by itself.
 */
export function PlayerScreen({ controller }: PlayerScreenProps) {
  const state = useSessionState(controller);
  const [lastVote, setLastVote] = useState<{ v: Vote; at: number } | null>(null);
  const [flow, setFlow] = useState(wantsFlow);
  const recorder = useRef(new SessionRecorder()).current;
  // Where the taste lettering sits, so the smoke can reach for the words it's playing.
  const field = useRef(createTasteField()).current;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [moments, setMoments] = useState<SessionMoment[]>([]);
  const [recalling, setRecalling] = useState<SessionMoment | null>(null);
  const [localPurpose, setLocalPurpose] = useState<ListeningPurpose>('explore');
  const [intentPending, setIntentPending] = useState(false);
  const purpose = state.purpose ?? localPurpose;
  const purposeLabel = PURPOSES.find(option => option.value === purpose)!.label;
  const savedVotes = state.savedVotes;
  const memoryText = memoryStatus(state, purposeLabel);

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
      // A like also keeps the sound you were hearing, to come back to later.
      const moment = v === 'up' ? controller.captureMoment?.() ?? null : null;
      controller.vote(v); // synchronous, never blocks the button
      const now = Date.now();
      setLastVote({ v, at: now });
      if (moment) {
        setMoments(recorder.moment(now, {
          label: describeBlend(moment.features),
          color: lookForBlend(moment.features).colorA,
          target: moment,
        }));
      }
    },
    [controller, recorder],
  );

  const handleRecall = useCallback(
    (moment: SessionMoment) => {
      controller.recallMoment?.(moment.target);
      setRecalling(moment);
    },
    [controller],
  );

  useEffect(() => {
    if (!recalling) return;
    const timer = setTimeout(() => setRecalling(null), RECALL_CAPTION_MS);
    return () => clearTimeout(timer);
  }, [recalling]);

  // Moments belong to one session: start a fresh list when it becomes active, clear it when it ends.
  useEffect(() => {
    if (active) {
      if (!recorder.active) recorder.start(Date.now());
      return;
    }
    if (!recorder.active) return;
    recorder.finish();
    setMoments([]);
    setRecalling(null);
  }, [active, recorder]);

  // Arrow keys steer only while a session is active.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (e.defaultPrevented || target instanceof HTMLElement
        && (target.matches('input, textarea, select') || target.isContentEditable)) return;
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
        {/* no stage on prestart — the organism only exists while a session is active */}
        <section className="prestart">
          <h1 className="wordmark">sway</h1>
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
                      // An explicit choice during restoration must win even if
                      // it matches the temporary default shown before storage loads.
                      if (option.value === purpose && state.memory !== 'loading') return;
                      controller.setPurpose?.(option.value);
                      setLocalPurpose(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <MusicRequest key={purpose} controller={controller} state={state} onPendingChange={setIntentPending} />
          <button
            type="button"
            className="start-button"
            aria-label="start listening"
            disabled={intentPending || state.intentStatus === 'loading'}
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
      <p className="sr-only" role="status">
        <span>{SR_LABELS[state.status] ?? state.status}</span>
        {state.lastError ? <span>{state.lastError}</span> : null}
      </p>
      <MusicRequest key={purpose} controller={controller} state={state} compact onPendingChange={setIntentPending} />
      <div className="app__stage" ref={stageRef}>
        {flow ? (
          <FlowVisualizer active={active} lastVote={lastVote} source={controller} field={field} onUnavailable={() => setFlow(false)} />
        ) : (
          <Visualizer active={active} lastVote={lastVote} />
        )}
      </div>
      {controller.getTaste ? (
        <TasteVerse
          source={controller}
          ringFraction={flow ? 0.42 : 0.35}
          lastVote={lastVote}
          field={flow ? field : undefined}
          anchor={flow ? undefined : () => stageRef.current?.querySelector('.visualizer')?.getBoundingClientRect()}
          onPick={controller.nudge ? (id) => controller.nudge?.(id) : undefined}
        />
      ) : null}
      {controller.nudge ? (
        // The ring of words is a canvas; keyboard and screen-reader users steer from here.
        <div className="sr-only" role="group" aria-label="lean the music toward a style">
          {FEATURE_IDS.map((id) => (
            <button key={id} type="button" onClick={() => controller.nudge?.(id)}>more {id}</button>
          ))}
        </div>
      ) : null}

      <footer className="app__controls">
        <MomentsTray moments={moments} onRecall={handleRecall} recalling={recalling} />
        <ThumbsControls onVote={handleVote} lastVote={lastVote} controller={controller} />
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
