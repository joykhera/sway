import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MusicIntent } from '../../shared/intent';
import type { Learner } from '../../shared/protocol';
import { validateClientMessage } from '../../../server/guard';
import { activeIds, signature } from '../targets';
import { FEATURE_GROUPS } from '../vocabulary';
import { adaptiveLearner, isAdaptiveState } from './adapter';
import { applyIntent, createLearner, evolveNoVote, initialTarget, processVote } from './index';
import { intentPrior, matchesIntent } from './intent';
import { RECIPES } from './recipes';
import type { LearnerState, Purpose, Target } from './types';

const intent = (patch: Partial<MusicIntent> = {}): MusicIntent => ({
  schemaVersion: 1, summary: 'Jazz for reading', purposeHint: null,
  requiredFeatures: ['jazz'], excludedFeatures: ['percussion'], featureHints: [],
  contextPrompt: 'Instrumental background music for quiet reading', avoid: ['vocals'], references: [], ...patch,
});
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

describe('session intent, separate from preference evidence', () => {
  it('keeps hard requirements/exclusions across dislikes, style escape and freshness', () => {
    const request = freeze(intent());
    for (let seed = 0; seed < 12; seed++) {
      let state = createLearner(seed);
      let target = initialTarget(state, request);
      let escapes = 0;
      for (let step = 1; step <= 8; step++) {
        expect(activeIds(target.features, 'genre')).toEqual(['jazz']);
        expect(target.features.percussion).toBeUndefined();
        const pending = target;
        ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: 'down', intent: request }));
        expect(matchesIntent(target.features, request)).toBe(true);
        if (target.lastDecision?.styleEscape) {
          escapes++;
          expect(activeIds(target.features, 'instrument')).not.toEqual(activeIds(pending.features, 'instrument'));
          expect(activeIds(target.features, 'mood')).not.toEqual(activeIds(pending.features, 'mood'));
          expect(target.lastDecision.reason).toContain('inside the active request');
        }
        const before = structuredClone(state);
        target = evolveNoVote({ state: freeze(state), target, step, intent: request });
        expect(state).toEqual(before);
        expect(matchesIntent(target.features, request)).toBe(true);
        expect(target.prompts).toContainEqual({ text: request.contextPrompt, weight: 0.5 });
        expect(target.prompts).toContainEqual({ text: 'Avoid: vocals.', weight: 0.3 });
      }
      expect(state.rejectedBlends).toHaveLength(3);
      expect(escapes).toBeGreaterThan(0);
    }
  });

  it('holds compatible liked text/weights exactly and cannot resurrect a forbidden mid-ramp genre', () => {
    const state = createLearner(42);
    const request = intent();
    const target = initialTarget(state, request);
    const held = processVote({ state, audible: target.features, currentTarget: target, vote: 'up', intent: request });
    expect(held.target.features).toEqual(target.features);
    expect(held.target.prompts).toEqual(target.prompts);
    const audible = { ...target.features, ambient: 0.3 };
    const mid = processVote({ state, audible, currentTarget: target, vote: 'up', intent: request });
    expect(mid.target.features).toEqual(target.features);
    expect(mid.target.prompts).toEqual(target.prompts);
    expect(mid.target.lastDecision?.reason).toContain('outside its constraints');
    // Feedback still concerns the complete heard blend, even its outgoing parts.
    const ordinary = processVote({ state, audible, currentTarget: target, vote: 'up' });
    expect(mid.state.A).toEqual(ordinary.state.A);
    expect(mid.state.b).toEqual(ordinary.state.b);
    expect(mid.state.scores.ambient).toBeGreaterThan(0);
  });

  it('enforces the request when both the heard mixture and stale destination are incompatible', () => {
    const state = createLearner(17);
    const currentTarget = RECIPES.find(({ target }) => target.features.ambient && target.features.percussion)!.target;
    const result = processVote({ state, audible: currentTarget.features, currentTarget, vote: 'up', intent: intent() });
    expect(matchesIntent(result.target.features, intent())).toBe(true);
    expect(result.state.votes).toBe(1);
  });

  it('holds the sole feasible recipe and uses a pending feasible recipe when identities exhaust the catalog', () => {
    const single = intent({ requiredFeatures: ['jazz', 'piano', 'calm', 'sparse'], excludedFeatures: [] });
    let state = createLearner(4);
    let target = initialTarget(state, single);
    for (let i = 0; i < 4; i++) {
      ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: 'down', intent: single }));
      expect(matchesIntent(target.features, single)).toBe(true);
      expect(target.lastDecision?.reason).toContain('only one recipe');
      target = evolveNoVote({ state, target, intent: single });
      expect(matchesIntent(target.features, single)).toBe(true);
    }
    const two = intent({ requiredFeatures: ['jazz', 'piano', 'calm'], excludedFeatures: ['layered'] });
    const heard = initialTarget(state, two);
    const pending = evolveNoVote({ state, target: heard, intent: two });
    expect(signature(pending.features)).not.toBe(signature(heard.features));
    const next = processVote({ state, audible: heard.features, currentTarget: pending, vote: 'down', intent: two });
    expect(next.target.features).toEqual(pending.features);
  });

  it('rejects infeasible or malformed requests at all public boundaries without altering state', () => {
    const state = freeze(createLearner(8));
    const target = freeze(initialTarget(state));
    for (const bad of [intent({ requiredFeatures: ['jazz', 'ambient'] }), intent({ excludedFeatures: [...FEATURE_GROUPS.genre] }),
      intent({ excludedFeatures: ['jazz'] }), { ...intent(), schemaVersion: 2 } as unknown as MusicIntent]) {
      expect(() => initialTarget(state, bad)).toThrow(/infeasible/);
      expect(() => applyIntent({ state, currentTarget: target, intent: bad })).toThrow(/infeasible/);
      expect(() => processVote({ state, audible: target.features, currentTarget: target, vote: 'up', intent: bad })).toThrow(/infeasible/);
      expect(() => evolveNoVote({ state, target, intent: bad })).toThrow(/infeasible/);
    }
    expect(state).toEqual(createLearner(8));
  });

  it('applies/clears context using latest saved evidence with no model, profile, policy or RNG changes', () => {
    let state = createLearner(31, 'focus');
    let target = initialTarget(state);
    ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' }));
    const saved = structuredClone(state);
    freeze(state); freeze(target);
    const request = intent({ purposeHint: 'energy' });
    const applied = applyIntent({ state, currentTarget: target, intent: request });
    expect(applied).toEqual(applyIntent({ state, currentTarget: target, intent: request }));
    expect(matchesIntent(applied.features, request)).toBe(true);
    expect(applied.lastDecision?.kind).toBe('intent');
    const cleared = applyIntent({ state, currentTarget: applied });
    expect(cleared.prompts.some(p => p.text === request.contextPrompt || p.text.startsWith('Avoid:'))).toBe(false);
    expect(cleared.lastDecision?.reason).toContain('Clearing');
    expect(state).toEqual(saved);
    expect(state.purpose).toBe('focus');
    expect(isAdaptiveState(state)).toBe(true);
  });

  it('gives hints bounded initial influence and lets learned rejection overcome them', () => {
    const request = intent({ requiredFeatures: [], excludedFeatures: [], featureHints: ['piano'], contextPrompt: '', avoid: [] });
    let state = createLearner(42);
    expect(initialTarget(state, request).features.piano).toBeGreaterThan(0);
    const allPiano = RECIPES.filter(({ target }) => target.features.piano);
    const allGuitar = RECIPES.filter(({ target }) => target.features.guitar);
    let current = initialTarget(state, request);
    for (let i = 0; i < 30; i++) {
      for (const [recipes, vote] of [[allPiano, 'down'], [allGuitar, 'up']] as const) {
        const heard = recipes[(i * 7) % recipes.length]!.target;
        ({ state, target: current } = processVote({ state, audible: heard.features, currentTarget: current, vote, intent: request }));
      }
    }
    const selected = applyIntent({ state, currentTarget: current, intent: request });
    expect(selected.features.piano).toBeUndefined();
    expect(selected.features.guitar).toBeGreaterThan(0);
    for (const { target } of RECIPES) {
      const before = intentPrior(createLearner(42), target, request);
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThanOrEqual(0.22);
      expect(intentPrior(state, target, request)).toBeLessThanOrEqual(before);
    }
    const energy = initialTarget(createLearner(42), intent({ requiredFeatures: [], excludedFeatures: [], purposeHint: 'energy' }));
    expect(energy.features.energetic).toBeGreaterThan(0);
    expect(energy.features.rhythmic).toBeGreaterThan(0);
  });

  it('keeps maximal descriptive overlays relay-valid and stable without inventing learned dimensions', () => {
    const request = intent({ requiredFeatures: [], excludedFeatures: [], contextPrompt: 'x'.repeat(200),
      avoid: Array.from({ length: 6 }, (_, i) => String(i) + 'a'.repeat(79)) });
    const state = createLearner(19);
    const current = initialTarget(state, request);
    const audible = { jazz: 0.2, ambient: 0.2, piano: 0.2, guitar: 0.2, calm: 0.3, sparse: 0.25 };
    const held = processVote({ state, audible, currentTarget: current, vote: 'up', intent: request });
    expect(held.target.prompts).toHaveLength(10);
    expect(validateClientMessage({ type: 'start', prompts: held.target.prompts }).ok).toBe(true);
    const heldAgain = processVote({ state: held.state, audible: held.target.features, currentTarget: held.target, vote: 'up', intent: request });
    expect(heldAgain.target.prompts).toEqual(held.target.prompts);
    const plain = processVote({ state, audible, currentTarget: current, vote: 'up' });
    expect(held.state).toEqual(plain.state);
    expect(Object.keys(held.state.scores)).toHaveLength(18);
  });

  it('forwards intent through the shared adapter while preserving complete state and target metadata', () => {
    const learner: Learner = adaptiveLearner;
    const state = learner.createLearner(42, 'relax');
    const request = intent();
    const target = learner.initialTarget(state, request);
    const applied = learner.applyIntent!({ state, currentTarget: target, intent: request });
    expect(applied).toEqual(applyIntent({ state: state as LearnerState, currentTarget: target, intent: request }));
    const result = learner.processVote({ state, audible: target.features, currentTarget: target, vote: 'down', evidenceWeight: 0, intent: request });
    expect(isAdaptiveState(result.state)).toBe(true);
    expect(result.target).toHaveProperty('phrasingSalt', 42);
    expect(result.target).toHaveProperty('lastDecision.kind', 'redirect');
    expect(matchesIntent(result.target.features, request)).toBe(true);
    const variation = learner.evolveNoVote({ state: result.state, target: result.target, intent: request, step: 7 });
    expect(matchesIntent(variation.features, request)).toBe(true);
    expect(variation).toHaveProperty('lastDecision.step', 7);
  });

  it('preserves the exact pre-intent trace when no intent is supplied', () => {
    const trace: Array<{ state: LearnerState; target: Target }> = [];
    for (const purpose of ['focus', 'relax', 'energy', 'explore', 'crazy'] as Purpose[]) {
      for (const seed of [0, 42, 97]) {
        let state = createLearner(seed, purpose);
        let target = initialTarget(state);
        trace.push({ state, target });
        for (let i = 0; i < 12; i++) {
          const previous = target.features;
          ({ state, target } = processVote({ state, audible: target.features, currentTarget: target,
            vote: i % 3 === 0 ? 'down' : 'up', evidenceWeight: i % 4 === 0 ? 0 : 0.7,
            comparison: i % 2 ? { previous } : undefined }));
          if (i % 2 === 0) target = evolveNoVote({ state, target, step: i + 1 });
          trace.push({ state, target });
        }
      }
    }
    expect(createHash('sha256').update(JSON.stringify(trace)).digest('hex')).toBe('f703af3c50a5f40750ce93b56b52dbb282527de05b6f856e1d249d4a1f474ca4');
  });
});
