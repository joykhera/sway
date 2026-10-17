import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MusicIntent } from '../../shared/intent';
import type { Learner } from '../../shared/protocol';
import { FEATURE_IDS, FEATURE_OF_TEXT, PROMPT_TEXT } from '../vocabulary';
import { activeIds, toTarget } from '../targets';
import { adaptiveLearner, isAdaptiveState } from './adapter';
import { applyIntent, createLearner, initialTarget, matchesIntent, nudge, processVote, restoreTarget } from './index';
import { CRAZY_VARIANTS } from './phrasing';
import type { Purpose, Target } from './types';

const request = (patch: Partial<MusicIntent> = {}): MusicIntent => ({
  schemaVersion: 1, summary: 'Jazz without percussion', purposeHint: null,
  requiredFeatures: ['jazz'], excludedFeatures: ['percussion'], featureHints: [],
  contextPrompt: 'soft attacks and warm resonance', avoid: ['vocals'], references: [], ...patch,
});
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

describe('manual steering inside an active request', () => {
  it('blocks conflicting words, permits compatible nudges, and keeps text without touching learned state', () => {
    const intent = freeze(request());
    let state = createLearner(42);
    let target = initialTarget(state, intent);
    ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: 'down', intent }));
    const snapshot = structuredClone(state);
    freeze(state); freeze(target);
    for (const feature of ['ambient', 'percussion'] as const) {
      const blocked = nudge({ state, target, feature, intent });
      expect(blocked.features).toEqual(target.features);
      expect(blocked.prompts).toEqual(target.prompts);
      expect(blocked.lastDecision?.reason).toContain('conflicts with its explicit constraints');
    }
    const stronger = nudge({ state, target, feature: 'jazz', intent });
    expect(stronger.features.jazz).toBeGreaterThan(target.features.jazz!);
    expect(activeIds(stronger.features, 'genre')).toEqual(['jazz']);
    expect(stronger.prompts).toContainEqual({ text: intent.contextPrompt, weight: 0.5 });
    expect(stronger.prompts).toContainEqual({ text: 'Avoid: vocals.', weight: 0.3 });
    const piano = nudge({ state, target, feature: 'piano', intent });
    expect(piano.features.piano).toBeGreaterThan(0);
    expect(matchesIntent(piano.features, intent)).toBe(true);
    expect(piano.phrasingSalt).toBe(target.phrasingSalt);
    expect(state).toEqual(snapshot);
    expect(isAdaptiveState(state)).toBe(true);
  });

  it('keeps every supported nudge within required and excluded groups, including stale incomplete targets', () => {
    const intents = [request(), request({ requiredFeatures: ['piano', 'calm', 'sparse'], excludedFeatures: ['jazz'] }),
      request({ requiredFeatures: [], excludedFeatures: ['ambient', 'piano', 'calm', 'sparse'] })];
    for (const intent of intents) {
      const state = freeze(createLearner(8, 'crazy'));
      const target = initialTarget(state, intent);
      for (const feature of FEATURE_IDS) {
        expect(matchesIntent(nudge({ state, target, feature, intent }).features, intent)).toBe(true);
        const stale = { features: { ambient: 0.5 }, prompts: [{ text: 'old request', weight: 1 }] };
        const repaired = nudge({ state, target: stale, feature, intent });
        expect(matchesIntent(repaired.features, intent)).toBe(true);
        expect(repaired.prompts.some(prompt => prompt.text === 'old request')).toBe(false);
      }
    }
  });

  it('keeps Crazy neutral during a request and retains valid current context after a nudge', () => {
    const state = freeze(createLearner(42, 'crazy'));
    const intent = request({ requiredFeatures: [], excludedFeatures: [], contextPrompt: 'slow unfolding phrases' });
    const target = initialTarget(state, intent);
    const crazy = new Set(Object.values(CRAZY_VARIANTS).flat());
    for (const feature of ['energetic', 'rhythmic', 'synth'] as const) {
      const next = nudge({ state, target, feature, intent });
      expect(next.intentRendering).toBe(true);
      expect(next.prompts.some(prompt => crazy.has(prompt.text))).toBe(false);
      expect(next.prompts).toContainEqual({ text: intent.contextPrompt, weight: 0.5 });
    }
    expect(state.purpose).toBe('crazy');
  });

  it('holds the current constrained target for conflicting recalls and repairs a stale current destination', () => {
    const state = freeze(createLearner(17));
    const intent = freeze(request());
    const currentTarget = freeze(initialTarget(state, intent));
    const moment = freeze(toTarget({ ambient: 0.5, percussion: 0.4, calm: 0.3, sparse: 0.2 }));
    const held = restoreTarget({ state, currentTarget, moment, intent });
    expect(held.features).toEqual(currentTarget.features);
    expect(held.prompts).toEqual(currentTarget.prompts);
    expect(held.lastDecision?.reason).toContain('saved moment conflicts');
    const repaired = restoreTarget({ state, currentTarget: moment, moment, intent });
    expect(matchesIntent(repaired.features, intent)).toBe(true);
    expect(repaired.prompts).toContainEqual({ text: intent.contextPrompt, weight: 0.5 });
    expect(state).toEqual(createLearner(17));
  });

  it('recalls compatible features and wording with only the current request text, even after clearing', () => {
    const state = freeze(createLearner(3));
    const intent = request();
    const currentTarget = freeze(initialTarget(state, intent));
    const known = toTarget({ jazz: 0.6, guitar: 0.5, hopeful: 0.25, layered: 0.2 }, {}, { salt: 55 });
    const moment = freeze({ ...known, prompts: [...known.prompts, { text: 'old cinematic request', weight: 0.5 },
      { text: 'Avoid: warm resonance.', weight: 0.3 }] });
    const recalled = restoreTarget({ state, currentTarget, moment, intent });
    expect(recalled.features).toEqual(known.features);
    expect(recalled.prompts.filter(prompt => FEATURE_OF_TEXT.has(prompt.text))).toEqual(known.prompts);
    expect(recalled.prompts).toContainEqual({ text: intent.contextPrompt, weight: 0.5 });
    expect(recalled.prompts).toContainEqual({ text: 'Avoid: vocals.', weight: 0.3 });
    expect(recalled.prompts.some(prompt => /old cinematic|Avoid: warm/.test(prompt.text))).toBe(false);
    const cleared = applyIntent({ state, currentTarget });
    const withoutRequest = restoreTarget({ state, currentTarget: cleared, moment });
    expect(withoutRequest.features).toEqual(known.features);
    expect(withoutRequest.prompts).toEqual(known.prompts);
    expect(withoutRequest.intentRendering).toBeUndefined();
    expect(state).toEqual(createLearner(3));
  });

  it('rejects invalid requests and forwards valid requests through the shared adapter', () => {
    const learner: Learner = adaptiveLearner;
    const state = freeze(learner.createLearner(21));
    const intent = request();
    const target = freeze(learner.initialTarget(state, intent));
    const nudged = learner.nudge!({ state, target, feature: 'percussion', intent });
    expect(nudged.features).toEqual(target.features);
    const moment = toTarget({ jazz: 0.6, piano: 0.5, dreamy: 0.4, sparse: 0.3 });
    const recalled = learner.restoreTarget!({ state, currentTarget: target, moment, intent });
    expect(matchesIntent(recalled.features, intent)).toBe(true);
    expect(recalled.prompts).toContainEqual({ text: intent.contextPrompt, weight: 0.5 });
    expect(recalled).toHaveProperty('phrasingSalt', 21);
    expect(isAdaptiveState(state)).toBe(true);
    const bad = request({ requiredFeatures: ['jazz', 'ambient'] });
    expect(() => learner.nudge!({ state, target, feature: 'jazz', intent: bad })).toThrow(/infeasible/);
    expect(() => learner.restoreTarget!({ state, currentTarget: target, moment, intent: bad })).toThrow(/infeasible/);
  });

  it('preserves exact no-request mid-ramp mixtures and Crazy wording while dropping stale descriptions', () => {
    const state = freeze(createLearner(42, 'crazy'));
    const currentTarget = freeze(initialTarget(state, request()));
    const features = {
      ambient: 0.3, jazz: 0.09, electronic: 0.22,
      piano: 0.24, guitar: 0.18, percussion: 0.12,
      calm: 0.19, energetic: 0.15, sparse: 0.21, rhythmic: 0.2,
    };
    const prompts = Object.entries(features).map(([id, weight]) => ({
      text: CRAZY_VARIANTS[id as keyof typeof CRAZY_VARIANTS]?.[0] ?? PROMPT_TEXT[id as keyof typeof PROMPT_TEXT],
      weight: weight * 2,
    }));
    const moment = freeze({ features, prompts: [...prompts, { text: 'old cinematic request', weight: 0.5 }] });
    const recalled = restoreTarget({ state, currentTarget, moment });
    expect(recalled.features).toEqual(features);
    expect(recalled.prompts).toEqual(prompts);
    expect(recalled.features).not.toBe(moment.features);
    expect(recalled.prompts[0]).not.toBe(moment.prompts[0]);
    expect(recalled.intentRendering).toBeUndefined();
    expect(recalled.lastDecision).toEqual(currentTarget.lastDecision);
    expect(recalled.phrasingSalt).toBe(currentTarget.phrasingSalt);
    expect(state).toEqual(createLearner(42, 'crazy'));
  });

  it('preserves the exact current-main no-intent nudge trace', () => {
    const trace: unknown[] = [];
    for (const purpose of ['focus', 'relax', 'energy', 'explore', 'crazy'] as Purpose[]) {
      for (const seed of [0, 42, 97]) {
        const state = createLearner(seed, purpose);
        let target: Target = initialTarget(state);
        for (const feature of [...FEATURE_IDS, ...FEATURE_IDS]) {
          target = nudge({ state, target, feature });
          trace.push({ state, target });
        }
      }
    }
    expect(createHash('sha256').update(JSON.stringify(trace)).digest('hex'))
      .toBe('0639b41d0b765b70e0840363ed864dae4a3106ed24339ce60b8f1e39f32357b6');
  });
});
