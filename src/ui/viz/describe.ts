// Plain-words labels for feature blends and learned taste.
import { FEATURE_GROUPS, GROUP_IDS, type FeatureGroup } from '../../learner/vocabulary.ts';

export { FEATURE_GROUPS, GROUP_IDS, type FeatureGroup };

const positive = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The strongest feature in each group, e.g. "jazz · piano · calm · layered". Empty for an empty blend. */
export function describeBlend(features: Record<string, number>): string {
  return GROUP_IDS.map((group) => {
    let best: string | null = null;
    for (const id of FEATURE_GROUPS[group]) if (positive(features[id]) && (!best || features[id]! > features[best]!)) best = id;
    return best;
  }).filter(Boolean).join(' · ');
}

/**
 * Scores on an absolute -1..1 scale. The adaptive learner's scores already sit
 * about there and keep climbing with repeat likes (0.52, 0.73, 0.85, …), so
 * each like visibly strengthens a favourite; only scores beyond ±1 compress.
 * (Dividing by the strongest score hid those likes: the ratios don't change.)
 */
export function normalizeTaste(taste: Record<string, number>): Record<string, number> {
  const values = Object.values(taste).filter(Number.isFinite);
  const scale = Math.max(1, ...values.map(Math.abs));
  return Object.fromEntries(Object.entries(taste).map(([id, v]) => [id, Number.isFinite(v) ? v / scale : 0]));
}

/** The best-liked feature per group, skipping groups with nothing liked. */
export function topTaste(taste: Record<string, number>): string[] {
  return GROUP_IDS.flatMap((group) => {
    const best = [...FEATURE_GROUPS[group]].sort((a, b) => (taste[b] ?? 0) - (taste[a] ?? 0))[0];
    return best && positive(taste[best]) ? [best] : [];
  });
}
