import { describe, expect, it } from 'vitest';
import { FEATURE_IDS } from '../vocabulary';
import { toTarget } from '../targets';
import { createLearner, initialTarget, processVote, evolveNoVote, inspect, PARAMETERS as P } from './index';
import { adaptiveLearner, isAdaptiveState } from './adapter';
import { vector } from './model';
import type { FeatureBlend, LearnerState } from './types';

const slow = toTarget({ electronic: 0.45, synth: 0.4, calm: 0.3, sparse: 0.25 });
const fast = toTarget({ electronic: 0.45, synth: 0.4, energetic: 0.3, rhythmic: 0.25 });
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
};

describe('explicit directional comparison feedback', () => {
  it('splits one Like budget between the heard blend and signed difference, with no pairwise credit on unchanged coordinates', () => {
    const state = freeze(createLearner(42));
    const before = structuredClone(state);
    const x = vector(fast.features);
    const previous = vector(slow.features);
    const d = x.map((value, i) => value - previous[i]!);
    const weight = 0.4;
    const pair = weight * P.comparisonShare;
    const absolute = weight - pair;
    const result = processVote({ state, audible: fast.features, currentTarget: fast, vote: 'up', evidenceWeight: weight, comparison: { previous: slow.features } });
    for (let i = 0; i < FEATURE_IDS.length; i++) {
      expect(result.state.b[i]).toBeCloseTo(absolute * x[i]! + pair * P.comparisonMargin * d[i]!, 12);
      for (let j = 0; j < FEATURE_IDS.length; j++) {
        expect(result.state.A[i]![j]).toBeCloseTo((i === j ? P.ridge : 0) + absolute * x[i]! * x[j]! + pair * d[i]! * d[j]!, 12);
      }
    }
    for (const id of ['electronic', 'synth'] as const) {
      const index = FEATURE_IDS.indexOf(id);
      expect(d[index]).toBe(0);
      expect(result.state.b[index]).toBeCloseTo(absolute * x[index]!, 12);
    }
    expect(result.state.scores.energetic).toBeGreaterThan(result.state.scores.calm);
    expect(result.state.scores.rhythmic).toBeGreaterThan(result.state.scores.sparse);
    expect(result.state.evidence).toBe(weight);
    expect(result.state.positiveEvidence).toBe(weight);
    expect(result.state.pairwiseEvidence).toBe(pair);
    expect(result.state.votes).toBe(1);
    expect(result.target.features).toEqual(fast.features);
    expect(result.target.prompts).toEqual(fast.prompts);
    expect(result.target.lastDecision?.reason).toContain('recent rejected blend');
    expect(inspect(result.state, result.target).pairwiseEvidence).toBe(pair);
    expect(state).toEqual(before);
  });

  it('changes future recipe choices after repeated rejected→liked episodes, while scheduled evolution preserves every learned field', () => {
    let beforePreferred = 0;
    let afterPreferred = 0;
    // Fixed synthetic prompt fixture, not a claim about actual audible BPM or taste.
    for (let seed = 0; seed < 32; seed++) {
      let state = createLearner(seed);
      const before = evolveNoVote({ state, target: slow, step: 7 });
      beforePreferred += Number(!!before.features.energetic) + Number(!!before.features.rhythmic);
      for (let episode = 0; episode < 4; episode++) {
        state = processVote({ state, audible: slow.features, currentTarget: slow, vote: 'down' }).state;
        state = processVote({ state, audible: fast.features, currentTarget: fast, vote: 'up', comparison: { previous: slow.features } }).state;
      }
      expect(state.scores.energetic - state.scores.calm).toBeGreaterThan(0);
      expect(state.scores.rhythmic - state.scores.sparse).toBeGreaterThan(0);
      expect(isAdaptiveState(JSON.parse(JSON.stringify(state)))).toBe(true);
      const saved = structuredClone(state);
      const next = evolveNoVote({ state: freeze(state), target: slow, step: 7 });
      afterPreferred += Number(!!next.features.energetic) + Number(!!next.features.rhythmic);
      expect(state).toEqual(saved);
    }
    expect(afterPreferred).toBeGreaterThan(beforePreferred);
    expect(afterPreferred).toBeGreaterThan(32);
  });

  it('ignores comparisons on downvotes, zero-weight actions, identical vectors, and invalid reference blends', () => {
    const initial = createLearner(21);
    const state = processVote({ state: initial, audible: fast.features, currentTarget: fast, vote: 'up', comparison: { previous: slow.features } }).state;
    const comparisons: Array<{ vote: 'up' | 'down'; weight: number; previous: FeatureBlend }> = [
      { vote: 'down', weight: 1, previous: slow.features },
      { vote: 'up', weight: 0, previous: slow.features },
      { vote: 'up', weight: NaN, previous: slow.features },
      { vote: 'up', weight: 1, previous: fast.features },
      { vote: 'up', weight: 1, previous: Object.fromEntries(Object.entries(fast.features).map(([id, value]) => [id, value! * 0.5])) },
      { vote: 'up', weight: 1, previous: {} },
      { vote: 'up', weight: 1, previous: { calm: NaN } },
      { vote: 'up', weight: 1, previous: { calm: -1 } },
      { vote: 'up', weight: 1, previous: { calm: 2 } },
      { vote: 'up', weight: 1, previous: { calm: 0.5, unknown: 0.5 } as FeatureBlend },
    ];
    for (const { vote, weight, previous } of comparisons) {
      const args = { state, audible: fast.features, currentTarget: fast, vote, evidenceWeight: weight };
      expect(processVote({ ...args, comparison: { previous } })).toEqual(processVote(args));
    }
    const zero = processVote({ state, audible: fast.features, currentTarget: fast, vote: 'up', evidenceWeight: 0, comparison: { previous: slow.features } });
    for (const field of ['A', 'b', 'scores', 'evidence', 'pairwiseEvidence', 'positiveEvidence', 'negativeEvidence', 'unexpectedDislikes', 'recoveries'] as const) {
      expect(zero.state[field]).toEqual(state[field]);
    }
  });

  it('forwards comparisons and complete learned metadata through the shared adapter', () => {
    const state = createLearner(4);
    const args = { state, audible: fast.features, currentTarget: fast, vote: 'up' as const, comparison: { previous: slow.features } };
    const adapted = adaptiveLearner.processVote(args);
    expect(adapted).toEqual(processVote(args));
    expect(isAdaptiveState(adapted.state)).toBe(true);
    const saved = JSON.parse(JSON.stringify(adapted.state)) as unknown;
    if (!isAdaptiveState(saved)) throw new Error('Complete state was rejected');
    const next = adaptiveLearner.processVote({ state: saved, audible: fast.features, currentTarget: adapted.target, vote: 'up' });
    expect(next.state).toHaveProperty('pairwiseEvidence', P.forgetting * P.comparisonShare);
    expect(next.target).toHaveProperty('phrasingSalt');
    expect(next.target).toHaveProperty('lastDecision.kind', 'hold');
  });
});

