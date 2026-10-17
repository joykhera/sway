import { useEffect, useRef, useState } from 'react';
import type { MusicSessionController, StreamLevels, Vote } from './contracts.ts';
import './thumbs.css';

export type ThumbsControlsProps = {
  onVote: (v: Vote) => void;
  lastVote: { v: Vote; at: number } | null;
  /**
   * Optional: when present (and it exposes `subscribeStats`), the clicked lens fills
   * in step with the controller's real `steerProgress`. Without it, a local timed
   * fill stands in so the indicator still works on mock/old paths.
   */
  controller?: MusicSessionController;
};

/** Phase of the "your change is coming" fill on the active lens. */
export type FillPhase = 'idle' | 'filling' | 'done' | 'fading';

/** Local stand-in duration when no real steer progress is available. */
export const FALLBACK_FILL_MS = 3000;
const TICK_MS = 100;
/** How long the full lens holds (pop + "now playing") before fading. */
export const FILL_HOLD_MS = 650;
/** Fade back to resting glass. */
export const FILL_FADE_MS = 700;
/** Below this display level the fill waits until progress truly hits 1. */
const HOLD_CEILING = 0.96;
/** Glyph inverts to ink once the fill passes this. */
const DEEP_AT = 0.6;
/** A p===1 sample this soon after a click, before any fresh p<1, is the previous steer. */
const STALE_WINDOW_MS = 600;

/**
 * Linear real-time progress → displayed fill. Ease-out cubic so it races early and
 * settles late, but never shows "full" until the steered audio is actually audible.
 */
export function displayFill(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p >= 1) return 1;
  return Math.min(HOLD_CEILING, 1 - (1 - p) ** 3);
}

const LIVE_TEXT: Record<FillPhase, string> = {
  idle: '',
  filling: 'changing…',
  done: 'now playing your change',
  fading: 'now playing your change',
};

function ThumbGlyph({ down = false }: { down?: boolean }) {
  return (
    <svg
      className="thumb__glyph"
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={down ? 'rotate(180 12 12)' : undefined}>
        <path d="M7 10v12" />
        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
      </g>
    </svg>
  );
}

