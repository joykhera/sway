import { describe, expect, it } from 'vitest';
import { nudgeFeatures } from './targets';
import { createLearner, initialTarget, nudge } from './adaptive/index';
import { adaptiveLearner } from './adaptive/adapter';
import { FEATURE_OF_TEXT } from './vocabulary';

const blend = { jazz: 0.45, piano: 0.4, calm: 0.3, sparse: 0.25 };

describe('nudgeFeatures', () => {
  it('strengthens a feature that is already playing, a step at a time', () => {
    expect(nudgeFeatures(blend, 'jazz').jazz).toBeCloseTo(0.6);
    expect(nudgeFeatures({ ...blend, jazz: 0.95 }, 'jazz').jazz).toBe(1);
  });

  it('brings a new genre in beside the current one at a step', () => {
    const next = nudgeFeatures(blend, 'ambient');
    expect(next.ambient).toBeCloseTo(0.15);
    expect(next.jazz).toBe(0.45);
  });

  it('swaps a one-member group in at the old member\'s strength', () => {
    const next = nudgeFeatures(blend, 'energetic');
    expect(next.energetic).toBe(0.3);
    expect(next.calm).toBeUndefined();
  });

  it('makes room in a full group by giving up its weakest member', () => {
    const next = nudgeFeatures({ ...blend, lofi: 0.2 }, 'ambient');
    expect(next.ambient).toBe(0.2);
    expect(next.lofi).toBeUndefined();
    expect(next.jazz).toBe(0.45);
  });
});

describe('adaptive nudge', () => {
  it('steers toward the feature without touching the learner state', () => {
    const state = createLearner(3);
    const before = structuredClone(state);
    const start = initialTarget(state);
    const next = nudge({ state, target: start, feature: 'percussion' });
    expect(next.features.percussion).toBeGreaterThan(0);
    expect(next.prompts.some((p) => FEATURE_OF_TEXT.get(p.text) === 'percussion')).toBe(true);
    expect(next.phrasingSalt).toBe(start.phrasingSalt ?? state.seed);
    expect(state).toEqual(before);
  });

  it('ignores unknown features through the shared adapter', () => {
    const state = adaptiveLearner.createLearner(3);
    const start = adaptiveLearner.initialTarget(state);
    expect(adaptiveLearner.nudge!({ state, target: start, feature: 'kazoo' })).toBe(start);
  });
});