describe('Crazy starting profile', () => {
  it('is deterministic, distinct from Energy, and uses fast experimental wording without stronger weights or fabricated evidence', () => {
    for (let seed = 0; seed < 24; seed++) {
      const state = createLearner(seed, 'crazy');
      const target = initialTarget(state);
      expect(target).toEqual(initialTarget(createLearner(seed, 'crazy')));
      expect(target.prompts).not.toEqual(initialTarget(createLearner(seed, 'energy')).prompts);
      expect(target.features).toMatchObject({ electronic: 0.45, energetic: 0.3, rhythmic: 0.25 });
      expect(target.prompts.map(({ text }) => text).join(' ')).toMatch(/fast|frenetic/);
      expect(target.prompts.map(({ text }) => text).join(' ')).toMatch(/experimental|glitch/);
      expect(target.prompts.map(({ weight }) => weight)).toEqual([0.9, 0.8, 0.6, 0.5]);
      expect(state.A).toEqual(createLearner(seed, 'energy').A);
      expect(state.b).toEqual(createLearner(seed, 'energy').b);
      expect(state.evidence).toBe(0);
      expect(state.pairwiseEvidence).toBe(0);
      expect(isAdaptiveState(state)).toBe(true);
      const liked = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' });
      expect(liked.target.prompts).toEqual(target.prompts);
    }
  });

  it('restores Crazy wording on a mid-ramp Like and keeps adapter target metadata', () => {
    const state = createLearner(42, 'crazy');
    const original = initialTarget(state);
    const redirected = processVote({ state, audible: original.features, currentTarget: original, vote: 'down' });
    const audible = Object.fromEntries(FEATURE_IDS.map(id => [id, 0.7 * (original.features[id] ?? 0) + 0.3 * (redirected.target.features[id] ?? 0)]));
    const held = adaptiveLearner.processVote({ state: redirected.state, audible, currentTarget: redirected.target, vote: 'up', comparison: { previous: original.features } });
    const heldTexts = new Set(held.target.prompts.map(prompt => prompt.text));
    for (const prompt of original.prompts) expect(heldTexts.has(prompt.text)).toBe(true);
    expect(held.target).toHaveProperty('phrasingSalt', 42);
    expect(held.target).toHaveProperty('lastDecision.kind', 'hold');
    expect(isAdaptiveState(held.state)).toBe(true);
  });

  it('remains a soft starting hint that learned evidence can override', () => {
    let state = createLearner(42, 'crazy');
    const alternative = toTarget({ classical: 0.45, piano: 0.4, calm: 0.3, sparse: 0.25 });
    const starting = initialTarget(state);
    for (let i = 0; i < 12; i++) {
      state = processVote({ state, audible: starting.features, currentTarget: starting, vote: 'down' }).state;
      state = processVote({ state, audible: alternative.features, currentTarget: alternative, vote: 'up', comparison: { previous: starting.features } }).state;
    }
    expect(initialTarget(state).features).toMatchObject({ classical: 0.45, piano: 0.4, calm: 0.3 });
    expect(initialTarget(state).features.rhythmic).toBeUndefined(); // Exploration may still try another texture.
  });
});