type Engine = {
  vote: Vote | null;
  phase: FillPhase;
  /** 'timer' until the controller reports real progress for this vote. */
  mode: 'timer' | 'controller';
  clickedAt: number;
  /** Seen a p<1 sample since the click (so a p===1 is genuinely ours). */
  sawFresh: boolean;
  /** After completing, ignore lingering p===1 samples until null or a new click. */
  latched: boolean;
  ticker: ReturnType<typeof setInterval> | null;
  phaseTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * The only two steering controls: like it / change it. Buttons are never disabled —
 * voting is a synchronous local signal and the controller ignores votes it can't use.
 *
 * They double as the "next music is being generated" indicator: the clicked lens fills
 * from its centre outward as the steer approaches audibility, is full exactly when the
 * steered audio is playing, pops once, then fades back to glass. The fill level is
 * written straight to a `--fill` custom property — no React render per stats tick.
 */
export function ThumbsControls({ onVote, lastVote, controller }: ThumbsControlsProps) {
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const [ui, setUi] = useState<{ vote: Vote | null; phase: FillPhase }>({ vote: null, phase: 'idle' });

  const eng = useRef<Engine>({
    vote: null,
    phase: 'idle',
    mode: 'timer',
    clickedAt: 0,
    sawFresh: false,
    latched: false,
    ticker: null,
    phaseTimer: null,
  });

  // Imperative engine, rebuilt per render but only touching refs — callers always see the latest.
  const btnFor = (v: Vote) => (v === 'up' ? upRef.current : downRef.current);

  const writeFill = (v: Vote, value: number) => {
    const btn = btnFor(v);
    if (!btn) return;
    btn.style.setProperty('--fill', value.toFixed(3));
    if (value > DEEP_AT) btn.dataset.deep = '';
    else delete btn.dataset.deep;
  };

  const stopTicker = () => {
    const e = eng.current;
    if (e.ticker !== null) clearInterval(e.ticker);
    e.ticker = null;
  };

  const stopPhaseTimer = () => {
    const e = eng.current;
    if (e.phaseTimer !== null) clearTimeout(e.phaseTimer);
    e.phaseTimer = null;
  };

  const setPhase = (vote: Vote | null, phase: FillPhase) => {
    eng.current.vote = vote;
    eng.current.phase = phase;
    setUi({ vote, phase });
  };

  const reset = () => {
    stopTicker();
    stopPhaseTimer();
    writeFill('up', 0);
    writeFill('down', 0);
    setPhase(null, 'idle');
  };

  const complete = () => {
    const e = eng.current;
    if (e.vote === null || e.phase !== 'filling') return;
    const v = e.vote;
    stopTicker();
    stopPhaseTimer();
    e.latched = true;
    writeFill(v, 1);
    setPhase(v, 'done');
    e.phaseTimer = setTimeout(() => {
      setPhase(v, 'fading');
      e.phaseTimer = setTimeout(() => {
        e.phaseTimer = null;
        reset();
      }, FILL_FADE_MS);
    }, FILL_HOLD_MS);
  };

  const begin = (v: Vote, mode: Engine['mode']) => {
    const e = eng.current;
    stopTicker();
    stopPhaseTimer();
    const other: Vote = v === 'up' ? 'down' : 'up';
    writeFill(other, 0);
    writeFill(v, 0);
    e.mode = mode;
    e.clickedAt = Date.now();
    e.sawFresh = false;
    e.latched = false;
    setPhase(v, 'filling');
    if (mode === 'timer') {
      e.ticker = setInterval(() => {
        if (e.mode !== 'timer' || e.phase !== 'filling' || e.vote !== v) return;
        const p = (Date.now() - e.clickedAt) / FALLBACK_FILL_MS;
        if (p >= 1) complete();
        else writeFill(v, displayFill(p));
      }, TICK_MS);
    }
  };

  const onStats = (l: StreamLevels) => {
    const e = eng.current;
    const p = l.steerProgress;
    const sv = l.steerVote ?? null;

    if (typeof p !== 'number' || !Number.isFinite(p)) {
      // No steer pending. If we were tracking a real steer, it finished between samples.
      if (e.phase === 'filling' && e.mode === 'controller' && e.sawFresh) complete();
      e.latched = false;
      return;
    }

    if (e.phase === 'filling') {
      if (e.vote === null) return;
      if (sv !== null && sv !== e.vote) return; // stale steer from the other button
      if (p < 1) e.sawFresh = true;
      else if (!e.sawFresh && Date.now() - e.clickedAt < STALE_WINDOW_MS) return; // previous steer's tail
      if (e.mode === 'timer') {
        e.mode = 'controller';
        stopTicker();
      }
      if (p >= 1) complete();
      else writeFill(e.vote, displayFill(p));
      return;
    }

    // Idle: a steer started elsewhere (e.g. a keyboard vote) — adopt it, unless it's
    // the lingering tail of the one we just finished.
    if (e.phase === 'idle' && !e.latched && sv !== null && p < 1) {
      begin(sv, 'controller');
      e.sawFresh = true;
      writeFill(sv, displayFill(p));
    }
  };

  // Keep the subscription callback pointed at the latest closure without resubscribing.
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  useEffect(() => {
    if (!controller?.subscribeStats) return;
    return controller.subscribeStats((l) => onStatsRef.current(l));
  }, [controller]);

  useEffect(
    () => () => {
      const e = eng.current;
      if (e.ticker !== null) clearInterval(e.ticker);
      if (e.phaseTimer !== null) clearTimeout(e.phaseTimer);
    },
    [],
  );

  const handle = (v: Vote) => {
    onVote(v);
    begin(v, 'timer');
  };

  const cls = (v: Vote) => {
    let c = `thumb thumb--${v}`;
    if (lastVote?.v === v) c += ' thumb--voted';
    if (ui.vote === v && ui.phase !== 'idle') c += ` thumb--${ui.phase}`;
    return c;
  };

  const busy = (v: Vote) => (ui.vote === v && ui.phase === 'filling' ? true : undefined);

  return (
    <div className="thumbs" role="group" aria-label="steer the stream">
      <button
        ref={upRef}
        type="button"
        className={cls('up')}
        aria-label="like what you're hearing"
        aria-busy={busy('up')}
        onClick={() => handle('up')}
      >
        <span className="thumb__fill" aria-hidden="true" />
        <ThumbGlyph />
      </button>
      <button
        ref={downRef}
        type="button"
        className={cls('down')}
        aria-label="hear something different"
        aria-busy={busy('down')}
        onClick={() => handle('down')}
      >
        <span className="thumb__fill" aria-hidden="true" />
        <ThumbGlyph down />
      </button>
      <span className="thumbs__live" role="status" aria-live="polite">
        {LIVE_TEXT[ui.phase]}
      </span>
    </div>
  );
}
