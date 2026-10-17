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
  // Existing worklet readiness, optional for test/alternative players.
  getStats?(): { state: string; priming: boolean; audioContextState?: string };
  close(): Promise<void>;
}

// ---- Controller contract (implemented by D in src/controller, consumed by UI) ----

export type SessionStatus = 'idle' | 'connecting' | 'playing' | 'reconnecting' | 'stopped' | 'error';

export type SessionState = { status: SessionStatus; lastError?: string };

export interface MusicSessionController {
  // Optional pre-session setup; changing purpose starts a fresh preference session.
  setPurpose?(purpose: ListeningPurpose): void;
  start(): Promise<void>;
  vote(v: Vote): void; // synchronous, never locked out
  stop(): void;
  subscribe(listener: (state: SessionState) => void): () => void;
}
