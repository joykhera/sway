import type { Learner, LearnerState as SharedState, Target as SharedTarget } from '../../shared/protocol';
import { FEATURE_IDS } from '../vocabulary';
import * as adaptive from './index';
import type { LearnerState, Target } from './types';
import { PARAMETERS as P } from './constants';
import { factor, solve } from './model';
import { distance } from './recipes';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const integer = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * (1 + Math.max(Math.abs(a), Math.abs(b)));
const vector = (value: unknown): value is number[] => Array.isArray(value)
  && value.length === FEATURE_IDS.length && Array.from(value).every(finite);
// With w <= 1 and gamma = forgetting ** w, discounted effective evidence stays
// below this envelope, including fractional weights and recovery discounts.
const MAX_EVIDENCE = 1 / (1 - P.forgetting) + 1;
const MAX_B = MAX_EVIDENCE * (1 + P.comparisonShare * (P.comparisonMargin - 1));
const MAX_COEFFICIENT = MAX_B / P.ridge + 1;

/** Validate complete persisted JSON before it can reach a solver or controller. */
export function isAdaptiveState(state: unknown): state is LearnerState {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const candidate = state as Partial<LearnerState>;
  if (!(integer(candidate.votes)
    && integer(candidate.seed) && candidate.seed <= 0xffffffff
    && candidate.scores && typeof candidate.scores === 'object' && !Array.isArray(candidate.scores)
    && FEATURE_IDS.every((id) => finite(candidate.scores![id]) && Math.abs(candidate.scores![id]) <= MAX_COEFFICIENT)
    && ['focus', 'relax', 'energy', 'explore', 'crazy'].includes(candidate.purpose ?? '')
    && Array.isArray(candidate.A) && candidate.A.length === FEATURE_IDS.length && Array.from(candidate.A).every(vector)
    && candidate.A.every((row) => row.every((value) => Math.abs(value) <= MAX_EVIDENCE + P.ridge))
    && vector(candidate.b) && candidate.b.every((value) => Math.abs(value) <= MAX_B)
    && nonnegative(candidate.evidence) && candidate.evidence <= MAX_EVIDENCE && candidate.evidence <= candidate.votes
    && nonnegative(candidate.positiveEvidence) && nonnegative(candidate.negativeEvidence)
    && near(candidate.evidence, candidate.positiveEvidence + candidate.negativeEvidence)
    && nonnegative(candidate.pairwiseEvidence) && candidate.pairwiseEvidence <= P.comparisonShare * candidate.positiveEvidence + 1e-8
    && (candidate.lastVote === null || candidate.lastVote === 'up' || candidate.lastVote === 'down')
    && (candidate.votes === 0 ? candidate.lastVote === null : candidate.lastVote !== null)
    && nonnegative(candidate.recentRejections) && candidate.recentRejections <= 10 + 1e-8
    && Array.isArray(candidate.rejectedBlends) && candidate.rejectedBlends.length <= P.styleEscapeRejections && candidate.rejectedBlends.length <= candidate.votes
    && Array.from(candidate.rejectedBlends).every((blend, index, blends) => vector(blend)
      && blend.every(nonnegative) && near(blend.reduce((a, b) => a + b, 0), 1)
      && blends.slice(0, index).every(previous => vector(previous) && distance(previous, blend) >= P.styleEscapeBlendDistance - 1e-8))
    && typeof candidate.recoveryArmed === 'boolean'
    && integer(candidate.recoveries) && candidate.recoveries <= candidate.votes
    && (candidate.recoveries === 0 ? candidate.lastRecoveryVote === null
      : integer(candidate.lastRecoveryVote) && candidate.lastRecoveryVote > 0 && candidate.lastRecoveryVote <= candidate.votes)
    && Array.isArray(candidate.unexpectedDislikes) && candidate.unexpectedDislikes.length <= 6
    && Array.from(candidate.unexpectedDislikes).every((entry) => entry && vector(entry.x)
      && entry.x.every(nonnegative) && near(entry.x.reduce((a, b) => a + b, 0), 1)
      && nonnegative(entry.weight) && entry.weight > 0 && entry.weight <= 1))) return false;
  const A = candidate.A;
  const evidence = candidate.evidence;
  const learnedTrace = A.reduce((total, row, i) => total + row[i]! - P.ridge, 0);
  if (learnedTrace < -1e-7 || learnedTrace > 2 * evidence + 1e-7
    || candidate.b.some((value) => Math.abs(value) > (MAX_B / MAX_EVIDENCE) * evidence + 1e-7)) return false;
  // Cholesky itself reads one triangle, so reject asymmetry explicitly first.
  if (!A.every((row, i) => row.every((value, j) => near(value, A[j]![i]!)))) return false;
  try {
    // All updates add PSD outer products to the ridge prior. This also rejects
    // near-singular/SPD-but-below-prior matrices instead of trusting finiteness.
    factor(A.map((row, i) => row.map((value, j) => value - (i === j ? P.ridge - 1e-8 : 0))));
    const expected = solve(factor(A), candidate.b);
    if (!expected.every((value, i) => finite(value) && near(value, candidate.scores![FEATURE_IDS[i]!]))) return false;
  } catch { return false; }
  return true;
}

function requireState(state: SharedState): LearnerState {
  if (!isAdaptiveState(state)) {
    throw new TypeError('Adaptive learner requires its complete state from adaptiveLearner.createLearner(); do not truncate model fields or pass a baseline learner state.');
  }
  return state;
}

function sharedTarget(target: Target): SharedTarget {
  // Preserve optional decision metadata while satisfying the wider shared index signature.
  const features: SharedTarget['features'] = {};
  for (const [id, value] of Object.entries(target.features)) if (value !== undefined) features[id] = value;
  return { ...target, features };
}

/** Stateless adapter: no model is retained anywhere except the returned state. */
export const adaptiveLearner: Learner = {
  createLearner: adaptive.createLearner,
  initialTarget: (state) => sharedTarget(adaptive.initialTarget(requireState(state))),
  processVote: (args) => {
    const result = adaptive.processVote({ ...args, state: requireState(args.state) });
    return { state: result.state, target: sharedTarget(result.target) };
  },
  evolveNoVote: (args) => sharedTarget(adaptive.evolveNoVote({ ...args, state: requireState(args.state) })),
};
