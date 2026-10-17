import type { Learner, LearnerState as SharedState, Target as SharedTarget } from '../../shared/protocol';
import { FEATURE_IDS } from '../vocabulary';
import * as adaptive from './index';
import type { LearnerState, Target } from './types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const vector = (value: unknown): value is number[] => Array.isArray(value)
  && value.length === FEATURE_IDS.length && Array.from(value).every(finite);

/** The shared controller carries this complete object opaquely between calls. */
export function isAdaptiveState(state: SharedState): state is LearnerState {
  const candidate = state as Partial<LearnerState>;
  return nonnegative(candidate.votes) && Number.isInteger(candidate.votes)
    && nonnegative(candidate.seed) && Number.isInteger(candidate.seed) && candidate.seed <= 0xffffffff
    && !!candidate.scores && FEATURE_IDS.every((id) => finite(candidate.scores![id]))
    && ['focus', 'relax', 'energy', 'explore'].includes(candidate.purpose ?? '')
    && Array.isArray(candidate.A) && candidate.A.length === FEATURE_IDS.length && Array.from(candidate.A).every(vector)
    && vector(candidate.b)
    && nonnegative(candidate.evidence) && nonnegative(candidate.positiveEvidence) && nonnegative(candidate.negativeEvidence)
    && (candidate.lastVote === null || candidate.lastVote === 'up' || candidate.lastVote === 'down')
    && nonnegative(candidate.recentRejections)
    && typeof candidate.recoveryArmed === 'boolean'
    && nonnegative(candidate.recoveries) && Number.isInteger(candidate.recoveries)
    && (candidate.lastRecoveryVote === null || (nonnegative(candidate.lastRecoveryVote)
      && Number.isInteger(candidate.lastRecoveryVote) && candidate.lastRecoveryVote <= candidate.votes))
    && Array.isArray(candidate.unexpectedDislikes) && candidate.unexpectedDislikes.length <= 6
    && Array.from(candidate.unexpectedDislikes).every((entry) => entry && vector(entry.x)
      && entry.x.every(nonnegative) && nonnegative(entry.weight) && entry.weight <= 1);
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
