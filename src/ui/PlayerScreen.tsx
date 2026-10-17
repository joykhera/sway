import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListeningPurpose, MusicSessionController, Vote } from './contracts.ts';
import { useSessionState } from './use-session-state.ts';
import { StatusChip } from './StatusChip.tsx';
import { ThumbsControls } from './ThumbsControls.tsx';
import { FlowVisualizer, Visualizer } from './Visualizer.tsx';
import { supportsFlowRenderer } from './viz/flow-renderer.ts';
import { TasteConstellation } from './TasteConstellation.tsx';
import { MomentsTray } from './MomentsTray.tsx';
import { SessionPortrait } from './SessionPortrait.tsx';
import { describeBlend } from './viz/describe.ts';
import { lookForBlend } from './viz/looks.ts';
import { SessionRecorder, type SessionLog, type SessionMoment } from './viz/session-log.ts';
import './ui.css';

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
  const recorder = useRef(new SessionRecorder()).current;
  const [moments, setMoments] = useState<SessionMoment[]>([]);
  const [recalling, setRecalling] = useState<SessionMoment | null>(null);
  const [portrait, setPortrait] = useState<SessionLog | null>(null);

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
      const moment = v === 'up' ? controller.captureMoment?.() : null;
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
              setPortrait(null);
            }}
          >
            start listening
          </button>
        </section>
        {portrait ? <SessionPortrait log={portrait} onClose={() => setPortrait(null)} /> : null}
      </main>
    );
  }

  return (
    <main className="app app--live">
      {flow ? (
        <FlowVisualizer active={active} lastVote={lastVote} source={controller} onUnavailable={() => setFlow(false)} />
      ) : null}
      {controller.getTaste ? <TasteConstellation source={controller} ringFraction={flow ? 0.42 : 0.35} /> : null}
      <header className="app__top">
        <StatusChip status={state.status} lastError={state.lastError} />
      </header>
      <div className="app__stage">
        {flow ? null : <Visualizer active={active} lastVote={lastVote} />}
      </div>
      <footer className="app__controls">
        <MomentsTray moments={moments} onRecall={handleRecall} recalling={recalling} />
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
