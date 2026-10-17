import { FEATURE_IDS } from '../vocabulary';
import type { WeightedPrompt } from '../../shared/protocol';
import { createRng, hashText, normalizeSeed } from '../rng';
import type { Rng } from '../rng';
import { fingerprint, signature, toTarget } from '../targets';
import { PARAMETERS as P } from './constants';
import { dot, factor, solve, uncertainty, vector } from './model';
import { RECIPES, changedGroups, distance, purposePrior } from './recipes';
import type { Decision, FeatureBlend, FeatureId, LearnerState, Purpose, Target } from './types';

export type { Decision, FeatureBlend, FeatureId, LearnerState, Purpose, Target } from './types';
export { PARAMETERS } from './constants';

const coefficients = (theta: number[]) => Object.fromEntries(FEATURE_IDS.map((id, i) => [id, theta[i]!])) as Record<FeatureId, number>;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function createLearner(seed: number, purpose: Purpose = 'explore'): LearnerState {
  return {
    scores: coefficients(FEATURE_IDS.map(() => 0)), votes: 0, seed: normalizeSeed(seed), purpose,
    A: FEATURE_IDS.map((_, i) => FEATURE_IDS.map((__, j) => i === j ? P.ridge : 0)),
    b: FEATURE_IDS.map(() => 0), evidence: 0, positiveEvidence: 0, negativeEvidence: 0,
    lastVote: null, recentRejections: 0,
    unexpectedDislikes: [], recoveryArmed: true, recoveries: 0, lastRecoveryVote: null,
  };
}

function context(state: LearnerState, features: FeatureBlend) {
  const L = factor(state.A);
  const theta = solve(L, state.b);
  const x = vector(features);
  const predicted = dot(theta, x);
  const uncertain = uncertainty(L, x);
  const priorVariance = dot(x, x) / P.ridge;
  const information = priorVariance > 0 ? clamp01(1 - uncertain ** 2 / priorVariance) : 0;
  const supported = predicted > P.supportedPrediction && information > P.supportedInformation;
  const reopening = state.recentRejections >= 1.8;
  const phase = reopening ? 'Reopening search'
    : supported ? 'Staying nearby'
      : predicted > 0.1 && information > 0.25 ? 'Finding a family' : 'Exploring';
  return { L, theta, x, predicted, uncertain, information, supported: supported && !reopening, reopening, phase };
}

function phrasingSalt(target: Target, state: LearnerState): number {
  return Number.isFinite(target.phrasingSalt) ? normalizeSeed(target.phrasingSalt!) : state.seed;
}

function withDecision(target: Target, kind: Decision['kind'], reason: string, state: LearnerState, step: number, salt: number, keep: readonly WeightedPrompt[] = target.prompts): Target {
  const current = context(state, target.features);
  return {
    ...toTarget(target.features, {}, { keep, salt }),
    phrasingSalt: salt,
    lastDecision: {
      kind,
      reason: kind === 'redirect' && state.lastRecoveryVote === state.votes
        ? `Reconsidering older assumptions after distinct supported blends were rejected. ${reason}` : reason,
      phase: current.phase, step, prediction: current.predicted, uncertainty: current.uncertain,
    },
  };
}

