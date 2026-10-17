import { FEATURE_GROUPS, FEATURE_IDS, GROUP_IDS } from '../vocabulary';
import { activeIds, toTarget } from '../targets';
import type { FeatureBlend, Purpose, Target } from './types';
import { vector } from './model';

/** 5 genres × 5 instruments × 5 moods × 3 textures; no purpose excludes a style. */
export const RECIPES = FEATURE_GROUPS.genre.flatMap((genre) =>
  FEATURE_GROUPS.instrument.flatMap((instrument) =>
    FEATURE_GROUPS.mood.flatMap((mood) =>
      FEATURE_GROUPS.texture.map((texture) => {
        const target = toTarget({ [genre]: 0.45, [instrument]: 0.4, [mood]: 0.3, [texture]: 0.25 });
        return { target, x: vector(target.features) };
      }),
    ),
  ),
);

export function changedGroups(a: FeatureBlend, b: FeatureBlend): number {
  return GROUP_IDS.filter((group) => activeIds(a, group).join('|') !== activeIds(b, group).join('|')).length;
}

export function distance(a: number[], b: number[]): number {
  return FEATURE_IDS.reduce((total, _, i) => total + Math.abs(a[i]! - b[i]!), 0) / 2;
}

const PURPOSE_FEATURES: Record<Purpose, FeatureBlend> = {
  focus: { calm: 0.7, dreamy: 0.25, sparse: 0.6 },
  relax: { calm: 0.6, dreamy: 0.6, sparse: 0.45, layered: 0.15 },
  energy: { energetic: 0.8, hopeful: 0.35, rhythmic: 0.6, layered: 0.15 },
  explore: {},
  crazy: { electronic: 1.2, synth: 1, percussion: 0.75, energetic: 1.4, rhythmic: 1.3, layered: 0.4 },
};

export function purposePrior(purpose: Purpose, target: Target): number {
  return FEATURE_IDS.reduce((total, id) => total + (PURPOSE_FEATURES[purpose][id] ?? 0) * (target.features[id] ?? 0), 0);
}
