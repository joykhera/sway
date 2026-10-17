// What the UI consumes from Developer D's session controller (handoff §5, "Browser transport abstraction").
// Owned by B (src/ui/**). D's real controller in src/controller/** must be structurally compatible;
// D may import this type or mirror it. The in-repo mock lives in ./mock-controller.ts.

import type { ListeningPurpose, Vote } from '../shared/protocol.ts';

export type { ListeningPurpose, Vote };

/** `status` is intentionally an open string; the UI labels known values and shows unknown ones verbatim. */
export type SessionUiState = {
  status: string;
  lastError?: string;
  /** What the stream is currently steering toward — the "musical identity" the UI whispers. */
  signature?: MusicSignature;
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
};

export type KnownStatus =
  | 'idle'
  | 'connecting'
  | 'playing'
  | 'reconnecting'
  | 'unavailable'
  | 'stopped'
  | 'error';

export interface MusicSessionController {
  /** Optional pre-session setup. Changing purpose starts a fresh preference session. */
  setPurpose?(purpose: ListeningPurpose): void;
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