function choose(state: LearnerState, base: Target, pending: Target, mode: 'initial' | 'down' | 'variation', step: number, rng: Rng): Target {
  const current = context(state, base.features);
  const scheduled = mode === 'variation';
  const broad = mode === 'initial' || current.reopening || (scheduled
    ? rng.next() < (current.supported ? P.probeProbability : P.earlyVariationProbeProbability)
    : !current.supported || rng.next() < P.probeProbability);
  let candidates = RECIPES.filter(({ target }) => mode === 'initial'
    || (signature(target.features) !== signature(base.features) && signature(target.features) !== signature(pending.features)));
  const closest = Math.min(...candidates.map(({ target }) => changedGroups(base.features, target.features)));
  if (!broad) candidates = candidates.filter(({ target }) => changedGroups(base.features, target.features) === closest);
  if (broad && current.supported && scheduled) {
    const credible = candidates.filter(({ x }) => dot(current.theta, x) >= current.predicted - P.credibleProbeDrop);
    if (credible.length > 0) candidates = credible;
  }
  const uncertaintyBonus = current.supported ? P.supportedUncertaintyBonus : P.uncertaintyBonus;
  const cost = mode === 'initial' ? 0 : current.supported ? P.supportedTransitionCost : P.transitionCost;
  let best = candidates[0]!;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = dot(current.theta, candidate.x)
      + uncertaintyBonus * uncertainty(current.L, candidate.x)
      + P.purposePrior * purposePrior(state.purpose, candidate.target)
      - cost * distance(current.x, candidate.x)
      + (rng.next() * 2 - 1) * P.tieNoise;
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  const changeCount = changedGroups(base.features, best.target.features);
  const kind = mode === 'initial' ? 'initial' : mode === 'down' ? 'redirect' : broad ? 'probe' : 'variation';
  const reason = mode === 'initial' ? 'Starting with a broad recipe; purpose is a soft starting hint, not learned taste.'
    : mode === 'down' ? current.supported
      ? `Trying a different ${changeCount === 1 ? 'ingredient' : 'combination'} near the supported family after a dislike.`
      : 'Trying another direction after a dislike; preference evidence is still uncertain.'
      : broad ? 'Testing a plausible alternative while keeping room for discovery; silence adds no preference evidence.'
        : 'Adding a nearby variation after exposure; likes guide the family without freezing the music.';
  return withDecision(best.target, kind, reason, state, step, phrasingSalt(pending, state), mode === 'initial' ? [] : pending.prompts);
}

export function initialTarget(state: LearnerState): Target {
  return choose(state, RECIPES[0]!.target, RECIPES[0]!.target, 'initial', 0, createRng(state.seed));
}

