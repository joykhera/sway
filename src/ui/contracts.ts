// What the UI consumes from Developer D's session controller (handoff §5, "Browser transport abstraction").
// Owned by B (src/ui/**). D's real controller in src/controller/** must be structurally compatible;
// D may import this type or mirror it. The in-repo mock lives in ./mock-controller.ts.

import type { ListeningPurpose, Vote, SessionState, MusicSessionController as SharedController } from '../shared/protocol.ts';

export type { ListeningPurpose, Vote };

/** Opaque to the UI except for display: the prompt set behind a moment. */
export type MomentTarget = { features: Record<string, number>; prompts: { text: string; weight: number }[] };

/** `status` is intentionally an open string; the UI labels known values and shows unknown ones verbatim. */
export type SessionUiState = Omit<SessionState, 'status'> & {
  status: string;
};

/** One-line, humble explanation of how the learner responded to a vote. */
export type VoteDecision = {
  vote: Vote;
  kind: 'initial' | 'hold' | 'redirect' | 'variation' | 'probe' | 'intent';
  /** Learner's own reason text (may be rewritten shorter for display by the UI). */
  reason: string;
  phase: string;
  /** Date.now() when the vote was applied — lets the UI key/animate per vote. */
  at: number;
};

/** The blend the controller is steering toward, rendered as whisperable words. */
export type MusicSignature = {
  genre?: string;
  instrument?: string;
  mood?: string;
  texture?: string;
  /** Highest-weight prompt phrase the relay was last told to play. */
  focus?: string;
};

/** Live rendered-signal telemetry, ~10 Hz. Written straight to canvas — never re-render React per tick. */
export type StreamLevels = {
  /** 0..1 RMS of rendered output. */
  energy: number;
  /** Spectral-brightness proxy in Hz. */
  brightnessHz: number;
  /** Dominant-partial pitch estimate in Hz, or null when silent/indeterminate. */
  pitchHz: number | null;
  /** Audio buffered but not yet rendered. */
  bufferedMs: number;
  underruns: number;
  /** Generated audio blocks landed — bumps when a new part of the music exists. */
  generation: number;
  /**
   * Progress (0..1, linear in real time) of the most recent vote's steer becoming
   * audible: elapsed / (generation latency + buffer depth at vote time). Reaches
   * exactly 1 only once the steered audio is actually playing. Null/absent when
   * no steer is pending (no vote yet, or ~600 ms after completion).
   */
  steerProgress?: number | null;
  /** Which vote the pending steer belongs to; null/absent when none. */
  steerVote?: Vote | null;

};

export type KnownStatus =
  | 'idle'
  | 'connecting'
  | 'playing'
  | 'reconnecting'
  | 'unavailable'
  | 'stopped'
  | 'error';

export interface MusicSessionController extends Omit<SharedController, 'subscribe'> {
  /** Optional pre-session setup. Persistent controllers keep separate memory per purpose. */
  setPurpose?(purpose: ListeningPurpose): void;
  /** Clears all saved browser profiles and feedback while no session is active. */
  resetPreferences?(): Promise<void>;
  /** Returns a local feedback export as JSON; never sends it to another service. */
  exportFeedback?(): Promise<string>;
  /** Optional visualizer input: spectrum of what is playing. */
  getAnalyser?(): AnalyserNode | null;
  /** Optional visualizer input: feature weights estimated to be audible now (e.g. `{ jazz: 0.45, calm: 0.3 }`). */
  getAudibleFeatures?(): Record<string, number>;
  /** Optional: the learner's per-feature scores (positive = leaning toward). */
  getTaste?(): Record<string, number>;
  /** Optional: what is audible now, to revisit later. Null when nothing is playing. */
  captureMoment?(): MomentTarget | null;
  /** Optional: steer back toward a captured moment. Not a vote. */
  recallMoment?(moment: MomentTarget): void;
  /** Optional: gradually steer toward one feature (e.g. a tapped style word). Not a vote. */
  nudge?(feature: string): void;
  /** Call synchronously inside the user's Start gesture (autoplay policy). Idempotent while a session is active. */
  start(): Promise<void>;
  /** Synchronous local update; never blocks, never locks the buttons. Ignored when no session is active. */
  vote(v: Vote): void;
  /** Ends the session and releases audio. No-op when idle. A later `start()` must work again. */
  stop(): void;
  /**
   * Emits the current state to the listener synchronously on subscribe, then on every change
   * (including signature-only changes — steering updates the identity without touching status).
   * Returns an unsubscribe function.
   */
  subscribe(listener: (state: SessionUiState) => void): () => void;
  /**
   * Optional: emits live rendered-signal levels ~10 Hz while a session is active.
   * Emits the latest known snapshot synchronously on subscribe (zeros when idle).
   * Visualizers should write to canvas directly rather than round-tripping React state per tick.
   */
  subscribeStats?(listener: (levels: StreamLevels) => void): () => void;
}