describe('persisted adaptive-state boundary', () => {
  it('rejects missing fields, non-finite/unbounded/asymmetric/indefinite matrices, inconsistent model fields and malformed policy history', () => {
    const fresh = createLearner(17, 'crazy');
    for (const invalid of [null, [], true, 0, '', {}, { ...fresh, pairwiseEvidence: undefined }]) expect(isAdaptiveState(invalid)).toBe(false);
    const corruptions: Array<(state: LearnerState) => void> = [
      s => { s.A[0]![0] = Infinity; },
      s => { s.A[0]![0] = 1e100; },
      s => { s.A[0]![1] = 0.1; },
      s => { s.A[0]![1] = s.A[1]![0] = 1; },
      s => { s.A[0]![0] = 0.01; }, // SPD but below ridge and badly conditioned
      s => { s.A[0]![0] = 1; }, // learned information without any evidence
      s => { s.scores.calm = 0.5; },
      s => { s.b[0] = NaN; },
      s => { s.b[0] = 10000; },
      s => { s.evidence = 10000; },
      s => { s.positiveEvidence = 1; },
      s => { s.pairwiseEvidence = 0.5; },
      s => { s.votes = 1.5; },
      s => { s.seed = 2 ** 32; },
      s => { s.recentRejections = 11; },
      s => { s.recoveries = 1; },
      s => { s.lastRecoveryVote = 1; },
      s => { s.recoveryArmed = undefined as never; },
      s => { s.unexpectedDislikes = [{ x: Array(18).fill(1), weight: 1 }]; },
      s => { s.unexpectedDislikes = [{ x: vector(slow.features), weight: 2 }]; },
    ];
    for (const corrupt of corruptions) {
      const state = structuredClone(fresh);
      corrupt(state);
      expect(isAdaptiveState(state)).toBe(false);
    }
  });

  it('accepts JSON round trips over a long fractional, zero, directional and recovery-capable sequence', () => {
    let state = createLearner(31, 'crazy');
    let target = initialTarget(state);
    for (let i = 0; i < 180; i++) {
      const previous = target.features;
      const next = evolveNoVote({ state, target, step: i });
      ({ state, target } = processVote({ state, audible: next.features, currentTarget: next, vote: i % 3 ? 'up' : 'down', evidenceWeight: i % 7 ? 0.6 : 0, comparison: { previous } }));
      expect(isAdaptiveState(JSON.parse(JSON.stringify(state)))).toBe(true);
    }
  });
});

