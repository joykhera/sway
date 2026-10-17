import type { Vote, WeightedPrompt } from '../shared/protocol';
import { INITIAL_INTENSITY, LEARNER_PARAMETERS as P } from './constants';
import { createRng, hashText, normalizeSeed, pick } from './rng';
import { chooseAlternative } from './selection';
import { activeIds, choosePhrasing, clamp, fingerprint, sanitizeFeatures, toTarget, type Phrasing } from './targets';
import type { FeatureBlend, LearnerState, Target } from './types';
import { FEATURE_GROUPS, FEATURE_IDS, GROUP_IDS, PROMPT_VARIANTS } from './vocabulary';
import type { FeatureId } from './vocabulary';

export type { FeatureBlend, LearnerState, Target } from './types';
export type { FeatureId } from './vocabulary';
export { FEATURE_GROUPS, FEATURE_IDS } from './vocabulary';
export { LEARNER_PARAMETERS } from './constants';

export function createLearner(seed: number): LearnerState {
  const scores = Object.fromEntries(FEATURE_IDS.map((id) => [id, 0])) as Record<FeatureId, number>;
  return { scores, votes: 0, seed: normalizeSeed(seed) };
}

export function initialTarget(state: LearnerState): Target {
  const rng = createRng(state.seed);
  const features: FeatureBlend = {};
  for (const group of GROUP_IDS) {
    features[pick(FEATURE_GROUPS[group] as readonly FeatureId[], rng)] =
      INITIAL_INTENSITY[group] + (rng.next() * 2 - 1) * P.initialJitter;
  }
  return toTarget(features, {}, { salt: state.seed });
}

function learn(state: LearnerState, audible: FeatureBlend, vote: Vote): LearnerState {
  const reward = vote === 'up' ? 1 : -1;
  const scores = { ...state.scores };
  for (const id of FEATURE_IDS) {
    const prior = Number.isFinite(scores[id]) ? scores[id] : 0;
    scores[id] = clamp(prior + P.learningRate * reward * (audible[id] ?? 0), -P.scoreLimit, P.scoreLimit);
  }
  return { scores, votes: state.votes + 1, seed: state.seed };
}

function amplify(state: LearnerState, base: Target, audible: FeatureBlend, phrasing: Phrasing): Target {
  const features = { ...base.features };
  const candidates = activeIds(features).filter((id) => (audible[id] ?? 0) > 0);
  candidates.sort((a, b) => state.scores[b] - state.scores[a] || features[b]! - features[a]!);
  const focus = candidates[0];
  if (focus) {
    // Increase one current quality relative to the others. Uniform scaling is ineffective.
    features[focus] = Math.min(P.maxIntensity, features[focus]! + P.likeBoost);
  }
  return toTarget(features, {}, phrasing);
}

/** One immediate immutable update per explicit click. D owns ramps and revisions. */
export function processVote(args: {
  state: LearnerState;
  audible: FeatureBlend;
  currentTarget: Target;
  vote: Vote;
}): { state: LearnerState; target: Target } {
  if (args.vote !== 'up' && args.vote !== 'down') throw new Error('Vote must be up or down');
  const audible = sanitizeFeatures(args.audible);
  const state = learn(args.state, audible, args.vote);
  const rng = createRng(state.seed);
  rng.next(); // Advance explicitly even when the like path needs no random choice.
  const pending = toTarget(args.currentTarget.features);
  const base = toTarget(audible, pending.features);
  // Features that stay keep their wording; newly added ones get a seeded phrasing.
  const phrasing: Phrasing = { keep: args.currentTarget.prompts, salt: state.seed };
  const target = args.vote === 'up'
    ? amplify(state, base, audible, phrasing)
    : toTarget(chooseAlternative(state, base.features, pending.features, rng), {}, phrasing);
  return { state: { ...state, seed: rng.seed }, target };
}

/** D schedules these calls. Silence changes direction, never preference evidence. */
export function evolveNoVote(args: { state: LearnerState; target: Target }): Target {
  const target = toTarget(args.target.features);
  const rng = createRng(hashText(fingerprint(target.features), args.state.seed));
  const features = { ...target.features };
  const id = pick(activeIds(features), rng);
  const value = features[id]!;
  const direction = rng.next() < 0.5 ? -1 : 1;
  // Vary step size to avoid a fixed-step A→B→A cycle with content-derived RNG.
  const step = P.passiveDrift * (0.5 + rng.next() * 0.5);
  let next = value + direction * step;
  // Reflect overshoot rather than clipping to a shared boundary; clipping can
  // still create repeated target cycles even with a variable step size.
  if (next < P.minActiveIntensity) next = 2 * P.minActiveIntensity - next;
  if (next > P.maxIntensity) next = 2 * P.maxIntensity - next;
  features[id] = next;
  // Sometimes also reword one active feature: a within-style change, never a score change.
  let keep: readonly WeightedPrompt[] = args.target.prompts;
  if (rng.next() < P.phrasingDriftProbability) {
    const reworded = pick(activeIds(features), rng);
    const current = choosePhrasing(reworded, { keep });
    const others = PROMPT_VARIANTS[reworded].filter((text) => text !== current);
    keep = [...keep.filter((p) => p.text !== current), { text: pick(others, rng), weight: 1 }];
  }
  return toTarget(features, {}, { keep });
}
