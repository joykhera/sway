import { describe, expect, it } from 'vitest';
import { FEATURE_OF_TEXT, FEATURE_IDS, PROMPT_TEXT, PROMPT_VARIANTS } from '../vocabulary';
import { choosePhrasing } from '../targets';
import { createLearner, initialTarget, processVote, evolveNoVote } from './index';
import type { Target } from './types';

const wording = (target: Target) => new Map(target.prompts.map((prompt) => [FEATURE_OF_TEXT.get(prompt.text)!, prompt.text]));

describe('adaptive compatibility with vocabulary phrasings', () => {
  it('uses seeded variants for initial/new features and holds every liked prompt exactly', () => {
    let noncanonicalNewFeatures = 0;
    for (let seed = 0; seed < 24; seed += 1) {
      const state = createLearner(seed);
      const target = initialTarget(state);
      for (const [id, text] of wording(target)) expect(text).toBe(choosePhrasing(id, { salt: seed }));
      const liked = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' });
      expect(liked.target.prompts).toEqual(target.prompts);
      expect(liked.target.features).toEqual(target.features);
      expect(liked.target.phrasingSalt).toBe(seed);
      const next = processVote({ state, audible: target.features, currentTarget: target, vote: 'down' }).target;
      const previousWords = wording(target);
      for (const [id, text] of wording(next)) {
        expect(text).toBe(previousWords.get(id) ?? choosePhrasing(id, { salt: seed }));
        if (!previousWords.has(id) && text !== PROMPT_TEXT[id]) noncanonicalNewFeatures += 1;
      }
    }
    expect(noncanonicalNewFeatures).toBeGreaterThan(0);
  });

  it('restores an outgoing feature wording on a mid-ramp like with an advanced learner seed', () => {
    const state = createLearner(42, 'focus');
    const initial = initialTarget(state);
    const down = processVote({ state, audible: initial.features, currentTarget: initial, vote: 'down' });
    expect(down.state.seed).not.toBe(state.seed);
    const audible = Object.fromEntries(FEATURE_IDS.map((id) => [id, 0.7 * (initial.features[id] ?? 0) + 0.3 * (down.target.features[id] ?? 0)]));
    const held = processVote({ state: down.state, audible, currentTarget: down.target, vote: 'up' }).target;
    const restored = [...wording(initial)].filter(([id]) => !wording(down.target).has(id) && wording(held).has(id));
    expect(restored.length).toBeGreaterThan(0);
    for (const [id, text] of restored) expect(wording(held).get(id)).toBe(text);
    expect(held.phrasingSalt).toBe(42);
  });

  it('keeps learning and recipe selection independent of rendered wording', () => {
    const state = createLearner(73, 'relax');
    const original = initialTarget(state);
    const reworded: Target = {
      ...original,
      prompts: original.prompts.map((prompt) => {
        const id = FEATURE_OF_TEXT.get(prompt.text)!;
        const variants = PROMPT_VARIANTS[id];
        return { ...prompt, text: variants[(variants.indexOf(prompt.text) + 1) % variants.length]! };
      }),
    };
    for (const vote of ['up', 'down'] as const) {
      const a = processVote({ state, audible: original.features, currentTarget: original, vote });
      const b = processVote({ state, audible: reworded.features, currentTarget: reworded, vote });
      expect(a.state).toEqual(b.state);
      expect(a.target.features).toEqual(b.target.features);
      expect(a.target.lastDecision).toEqual(b.target.lastDecision);
      if (vote === 'up') expect(b.target.prompts).toEqual(reworded.prompts);
    }
    const before = structuredClone(state);
    const next = evolveNoVote({ state, target: original, step: 4 });
    expect(state).toEqual(before);
    expect(next.phrasingSalt).toBe(original.phrasingSalt);
    for (const [id, text] of wording(next)) {
      if (wording(original).has(id)) expect(text).toBe(wording(original).get(id));
    }
  });
});
