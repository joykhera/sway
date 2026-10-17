// Audio lane public surface (handoff §5). Owned by B; consumed by D/UI.
// `types.ts` re-exports `AudioFormat` from shared/protocol; `export *` forwards
// the type-only names too.

export * from './types.ts';
export * from './constants.ts';

export { WorkletPCMPlayer, createPCMPlayer } from './pcm-player.ts';
export type {
    AudioContextLike,
    WorkletNodeLike,
    WorkletPortLike,
    WorkletPCMPlayerOptions,
} from './pcm-player.ts';

export { MockPcmGenerator } from './mock-generator.ts';
export type { MockPreset, MockPcmGeneratorOptions } from './mock-generator.ts';

export { workletUrl } from './worklet-url.ts';
