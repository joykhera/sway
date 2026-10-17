// Application protocol between browser and relay (NOT Google's wire protocol).
// Owned by D after the initial scaffold; changes need a small PR approved by affected owners.
// Browser-safe: no Node imports.

export type Vote = 'up' | 'down';

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

// Proposed by A; pending D's review.
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
