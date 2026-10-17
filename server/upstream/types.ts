// Interface between the per-browser session state machine and a music
// upstream (Lyria RealTime, or the mock tone for tests/keyless devs).

import type {
  AudioFormat,
  StreamConfig,
  WeightedPrompt,
} from '../../src/shared/protocol.ts';

export type UpstreamCallbacks = {
  /** Decoded PCM bytes, ready to frame as a binary ws message. */
  onAudio(chunk: Buffer): void;
  /** One or more prompt texts were filtered by the provider. */
  onFiltered?(prompts: string[]): void;
  /** Non-fatal upstream oddity worth logging. */
  onWarning?(message: string): void;
  /** Upstream session ended (any cause) while we didn't ask for it. */
  onClosed(reason?: string): void;
};

export type UpstreamStartArgs = {
  prompts: WeightedPrompt[];
  config?: StreamConfig;
};

export interface MusicUpstream {
  /**
   * Open a stream and start generation. Resolves with the audio format once
   * the upstream is ready to deliver `onAudio` chunks. Rejects if the stream
   * can not be established (session maps this to `upstream_unavailable`).
   */
  start(args: UpstreamStartArgs, cb: UpstreamCallbacks): Promise<{ audio: AudioFormat }>;
  /** Fire-and-forget steer; implementations coalesce newest-wins internally. */
  steer(prompts: WeightedPrompt[], config?: StreamConfig): void;
  /** Idempotent teardown; an already-closed upstream is a success. */
  close(): Promise<void>;
}
