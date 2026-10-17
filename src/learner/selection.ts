import { LEARNER_PARAMETERS as P } from './constants';
import { pick } from './rng';
import type { Rng } from './rng';
import { activeIds, signature } from './targets';
import type { FeatureBlend, LearnerState } from './types';
import { FEATURE_GROUPS, GROUP_IDS } from './vocabulary';
import type { FeatureGroup, FeatureId } from './vocabulary';

function replaceGroup(features: FeatureBlend, group: FeatureGroup, rng: Rng, broad: boolean) {
  const current = activeIds(features, group);
  const choices: FeatureId[] = FEATURE_GROUPS[group].filter((id) => !current.includes(id));
  const replacements = broad ? current : [pick(current, rng)];
  for (const oldId of replacements) {
    const newId = pick(choices, rng);
    choices.splice(choices.indexOf(newId), 1);
    features[newId] = features[oldId]!;
    delete features[oldId];
  }
}

function candidate(base: FeatureBlend, rng: Rng, broad: boolean): FeatureBlend {
  const result = { ...base };
  const remaining = [...GROUP_IDS];
  const count = broad ? remaining.length : rng.next() < P.twoFeatureMoveProbability ? 2 : 1;
  for (let i = 0; i < count; i += 1) {
    const group = pick(remaining, rng);
    remaining.splice(remaining.indexOf(group), 1);
    replaceGroup(result, group, rng, broad);
  }
  return result;
}

function utility(features: FeatureBlend, state: LearnerState, rng: Rng): number {
  let weighted = 0;
  let total = 0;
  for (const id of activeIds(features)) {
    weighted += state.scores[id] * features[id]!;
    total += features[id]!;
  }
  // Compare shares: a heavier prompt set is not automatically a better direction.
  return weighted / total + (rng.next() * 2 - 1) * P.explorationNoise;
}

export function chooseAlternative(
  state: LearnerState,
  base: FeatureBlend,
  pending: FeatureBlend,
  rng: Rng,
): FeatureBlend {
  // Draw once per decision so ranking does not silently erase broad exploration.
  const broad = rng.next() < P.broadMoveProbability;
  const pendingSignature = signature(pending);
  let best: FeatureBlend | undefined;
  let bestScore = -Infinity;
  for (let i = 0; i < P.candidateCount; i += 1) {
    const proposal = candidate(base, rng, broad);
    if (signature(proposal) === pendingSignature) continue;
    const score = utility(proposal, state, rng);
    if (score > bestScore) {
      best = proposal;
      bestScore = score;
    }
  }
  if (best) return best;

  // A bounded fallback: keep the chosen move family and vary one replacement.
  const fallback = candidate(base, rng, broad);
  if (signature(fallback) !== pendingSignature) return fallback;
  for (const group of GROUP_IDS) {
    if (activeIds(base, group).join('|') === activeIds(fallback, group).join('|')) continue;
    for (const oldId of activeIds(fallback, group)) {
      const nextId = FEATURE_GROUPS[group].find(
        (id) => !activeIds(base, group).includes(id) && !activeIds(fallback, group).includes(id),
      );
      if (nextId) {
        const next = { ...fallback, [nextId]: fallback[oldId]! };
        delete next[oldId];
        return next;
      }
    }
  }
  // Vocabulary has at least three options per group, so this is unreachable.
  throw new Error('Vocabulary cannot provide a distinct musical target');
}
