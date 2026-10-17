import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListeningPurpose, MusicSessionController, SessionUiState, Vote } from './contracts.ts';
import { useSessionState } from './use-session-state.ts';
import { MetricsPanel } from './MetricsPanel.tsx';
import { NowPlayingPanel } from './NowPlayingPanel.tsx';
import { ThumbsControls } from './ThumbsControls.tsx';
import { FlowVisualizer, Visualizer } from './Visualizer.tsx';
import { supportsFlowRenderer } from './viz/flow-renderer.ts';
import { TasteVerse } from './TasteVerse.tsx';
import { MomentsTray } from './MomentsTray.tsx';
import { SessionPortrait } from './SessionPortrait.tsx';
import { describeBlend, FEATURE_IDS } from './viz/describe.ts';
import { lookForBlend } from './viz/looks.ts';
import { SessionRecorder, type SessionLog, type SessionMoment } from './viz/session-log.ts';
import { createTasteField } from './viz/verse.ts';
import './ui.css';
import './hud.css';

export type PlayerScreenProps = {
  controller: MusicSessionController;
};

const VOTE_FLASH_MS = 700;
/** How often the session portrait samples what's playing. */
const SAMPLE_MS = 1000;
/** How long the "returning to…" caption stays up. */
const RECALL_CAPTION_MS = 6000;

/** Rough 0..1 loudness from the output spectrum, for the portrait's ring wobble. */
function loudness(analyser: AnalyserNode | null | undefined): number {
  if (!analyser) return 0.3;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const mean = data.reduce((sum, v) => sum + v, 0) / (data.length * 255);
  return Math.min(1, Math.max(0, (mean - 0.1) / 0.4));
}

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
 * hud corner panels (what's playing · measured signal) above, thumb lenses and
 * end session below. Purpose is optional pre-session setup; start, like, and
 * dislike are the only controls.
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
  const [portrait, setPortrait] = useState<SessionLog | null>(null);
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
      // A like also keeps the sound you were hearing, to come back to later.
      const moment = v === 'up' ? controller.captureMoment?.() ?? null : null;
      controller.vote(v); // synchronous, never blocks the button
      const now = Date.now();
      setLastVote({ v, at: now });
      recorder.vote(now, v);
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

  // Sample what's playing once a second for the session portrait.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const features = controller.getAudibleFeatures?.() ?? {};
      const look = lookForBlend(features);
      recorder.sample(Date.now(), {
        colorA: look.colorA,
        colorB: look.colorB,
        energy: loudness(controller.getAnalyser?.()),
        label: describeBlend(features),
      });
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [active, controller, recorder]);

  // Record each session from when it becomes active; when it ends, turn the
  // record into a portrait (errors just discard it).
  useEffect(() => {
    if (active) {
      if (!recorder.active) recorder.start(Date.now());
      return;
    }
    if (!recorder.active) return;
    const log = recorder.finish(Date.now(), controller.getTaste?.() ?? {});
    if (state.status === 'stopped') setPortrait(log);
    setMoments([]);
    setRecalling(null);
  }, [active, state.status, controller, recorder]);

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
        {/* no stage on prestart — the organism only exists while a session is active */}
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
            <fieldset className="purpose-choice" disabled={memoryAction === 'reset'}>
              <legend className="sr-only">start with</legend>
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
              setPortrait(null);
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
        {portrait ? <SessionPortrait log={portrait} onClose={() => setPortrait(null)} /> : null}
      </main>
    );
  }

  return (
    <main className="app app--live">
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
      <div className="app__scrim" aria-hidden="true" />
      <div className="hud">
        <NowPlayingPanel state={state} controller={controller} />
        <MetricsPanel controller={controller} />
      </div>
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