export function processVote(args: {
  state: LearnerState;
  audible: FeatureBlend;
  currentTarget: Target;
  vote: 'up' | 'down';
  evidenceWeight?: number;
}): { state: LearnerState; target: Target } {
  if (args.vote !== 'up' && args.vote !== 'down') throw new Error('Vote must be up or down');
  const x = vector(args.audible);
  const suppliedWeight = args.evidenceWeight ?? 1;
  const w = Number.isFinite(suppliedWeight) && dot(x, x) > 0 ? clamp01(suppliedWeight) : 0;
  // A zero-weight/correlated click is an action, not a learning or forgetting step.
  const gamma = w > 0 ? P.forgetting ** w : 1;
  const reward = args.vote === 'up' ? 1 : -1;
  let unexpectedDislikes = args.state.unexpectedDislikes.map((observation) => ({ x: [...observation.x], weight: observation.weight }));
  let recoveryArmed = args.state.recoveryArmed;
  let recover = false;
  if (w > 0 && reward > 0) {
    unexpectedDislikes = [];
    recoveryArmed = true;
  } else if (w > 0 && recoveryArmed) {
    // Surprise is assessed BEFORE fitting this dislike, independently of the
    // selection phase. Expected poor exploration does not invalidate old taste.
    const before = context(args.state, args.audible);
    if (before.predicted > P.supportedPrediction && before.information > P.supportedInformation) {
      const similar = unexpectedDislikes.find((observation) => distance(observation.x, x) < P.recoveryBlendDistance);
      if (similar) similar.weight = Math.min(1, similar.weight + w);
      else unexpectedDislikes.push({ x, weight: Math.min(1, w) });
      // Bounded policy memory, separate from the full learned sufficient statistics.
      unexpectedDislikes = unexpectedDislikes.slice(-6);
      recover = unexpectedDislikes.length >= 2
        && unexpectedDislikes.reduce((total, observation) => total + observation.weight, 0) >= P.recoveryEvidence;
      if (recover) {
        unexpectedDislikes = [];
        recoveryArmed = false;
      }
    }
  }
  // Discount OLD evidence toward lambda I, then add the latest observation intact.
  const discount = gamma * (recover ? P.recoveryRetention : 1);
  const A = args.state.A.map((row, i) => row.map((value, j) =>
    discount * value + (i === j ? (1 - discount) * P.ridge : 0) + w * x[i]! * x[j]!,
  ));
  const b = args.state.b.map((value, i) => discount * value + w * reward * x[i]!);
  const state: LearnerState = {
    ...args.state, A, b, scores: coefficients(solve(factor(A), b)), votes: args.state.votes + 1,
    evidence: discount * args.state.evidence + w,
    positiveEvidence: discount * args.state.positiveEvidence + (reward > 0 ? w : 0),
    negativeEvidence: discount * args.state.negativeEvidence + (reward < 0 ? w : 0),
    lastVote: args.vote,
    recentRejections: w === 0 ? args.state.recentRejections : reward < 0 ? args.state.recentRejections * 0.9 + w : Math.max(0, args.state.recentRejections - w),
    unexpectedDislikes, recoveryArmed,
    recoveries: args.state.recoveries + (recover ? 1 : 0),
    lastRecoveryVote: recover ? args.state.votes + 1 : args.state.lastRecoveryVote,
  };
  const rng = createRng(state.seed);
  rng.next();
  const salt = phrasingSalt(args.currentTarget, state);
  // A stable salt restores an outgoing feature's wording even when a mid-ramp
  // like brings it back after it disappeared from the pending destination.
  const base = toTarget(args.audible, args.currentTarget.features, { keep: args.currentTarget.prompts, salt });
  const step = args.currentTarget.lastDecision?.step ?? 0;
  const target = args.vote === 'up'
    ? withDecision(base, 'hold', 'Keeping the liked heard blend now; scheduled variations will continue without inventing more votes.', state, step, salt)
    : choose(state, base, args.currentTarget, 'down', step, rng);
  return { state: { ...state, seed: rng.seed }, target };
}

/** Controller schedules exposure and owns step. This function changes no evidence. */
export function evolveNoVote(args: { state: LearnerState; target: Target; step?: number }): Target {
  const fallbackStep = (args.target.lastDecision?.step ?? 0) + 1;
  const step = Number.isFinite(args.step) ? Math.max(0, Math.trunc(args.step!)) : fallbackStep;
  const rng = createRng(hashText(`${fingerprint(args.target.features)}:${step}`, args.state.seed));
  return choose(args.state, args.target, args.target, 'variation', step, rng);
}

export function inspect(state: LearnerState, target: Target) {
  const current = context(state, target.features);
  const marginalVariance = FEATURE_IDS.map((_, i) => {
    const axis = FEATURE_IDS.map((__, j) => i === j ? 1 : 0);
    return uncertainty(current.L, axis) ** 2;
  });
  // Average marginal information reduction, NOT confidence in the listener's taste.
  const coverage = marginalVariance.reduce((total, variance) => total + clamp01(1 - P.ridge * variance), 0) / FEATURE_IDS.length;
  return {
    phase: current.phase,
    reason: target.lastDecision?.reason ?? 'Waiting for explicit feedback and adequate listening exposure.',
    evidence: state.evidence,
    rankedFeatures: FEATURE_IDS.map((id, i) => ({ id, score: current.theta[i]! })).sort((a, b) => b.score - a.score),
    prediction: current.predicted,
    uncertainty: current.uncertain,
    information: current.information,
    coverage,
    purpose: state.purpose,
    recipeCount: RECIPES.length,
    recoveries: state.recoveries,
    lastRecoveryVote: state.lastRecoveryVote,
    uncertaintyMeaning: 'Regularized model uncertainty for this prompt blend; not a probability or a measurement of audible taste.',
  };
}