describe('consecutive distinct rejection style escape', () => {
  const heard = ['calm', 'dreamy', 'hopeful'].map(mood => toTarget({ electronic: 0.45, synth: 0.4, [mood]: 0.3, sparse: 0.25 }));
  function supported(seed = 42) {
    let state = createLearner(seed);
    for (let i = 0; i < 18; i++) {
      const target = heard[i % heard.length]!;
      state = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' }).state;
    }
    return state;
  }

  it('makes the third distinct rejection leave genre and instrument even when prior scores support that style', () => {
    const changedStyles = [0, 0, 0];
    for (let seed = 0; seed < 32; seed++) {
      let state = supported(seed);
      for (let index = 0; index < heard.length; index++) {
        const target = heard[index]!;
        const before = state;
        const result = processVote({ state: freeze(state), audible: target.features, currentTarget: target, vote: 'down' });
        state = result.state;
        changedStyles[index]! += Number(!result.target.features.electronic) + Number(!result.target.features.synth);
        expect(state.rejectedBlends).toHaveLength(index + 1);
        expect(!!result.target.lastDecision?.styleEscape).toBe(index === 2);
        if (index === 2) {
          expect(result.target.features.electronic).toBeUndefined();
          expect(result.target.features.synth).toBeUndefined();
          expect(result.target.lastDecision?.reason).toContain('three distinct rejected');
          expect(inspect(state, result.target)).toMatchObject({ rejectedBlendCount: 3, styleEscape: true });
          const ordinary = processVote({ state: { ...before, rejectedBlends: [] }, audible: target.features, currentTarget: target, vote: 'down' });
          expect(state.A).toEqual(ordinary.state.A);
          expect(state.b).toEqual(ordinary.state.b);
          expect(state.scores).toEqual(ordinary.state.scores); // Escape itself does not erase evidence.
        }
        expect(isAdaptiveState(JSON.parse(JSON.stringify(state)))).toBe(true);
      }
    }
    expect(changedStyles[2]).toBe(64);
    expect(changedStyles[2]).toBeGreaterThan(changedStyles[0]!);
    expect(changedStyles[2]).toBeGreaterThan(changedStyles[1]!);
  });

  it('does not escalate from repeated same-blend or zero-weight dislikes and only an effective Like clears the streak', () => {
    let state = supported();
    const target = heard[0]!;
    for (let i = 0; i < 8; i++) {
      const result = processVote({ state, audible: target.features, currentTarget: target, vote: 'down' });
      state = result.state;
      expect(state.rejectedBlends).toHaveLength(1);
      expect(result.target.lastDecision?.styleEscape).toBeUndefined();
    }
    for (const next of heard.slice(1)) {
      const before = structuredClone(state);
      const zero = processVote({ state, audible: next.features, currentTarget: next, vote: 'down', evidenceWeight: 0 });
      expect(zero.state.rejectedBlends).toEqual(before.rejectedBlends);
      expect(zero.state.A).toEqual(before.A);
      expect(zero.state.b).toEqual(before.b);
      expect(zero.target.lastDecision?.styleEscape).toBeUndefined();
    }
    for (const next of heard.slice(1)) state = processVote({ state, audible: next.features, currentTarget: next, vote: 'down' }).state;
    expect(state.rejectedBlends).toHaveLength(3);
    const zeroLike = processVote({ state, audible: target.features, currentTarget: target, vote: 'up', evidenceWeight: 0 });
    expect(zeroLike.state.rejectedBlends).toEqual(state.rejectedBlends);
    expect(zeroLike.state.recentRejections).toBe(state.recentRejections);
    const liked = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' });
    expect(liked.state.rejectedBlends).toEqual([]);
    expect(liked.state.recentRejections).toBe(0);
    expect(liked.state.recoveries).toBe(state.recoveries);
    const next = processVote({ state: liked.state, audible: target.features, currentTarget: target, vote: 'down' });
    expect(next.state.rejectedBlends).toHaveLength(1);
    expect(next.target.lastDecision?.styleEscape).toBeUndefined();
  });

  it('excludes both audible and pending styles when possible, and still changes pending styles when all audible features are occupied', () => {
    let state = supported(11);
    for (const target of heard.slice(0, 2)) state = processVote({ state, audible: target.features, currentTarget: target, vote: 'down' }).state;
    const pending = toTarget({ classical: 0.45, piano: 0.4, energetic: 0.3, rhythmic: 0.25 });
    const escaped = processVote({ state, audible: heard[2]!.features, currentTarget: pending, vote: 'down' });
    expect(escaped.target.features.electronic).toBeUndefined();
    expect(escaped.target.features.classical).toBeUndefined();
    expect(escaped.target.features.synth).toBeUndefined();
    expect(escaped.target.features.piano).toBeUndefined();
    const allFeatures = Object.fromEntries(FEATURE_IDS.map(id => [id, 0.1]));
    const fallback = processVote({ state: escaped.state, audible: allFeatures, currentTarget: pending, vote: 'down' });
    expect(fallback.target.lastDecision?.styleEscape).toBe(true);
    expect(fallback.target.features.classical).toBeUndefined();
    expect(fallback.target.features.piano).toBeUndefined();
    expect(fallback.target.prompts).toHaveLength(4);
    expect(isAdaptiveState(fallback.state)).toBe(true);
  });

  it('validates the complete bounded distinct rejection ledger in saved state', () => {
    const state = createLearner(9);
    expect(isAdaptiveState({ ...state, rejectedBlends: undefined })).toBe(false);
    expect(isAdaptiveState({ ...state, rejectedBlends: heard.map(target => vector(target.features)) })).toBe(false);
    expect(isAdaptiveState({ ...state, rejectedBlends: [Array(18).fill(1)] })).toBe(false);
    expect(isAdaptiveState({ ...state, rejectedBlends: [vector(slow.features), vector(slow.features)] })).toBe(false);
    expect(isAdaptiveState({ ...state, rejectedBlends: [vector(slow.features), vector(slow.features), vector(slow.features), vector(slow.features)] })).toBe(false);
  });
});
