// Audio-lane contracts. Owned by B (src/audio/**). Consumed by D (src/controller/**).
// Browser-safe: no Node imports.

import type { AudioFormat } from '../shared/protocol.ts';

export type { AudioFormat };

/**
 * Playback abstraction (handoff §5). Implemented by `WorkletPCMPlayer` in `pcm-player.ts`.
 *
 * Lifecycle: `configure()` and `enqueuePcm()` may be called in any order relative to
 * `initializeFromUserGesture()`; audio is held until both init and configure have happened.
 * `configure()` may be called again mid-stream (the relay re-sends `ready` after a reconnect);
 * already-buffered audio keeps playing, only new chunks use the new source rate.
 */
export interface PCMPlayer {
  /** Must be invoked synchronously from a user gesture (autoplay policy). Idempotent. */
  initializeFromUserGesture(): Promise<void>;
  /** Announce the verified source format. May be called before init and again after reconnects. */
  configure(audio: AudioFormat): void;
  /** Interleaved stereo signed 16-bit little-endian bytes. The buffer is transferred (detached) by the player. */
  enqueuePcm(bytes: ArrayBuffer): void;
  /** Milliseconds of decoded audio buffered but not yet rendered. 0 before init. */
  getBufferedDurationMs(): number;
  /** Latest diagnostics snapshot (includes live signal telemetry), if the implementation exposes it. */
  getStats?(): PCMPlayerStats;
  /** Release all audio resources. Idempotent. Further `enqueuePcm` calls are ignored. */
  close(): Promise<void>;
}

export type PCMPlayerState = 'idle' | 'initializing' | 'ready' | 'closed';

/** Diagnostics for D's audible-blend estimate and for tuning the jitter buffer. */
export interface PCMPlayerStats {
  state: PCMPlayerState;
  /** Live Web Audio execution state; lifecycle `ready` alone does not mean audible. */
  audioContextState?: string;
  /** Decoded audio buffered in the worklet but not yet rendered, at the output rate. */
  bufferedMs: number;
  /** Render callbacks that ran out of audio since the last reset. */
  underruns: number;
  /** Frames dropped because the ring buffer was full (burst protection). */
  droppedFrames: number;
  /** True while output is held silent until the pre-roll fills. */
  priming: boolean;
  /** AudioContext rate; 0 before init. */
  outputSampleRateHz: number;
  /** Source rate from `configure()`; 0 before configure. */
  sourceSampleRateHz: number;

  // --- Live signal telemetry (rendered output, ~100 ms cadence) -------------
  // Optional: only worklet-based renderers can measure the emitted signal.
  /** RMS of recently rendered output, 0..1 (interleaved stereo). */
  energyRms?: number;
  /**
   * Spectral-brightness proxy in Hz: mean zero-crossing rate × sr/2 over the
   * recent render window. Roughly tracks spectral centroid for tonal content.
   */
  brightnessHz?: number;
  /**
   * Dominant-partial pitch estimate in Hz (zero-crossing rate × sr), or null
   * when the signal is silent/too noisy for a stable reading.
   */
  pitchHz?: number | null;
}

/** Main thread -> worklet messages (via `AudioWorkletNode.port`). */
export type WorkletInbound =
  | { type: 'configure'; sourceSampleRateHz: number }
  | { type: 'pcm'; bytes: ArrayBuffer }
  | { type: 'reset' };

/** Worklet -> main thread messages. */
export type WorkletOutbound = {
  type: 'stats';
  bufferedMs: number;
  underruns: number;
  droppedFrames: number;
  priming: boolean;
  energyRms: number;
  brightnessHz: number;
  pitchHz: number | null;
};

export const PCM_WORKLET_PROCESSOR_NAME = 'sway-pcm-player';
