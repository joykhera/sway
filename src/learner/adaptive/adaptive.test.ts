import { describe, expect, it } from 'vitest';
import { FEATURE_IDS } from '../vocabulary';
import { signature } from '../targets';
import { createLearner, initialTarget, processVote, evolveNoVote, inspect, PARAMETERS } from './index';
import type { FeatureBlend, LearnerState, Target } from './index';
import { dot, factor, solve, uncertainty, vector } from './model';
import { RECIPES } from './recipes';

const copy = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe('adaptive joint preference model', () => {
  it('fits the entire normalized audible mixture including projected-out components', () => {
    const state = freeze(createLearner(42));
    const pending = freeze(initialTarget(state));
    const audible: FeatureBlend = freeze({ ambient: 0.5, lofi: 0.2, jazz: 0.1, piano: 0.4, synth: 0.3, guitar: 0.2, calm: 0.3, dreamy: 0.15, sparse: 0.2 });
    const x = vector(audible);
    const weight = 0.4;
    const result = processVote({ state, audible, currentTarget: pending, vote: 'down', evidenceWeight: weight });
    const denominator = PARAMETERS.ridge + weight * dot(x, x);
    for (let i = 0; i < FEATURE_IDS.length; i += 1) {
      expect(result.state.b[i]).toBeCloseTo(-weight * x[i]!, 12);
      expect(result.state.scores[FEATURE_IDS[i]!]).toBeCloseTo(-weight * x[i]! / denominator, 12);
      for (let j = 0; j < FEATURE_IDS.length; j += 1) {
        expect(result.state.A[i]![j]).toBeCloseTo((i === j ? PARAMETERS.ridge : 0) + weight * x[i]! * x[j]!, 12);
      }
    }
    expect(result.state.A[0]![5]).toBeGreaterThan(0);
    expect(result.state.votes).toBe(1);
    expect(result.state.evidence).toBeCloseTo(weight);
    expect(state.evidence).toBe(0);
  });

  it('solves a coupled positive-definite matrix without diagonal-only approximation', () => {
    const A = [[4, 1, 0.5], [1, 3, 0.25], [0.5, 0.25, 2]];
    const b = [1, -2, 0.5];
    const L = factor(A);
    const theta = solve(L, b);
    for (let i = 0; i < 3; i += 1) expect(dot(A[i]!, theta)).toBeCloseTo(b[i]!, 12);
    const x = [0.2, 0.3, 0.5];
    expect(uncertainty(L, x) ** 2).toBeCloseTo(dot(x, solve(L, x)), 12);
  });

  it('holds the liked heard blend immediately instead of amplifying an inferred ingredient', () => {
    const state = createLearner(10, 'focus');
    const target = initialTarget(state);
    const liked = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' });
    expect(liked.target.features).toEqual(target.features);
    expect(liked.target.prompts).toEqual(target.prompts);
    expect(liked.target.lastDecision?.kind).toBe('hold');
    expect(liked.state.positiveEvidence).toBe(1);
    expect(liked.state.negativeEvidence).toBe(0);
  });

  it('keeps repeated-blend information local instead of claiming certainty about unseen features', () => {
    let state = createLearner(2);
    const target = RECIPES[0]!.target;
    const unseen = FEATURE_IDS.indexOf('classical');
    for (let i = 0; i < 40; i += 1) state = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' }).state;
    const info = inspect(state, target);
    expect(info.information).toBeGreaterThan(0.9);
    expect(info.coverage).toBeLessThan(1 / FEATURE_IDS.length);
    const axis = FEATURE_IDS.map((_, i) => i === unseen ? 1 : 0);
    expect(uncertainty(factor(state.A), axis)).toBeCloseTo(1 / Math.sqrt(PARAMETERS.ridge), 12);
    let varied = createLearner(2);
    for (let i = 0; i < 40; i += 1) {
      const heard = RECIPES[(i * 17) % RECIPES.length]!.target;
      varied = processVote({ state: varied, audible: heard.features, currentTarget: heard, vote: 'up' }).state;
    }
    expect(varied.votes).toBe(state.votes);
    expect(inspect(varied, target).coverage).toBeGreaterThan(info.coverage * 3);
  });

  it('uses evidence weights without letting zero-weight or empty clicks create evidence or forgetting', () => {
    const first = createLearner(18);
    const target = initialTarget(first);
    const learned = processVote({ state: first, audible: target.features, currentTarget: target, vote: 'up' }).state;
    for (const [audible, evidenceWeight] of [[target.features, 0], [target.features, NaN], [target.features, -2], [{}, 1]] as const) {
      const next = processVote({ state: learned, audible, currentTarget: target, vote: 'down', evidenceWeight }).state;
      expect(next.A).toEqual(learned.A);
      expect(next.b).toEqual(learned.b);
      expect(next.scores).toEqual(learned.scores);
      expect(next.evidence).toBe(learned.evidence);
      expect(next.recentRejections).toBe(learned.recentRejections);
      expect(next.unexpectedDislikes).toEqual(learned.unexpectedDislikes);
      expect(next.recoveryArmed).toBe(learned.recoveryArmed);
      expect(next.recoveries).toBe(learned.recoveries);
      expect(next.lastRecoveryVote).toBe(learned.lastRecoveryVote);
      expect(next.votes).toBe(learned.votes + 1);
    }
    const weighted = processVote({ state: first, audible: target.features, currentTarget: target, vote: 'up', evidenceWeight: 0.25 });
    expect(weighted.state.evidence).toBe(0.25);
    expect(inspect(weighted.state, target).information).toBeLessThan(inspect(learned, target).information);
  });

  it('keeps purpose a soft prior with no fabricated preference reward', () => {
    const focus = createLearner(42, 'focus');
    const explore = createLearner(42, 'explore');
    expect(focus.A).toEqual(explore.A);
    expect(focus.b).toEqual(explore.b);
    expect(initialTarget(focus).features.calm).toBeDefined();
    expect(focus.evidence).toBe(0);
    expect(focus.votes).toBe(0);
    expect(RECIPES).toHaveLength(375);
    expect(new Set(RECIPES.map(({ target }) => signature(target.features))).size).toBe(375);
  });

  it('continues meaningful scheduled variations after likes while preserving every state field', () => {
    let state = createLearner(42, 'focus');
    let target = initialTarget(state);
    for (let i = 0; i < 12; i += 1) ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' }));
    const frozenState = freeze(copy(state));
    const before = copy(state);
    const visited = new Set([signature(target.features)]);
    for (let step = 1; step <= 16; step += 1) {
      const frozenTarget = freeze(copy(target));
      const next = evolveNoVote({ state: frozenState, target: frozenTarget, step });
      expect(signature(next.features)).not.toBe(signature(target.features));
      expect(next).toEqual(evolveNoVote({ state: frozenState, target: frozenTarget, step }));
      expect(next.lastDecision?.step).toBe(step);
      visited.add(signature(next.features));
      target = next;
    }
    expect(visited.size).toBeGreaterThan(2);
    expect(frozenState).toEqual(before);
    expect(evolveNoVote({ state, target }).lastDecision?.step).toBe(17);
  });

  it('changes after downvotes without forcing an unrelated genre in a supported family', () => {
    let retainedGenre = 0;
    for (let seed = 0; seed < 12; seed += 1) {
      let state = createLearner(seed);
      let target = initialTarget(state);
      for (let vote = 0; vote < 10; vote += 1) ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' }));
      const next = processVote({ state, audible: target.features, currentTarget: target, vote: 'down' });
      expect(signature(next.target.features)).not.toBe(signature(target.features));
      if (Object.keys(target.features).slice(0, 1).join() === Object.keys(next.target.features).slice(0, 1).join()) retainedGenre += 1;
      const rapid = processVote({ state: next.state, audible: target.features, currentTarget: next.target, vote: 'down', evidenceWeight: 0 });
      expect(signature(rapid.target.features)).not.toBe(signature(target.features));
      expect(signature(rapid.target.features)).not.toBe(signature(next.target.features));
    }
    expect(retainedGenre).toBeGreaterThan(0);
  });

  it('replays a long mixed sequence with finite bounded prompts and positive-definite state', () => {
    const replay = (): { state: LearnerState; target: Target } => {
      let state = createLearner(7, 'relax');
      let target = initialTarget(state);
      for (let i = 0; i < 180; i += 1) {
        ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: i % 4 === 0 ? 'down' : 'up', evidenceWeight: i % 7 === 0 ? 0.2 : 1 }));
        if (i % 3 === 0) target = evolveNoVote({ state, target, step: i + 1 });
        expect(target.prompts.every((p) => Number.isFinite(p.weight) && p.weight >= 0.1 && p.weight <= 2)).toBe(true);
        expect(Object.values(state.scores).every(Number.isFinite)).toBe(true);
      }
      expect(() => factor(state.A)).not.toThrow();
      return { state, target };
    };
    expect(replay()).toEqual(replay());
  });

  it('discounts once after distinct supported blends reverse, retaining the latest feedback exactly', () => {
    const first = RECIPES[0]!.target;
    const second = RECIPES[1]!.target;
    let state = createLearner(22);
    for (let i = 0; i < 24; i += 1) {
      const heard = i % 2 === 0 ? first : second;
      state = processVote({ state, audible: heard.features, currentTarget: heard, vote: 'up' }).state;
    }
    expect(inspect(state, first).prediction).toBeGreaterThan(PARAMETERS.supportedPrediction);
    expect(inspect(state, second).information).toBeGreaterThan(PARAMETERS.supportedInformation);
    state = processVote({ state, audible: first.features, currentTarget: first, vote: 'down' }).state;
    expect(state.recoveries).toBe(0);
    expect(state.unexpectedDislikes).toHaveLength(1);
    const before = freeze(copy(state));
    const recovered = processVote({ state: before, audible: second.features, currentTarget: second, vote: 'down' });
    let unchangedPolicy = processVote({ state: { ...before, recoveryArmed: false }, audible: second.features, currentTarget: second, vote: 'down' }).state;
    expect(recovered.state.recoveries).toBe(1);
    expect(recovered.state.recoveryArmed).toBe(false);
    expect(recovered.state.lastRecoveryVote).toBe(before.votes + 1);
    expect(recovered.target.lastDecision?.reason).toContain('Reconsidering older assumptions');
    const x = vector(second.features);
    const discount = PARAMETERS.forgetting * PARAMETERS.recoveryRetention;
    for (let i = 0; i < FEATURE_IDS.length; i += 1) {
      expect(recovered.state.b[i]).toBeCloseTo(discount * before.b[i]! - x[i]!, 12);
      for (let j = 0; j < FEATURE_IDS.length; j += 1) {
        expect(recovered.state.A[i]![j]).toBeCloseTo(discount * before.A[i]![j]! + (i === j ? (1 - discount) * PARAMETERS.ridge : 0) + x[i]! * x[j]!, 12);
      }
    }
    state = recovered.state;
    for (let i = 0; i < 6; i += 1) {
      const heard = i % 2 === 0 ? first : second;
      state = processVote({ state, audible: heard.features, currentTarget: heard, vote: 'down' }).state;
      unchangedPolicy = processVote({ state: unchangedPolicy, audible: heard.features, currentTarget: heard, vote: 'down' }).state;
    }
    expect(state.recoveries).toBe(1);
    expect(inspect(state, first).prediction).toBeLessThan(0);
    expect(inspect(unchangedPolicy, first).prediction).toBeGreaterThan(0);
    const zeroLike = processVote({ state, audible: first.features, currentTarget: first, vote: 'up', evidenceWeight: 0 }).state;
    expect(zeroLike.recoveryArmed).toBe(false);
    expect(zeroLike.A).toEqual(state.A);
    expect(zeroLike.b).toEqual(state.b);
    expect(zeroLike.evidence).toBe(state.evidence);
    expect(zeroLike.recoveries).toBe(1);
  });

  it('does not recover from repeated copies, zero-weight clicks, or expected-poor exploration', () => {
    const liked = RECIPES[0]!.target;
    const otherSupported = RECIPES[1]!.target;
    const poor = RECIPES.at(-1)!.target;
    let state = createLearner(19);
    for (let i = 0; i < 30; i += 1) {
      const heard = i % 2 === 0 ? liked : otherSupported;
      state = processVote({ state, audible: heard.features, currentTarget: heard, vote: 'up' }).state;
    }
    for (let i = 0; i < 2; i += 1) state = processVote({ state, audible: liked.features, currentTarget: liked, vote: 'down' }).state;
    expect(state.recoveries).toBe(0);
    expect(state.unexpectedDislikes).toHaveLength(1);
    expect(state.unexpectedDislikes[0]!.weight).toBe(1);
    const beforeZero = copy(state);
    state = processVote({ state, audible: otherSupported.features, currentTarget: otherSupported, vote: 'down', evidenceWeight: 0 }).state;
    expect(state.A).toEqual(beforeZero.A);
    expect(state.b).toEqual(beforeZero.b);
    expect(state.scores).toEqual(beforeZero.scores);
    expect(state.evidence).toBe(beforeZero.evidence);
    expect(state.unexpectedDislikes).toEqual(beforeZero.unexpectedDislikes);
    expect(state.recoveryArmed).toBe(beforeZero.recoveryArmed);
    expect(state.recoveries).toBe(0);
    expect(inspect(state, poor).prediction).toBeLessThanOrEqual(0);
    for (let i = 0; i < 10; i += 1) state = processVote({ state, audible: poor.features, currentTarget: poor, vote: 'down' }).state;
    expect(state.recoveries).toBe(0);
    expect(state.unexpectedDislikes).toEqual(beforeZero.unexpectedDislikes);
  });
});
