// Application protocol between browser and relay (NOT Google's wire protocol).
// Owned by D after the initial scaffold; changes need a small PR approved by affected owners.
// Browser-safe: no Node imports.

export type Vote = 'up' | 'down';
export type ListeningPurpose = 'focus' | 'relax' | 'energy' | 'explore';

// Lyria normalizes weights to sum to 1.0, so only ratios between prompts matter.
export type WeightedPrompt = { text: string; weight: number };

export type StreamConfig = {
  density?: number;     // 0..1, optional
  brightness?: number;  // 0..1, optional
  temperature?: number; // use provider defaults initially
};

export type ClientMessage =
  | { type: 'start'; prompts: WeightedPrompt[]; config?: StreamConfig }
  | { type: 'steer'; revision: number; prompts: WeightedPrompt[]; config?: StreamConfig }
  | { type: 'stop' };

// `ready` may be sent again after `reconnecting` (upstream session replaced); reconfigure if the format changed.
export type ServerMessage =
  | { type: 'status'; state: 'connecting' | 'playing' | 'reconnecting' | 'stopped' }
  | { type: 'ready'; audio: AudioFormat }
  | { type: 'error'; code: ErrorCode; message: string; retryable: boolean };

export type AudioFormat = { format: 'pcm_s16le'; sampleRateHz: number; channels: 2 };

// Accepted by D. Retryable: capacity, upstream_unavailable, upstream_lost, prompt_filtered (stream keeps playing).
export type ErrorCode =
  | 'bad_message'
  | 'bad_state'
  | 'capacity'
  | 'upstream_unavailable'
  | 'upstream_lost'
  | 'prompt_filtered'
  | 'internal';

// Audio chunks from server are raw BINARY WebSocket frames, not ServerMessage.

export const MUSIC_WS_PATH = '/api/music';
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 2.0;
/** Max weighted prompts per client message — the relay guard rejects longer lists. */
export const MAX_PROMPTS = 10;

// ---- Learner contract (implemented by C in src/learner, consumed by D) ----

export type FeatureId = string; // concrete union lives in learner/vocabulary.ts
export type FeatureBlend = Record<FeatureId, number>; // missing feature = 0

export type LearnerState = {
  scores: Record<FeatureId, number>;
  votes: number;
  seed: number;
};

export type Target = {
  features: FeatureBlend;
  prompts: WeightedPrompt[];
};

export interface Learner {
  createLearner(seed: number, purpose?: ListeningPurpose): LearnerState;
  initialTarget(state: LearnerState): Target;
  processVote(args: {
    state: LearnerState;
    audible: FeatureBlend;
    currentTarget: Target;
    vote: Vote;
    // Correlated clicks or pre-playback actions can steer without inventing evidence.
    evidenceWeight?: number;
  }): { state: LearnerState; target: Target };
  // Must not change state.scores. Silence is not feedback.
  evolveNoVote(args: { state: LearnerState; target: Target; step?: number }): Target;
}

// ---- Playback contract (implemented by B in src/audio, consumed by D) ----

export interface PCMPlayer {
  // Call synchronously inside the user's tap handler (autoplay policy).
  initializeFromUserGesture(): Promise<void>;
  configure(audio: AudioFormat): void;
  enqueuePcm(bytes: ArrayBuffer): void;
  getBufferedDurationMs(): number;
  /** Latest diagnostics snapshot (live telemetry + readiness), optional for test/alternative players. */
  getStats?(): PCMPlayerStats;
  close(): Promise<void>;
}

/** Diagnostics subset the controller maps onto StreamLevels; implementations may expose more fields. */
export type PCMPlayerStats = {
  /** Worklet/player lifecycle ('idle' | 'initializing' | 'ready' | 'closed'). */
  state?: string;
  /** Still filling the preroll buffer — output is silence. */
  priming?: boolean;
  /** AudioContext.state where applicable ('running' | 'suspended' | ...) — gates audible-time tracking. */
  audioContextState?: string;
  /** Decoded audio buffered but not yet rendered. */
  bufferedMs?: number;
  /** Render callbacks that ran out of audio since the last reset. */
  underruns?: number;
  /** RMS of recently rendered output, 0..1 — only worklet renderers measure this. */
  energyRms?: number;
  /** Spectral-brightness proxy in Hz — only worklet renderers measure this. */
  brightnessHz?: number;
  /** Dominant-partial pitch estimate in Hz, or null when silent/indeterminate. */
  pitchHz?: number | null;
  /** PCM blocks pushed since reset — the real generation cadence. */
  chunksReceived?: number;
};

// ---- Controller contract (implemented by D in src/controller, consumed by UI) ----

export type SessionStatus = 'idle' | 'connecting' | 'playing' | 'reconnecting' | 'stopped' | 'error';

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
  /** Generated audio blocks landed since the session started — bumps when a new part of the music exists. */
  generation: number;
  /** 0..1 progress of the latest vote's steer becoming audible; 1 only once it plays. Null when none pending. */
  steerProgress?: number | null;
  /** Which vote the pending steer belongs to. */
  steerVote?: Vote | null;
};

export type SessionState = { status: SessionStatus; lastError?: string; signature?: MusicSignature };

export interface MusicSessionController {
  // Optional pre-session setup; changing purpose starts a fresh preference session.
  setPurpose?(purpose: ListeningPurpose): void;
  start(): Promise<void>;
  vote(v: Vote): void; // synchronous, never locked out
  stop(): void;
  subscribe(listener: (state: SessionState) => void): () => void;
  /** Optional: ~10 Hz live levels while a session is active; synchronous snapshot on subscribe (zeros when idle). */
  subscribeStats?(listener: (levels: StreamLevels) => void): () => void;
}
