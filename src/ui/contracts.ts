// What the UI consumes from Developer D's session controller (handoff §5, "Browser transport abstraction").
// Owned by B (src/ui/**). D's real controller in src/controller/** must be structurally compatible;
// D may import this type or mirror it. The in-repo mock lives in ./mock-controller.ts.

import type { ListeningPurpose, Vote, SessionState, MusicSessionController as SharedController } from '../shared/protocol.ts';

export type { ListeningPurpose, Vote };

/** `status` is intentionally an open string; the UI labels known values and shows unknown ones verbatim. */
export type SessionUiState = Omit<SessionState, 'status'> & {
  status: string;
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
  /** Call synchronously inside the user's Start gesture (autoplay policy). Idempotent while a session is active. */
  start(): Promise<void>;
  /** Synchronous local update; never blocks, never locks the buttons. Ignored when no session is active. */
  vote(v: Vote): void;
  /** Ends the session and releases audio. No-op when idle. A later `start()` must work again. */
  stop(): void;
  /**
   * Emits the current state to the listener synchronously on subscribe, then on every change.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (state: SessionUiState) => void): () => void;
}
