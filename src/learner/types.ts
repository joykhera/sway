import type { WeightedPrompt } from '../shared/protocol';
import type { FeatureId } from './vocabulary';

/** Missing = 0. Intensities are 0..1, independent of preference scores. */
export type FeatureBlend = Partial<Record<FeatureId, number>>;
export type LearnerState = {
  scores: Record<FeatureId, number>;
  votes: number;
  seed: number;
};
export type Target = { features: FeatureBlend; prompts: WeightedPrompt[] };
