import { describe, expect, it } from 'vitest';
import type { Learner, LearnerState, Target } from '../../shared/protocol';
import { createLearner as createBaselineLearner } from '../index';
import { signature } from '../targets';
import { adaptiveLearner, isAdaptiveState } from './adapter';
import * as core from './index';

const learner: Learner = adaptiveLearner;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe('adaptive learner through the shared controller contract', () => {
  it('preserves the complete immutable model through two weighted votes', () => {
    let state: LearnerState = learner.createLearner(42, 'focus');
    let target: Target = learner.initialTarget(state);
    let directState = core.createLearner(42, 'focus');
    let directTarget = core.initialTarget(directState);
    for (const [vote, evidenceWeight] of [['up', 1], ['down', 0.5]] as const) {
      freeze(state); freeze(target);
      const before = structuredClone(state);
      const result = learner.processVote({ state, audible: target.features, currentTarget: target, vote, evidenceWeight });
      const direct = core.processVote({ state: directState, audible: directTarget.features, currentTarget: directTarget, vote, evidenceWeight });
      expect(state).toEqual(before);
      expect(result).toEqual(direct);
      expect(isAdaptiveState(result.state)).toBe(true);
      ({ state, target } = result);
      directState = direct.state; directTarget = direct.target;
    }
    expect(state.votes).toBe(2);
    if (!isAdaptiveState(state)) throw new Error('Adapter lost adaptive state');
    expect(state.purpose).toBe('focus');
    expect(state.A).toHaveLength(18);
    expect(state.evidence).toBeGreaterThan(1);
    expect(state.positiveEvidence).toBeGreaterThan(0);
    expect(state.negativeEvidence).toBe(0.5);
    expect(state.recoveryArmed).toBe(true);
  });

  it('forwards zero evidence weight while still accepting the explicit action', () => {
    const initial = learner.createLearner(9);
    const target = learner.initialTarget(initial);
    const learned = learner.processVote({ state: initial, audible: target.features, currentTarget: target, vote: 'up' });
    if (!isAdaptiveState(learned.state)) throw new Error('Adapter lost adaptive state');
    const before = structuredClone(learned.state);
    const result = learner.processVote({ state: freeze(learned.state), audible: target.features, currentTarget: target, vote: 'down', evidenceWeight: 0 });
    if (!isAdaptiveState(result.state)) throw new Error('Adapter lost adaptive state');
    for (const key of ['A', 'b', 'scores', 'evidence', 'positiveEvidence', 'negativeEvidence', 'unexpectedDislikes', 'recoveries'] as const) {
      expect(result.state[key]).toEqual(before[key]);
    }
    expect(result.state.votes).toBe(before.votes + 1);
    expect(signature(result.target.features)).not.toBe(signature(target.features));
  });

  it('forwards purpose and deterministic novelty steps without changing preference state', () => {
    const state = freeze(learner.createLearner(11, 'energy'));
    const target = freeze(learner.initialTarget(state));
    const before = structuredClone(state);
    const first = learner.evolveNoVote({ state, target, step: 7 });
    expect(first).toEqual(learner.evolveNoVote({ state, target, step: 7 }));
    expect(first).toEqual(core.evolveNoVote({ state: core.createLearner(11, 'energy'), target, step: 7 }));
    expect(first).toHaveProperty('lastDecision.step', 7);
    expect(signature(first.features)).not.toBe(signature(target.features));
    expect(state).toEqual(before);
    expect(state).toHaveProperty('purpose', 'energy');
    expect(learner.evolveNoVote({ state, target: first })).toHaveProperty('lastDecision.step', 8);
  });

  it('keeps interleaved sessions independent with no hidden adapter model', () => {
    const first = learner.createLearner(1, 'focus');
    const second = learner.createLearner(2, 'relax');
    const firstTarget = learner.initialTarget(first);
    const secondTarget = learner.initialTarget(second);
    const beforeSecond = structuredClone(second);
    learner.processVote({ state: first, audible: firstTarget.features, currentTarget: firstTarget, vote: 'down' });
    const actual = learner.processVote({ state: second, audible: secondTarget.features, currentTarget: secondTarget, vote: 'up' });
    const isolated = core.createLearner(2, 'relax');
    const isolatedTarget = core.initialTarget(isolated);
    expect(actual).toEqual(core.processVote({ state: isolated, audible: isolatedTarget.features, currentTarget: isolatedTarget, vote: 'up' }));
    expect(second).toEqual(beforeSecond);
  });

  it('rejects baseline, truncated, and malformed state rather than silently losing evidence', () => {
    const baseline: LearnerState = createBaselineLearner(42);
    expect(isAdaptiveState(baseline)).toBe(false);
    expect(() => learner.initialTarget(baseline)).toThrow(/complete state/);
    const full = core.createLearner(42);
    const truncated: LearnerState = { scores: full.scores, seed: full.seed, votes: full.votes };
    expect(() => learner.evolveNoVote({ state: truncated, target: core.initialTarget(full) })).toThrow(/complete state/);
    full.A[0]![0] = NaN;
    expect(isAdaptiveState(full)).toBe(false);
    expect(() => learner.initialTarget(full)).toThrow(/complete state/);
  });
});
