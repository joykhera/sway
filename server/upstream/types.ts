import type { StreamConfig, WeightedPrompt } from '../../src/shared/protocol.ts';

export type UpstreamFormat = { sampleRateHz: number; channels: number };

export type UpstreamEvents = {
  onAudio(chunk: Buffer, format: UpstreamFormat): void;
  onFiltered(info: { text?: string; reason?: string }): void;
  onWarning(message: string): void;
  // Unexpected close only; not fired after close() is called.
  // retryable defaults to true; wrappers may mark a terminal provider failure false.
  onClosed(reason: string, retryable?: boolean): void;
};

export interface MusicUpstream {
  // Resolves once prompts/config are applied and playback was requested. Rejects on setup failure.
  start(prompts: WeightedPrompt[], config: StreamConfig): Promise<void>;
  // `config`, when given, is the full desired config (not a delta).
  steer(prompts: WeightedPrompt[], config?: StreamConfig): Promise<void>;
  // Optional capability: pause preserves generation context; resume continues it.
  // Both methods must exist before the relay advertises bounded prefetch support.
  pause?(): void;
  resume?(): void;
  close(): void;
}

export type UpstreamFactory = (events: UpstreamEvents) => MusicUpstream;
