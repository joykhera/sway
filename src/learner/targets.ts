import { WEIGHT_MIN, WEIGHT_MAX, type WeightedPrompt } from '../shared/protocol';
import { INITIAL_INTENSITY, LEARNER_PARAMETERS as P } from './constants';
import { hashText } from './rng';
import type { FeatureBlend, Target } from './types';
import { FEATURE_GROUPS, FEATURE_IDS, FEATURE_OF_TEXT, GROUP_IDS, PROMPT_TEXT, PROMPT_VARIANTS } from './vocabulary';
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

/**
 * One step toward a feature the listener picked: strengthen it if it's playing,
 * otherwise bring it in at a step's intensity. A full group (2 genres or
 * instruments, 1 mood or texture) gives up its weakest member to make room.
 */
export function nudgeFeatures(features: FeatureBlend, id: FeatureId, step = P.nudgeStep): FeatureBlend {
  const next = sanitizeFeatures(features);
  const group = GROUP_IDS.find((g) => (FEATURE_GROUPS[g] as readonly FeatureId[]).includes(id));
  if (!group) return projectFeatures(next);
  const current = next[id] ?? 0;
  if (current > 0) {
    next[id] = Math.min(P.maxIntensity, current + step);
  } else {
    const limit = group === 'genre' || group === 'instrument' ? 2 : 1;
    const members = activeIds(next, group).sort((a, b) => next[a]! - next[b]!);
    if (members.length >= limit) {
      // Take over the weakest member's place, so the swap is a step, not a jump.
      const weakest = members[0]!;
      next[id] = next[weakest]!;
      delete next[weakest];
    } else {
      next[id] = Math.max(P.minActiveIntensity, step);
    }
  }
  return projectFeatures(next);
}

export type Phrasing = {
  /** Prompts whose vocabulary phrasings are kept for features that stay active. */
  keep?: readonly WeightedPrompt[];
  /** Picks a phrasing for features without one in `keep`; omitted = canonical phrasing. */
  salt?: number;
};

/** Phrasing per active feature: kept if already in use, else seeded, else canonical. */
export function choosePhrasing(id: FeatureId, { keep = [], salt }: Phrasing): string {
  const kept = keep.find((p) => FEATURE_OF_TEXT.get(p.text) === id);
  if (kept) return kept.text;
  if (salt === undefined) return PROMPT_TEXT[id];
  const variants = PROMPT_VARIANTS[id];
  return variants[hashText(id, salt) % variants.length]!;
}

/** Canonicalize prompts from known features; only vocabulary phrasings are ever emitted. */
export function toTarget(features: FeatureBlend, fallback: FeatureBlend = {}, phrasing: Phrasing = {}): Target {
  const projected = projectFeatures(features, fallback);
  return {
    features: projected,
    prompts: activeIds(projected).map((id) => ({
      text: choosePhrasing(id, phrasing),
      weight: clamp(projected[id]! * P.promptScale, WEIGHT_MIN, WEIGHT_MAX),
    })),
  };
}
