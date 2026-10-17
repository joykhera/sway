import { WEIGHT_MIN, WEIGHT_MAX } from '../shared/protocol';
import { INITIAL_INTENSITY, LEARNER_PARAMETERS as P } from './constants';
import type { FeatureBlend, Target } from './types';
import { FEATURE_GROUPS, FEATURE_IDS, GROUP_IDS, PROMPT_TEXT } from './vocabulary';
import type { FeatureGroup, FeatureId } from './vocabulary';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sanitizeFeatures(input: FeatureBlend): FeatureBlend {
  const result: FeatureBlend = {};
  for (const id of FEATURE_IDS) {
    const value = input[id];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      result[id] = Math.min(value, P.maxIntensity);
    }
  }
  return result;
}

export function activeIds(features: FeatureBlend, group?: FeatureGroup): FeatureId[] {
  const ids: readonly FeatureId[] = group ? FEATURE_GROUPS[group] : FEATURE_IDS;
  return ids.filter((id) => (features[id] ?? 0) > 0);
}

export function signature(features: FeatureBlend): string {
  return activeIds(features).join('|');
}

export function fingerprint(features: FeatureBlend): string {
  return activeIds(features).map((id) => `${id}:${features[id]}`).join('|');
}

/** Project a transition mixture into a valid target. Learn from the full mixture first. */
export function projectFeatures(input: FeatureBlend, fallback: FeatureBlend = {}): FeatureBlend {
  const clean = sanitizeFeatures(input);
  const backup = sanitizeFeatures(fallback);
  const result: FeatureBlend = {};
  for (const group of GROUP_IDS) {
    const source = activeIds(clean, group).length > 0 ? clean : backup;
    const limit = group === 'genre' || group === 'instrument' ? 2 : 1;
    // Vocabulary order is the stable tie break, independent of property insertion order.
    const ids = activeIds(source, group)
      .sort((a, b) => source[b]! - source[a]!)
      .slice(0, limit);
    if (ids.length === 0) {
      result[FEATURE_GROUPS[group][0]] = INITIAL_INTENSITY[group];
    } else {
      for (const id of ids) {
        result[id] = clamp(source[id]!, P.minActiveIntensity, P.maxIntensity);
      }
    }
  }
  return result;
}

/** Canonicalize prompts from known features; never forward caller-provided text. */
export function toTarget(features: FeatureBlend, fallback: FeatureBlend = {}): Target {
  const projected = projectFeatures(features, fallback);
  return {
    features: projected,
    prompts: activeIds(projected).map((id) => ({
      text: PROMPT_TEXT[id],
      weight: clamp(projected[id]! * P.promptScale, WEIGHT_MIN, WEIGHT_MAX),
    })),
  };
}
