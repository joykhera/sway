import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MusicIntent } from '../../shared/intent';
import { toTarget } from '../targets';
import { applyIntent, createLearner, evolveNoVote, initialTarget, processVote } from './index';
import { matchesIntent } from './intent';
import { isAdaptiveState } from './adapter';
import type { Purpose, Target } from './types';

const request = (patch: Partial<MusicIntent> = {}): MusicIntent => ({
  schemaVersion: 1, summary: 'Music for a workout', purposeHint: 'energy',
  requiredFeatures: [], excludedFeatures: [], featureHints: ['energetic', 'rhythmic'],
  contextPrompt: 'steady momentum', avoid: [], references: [], ...patch,
});
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
function learnedLofi(likes = 30) {
  let state = createLearner(42);
  let target: Target = toTarget({ lofi: 0.45, percussion: 0.4, melancholic: 0.3, sparse: 0.25 });
  for (let i = 0; i < likes; i++) {
    ({ state, target } = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' }));
  }
  return { state, target };
}

describe('fresh requests steer without rewriting taste', () => {
  it.each([4, 30, 80])('steers the learned lofi regression after %i Likes and retains compatible ingredients', likes => {
    const { state, target } = learnedLofi(likes);
    const intent = request();
    const snapshot = structuredClone({ state, target, intent });
    freeze(state); freeze(target); freeze(intent);
    const next = applyIntent({ state, currentTarget: target, intent });
    expect(next.features).toEqual({ lofi: 0.45, percussion: 0.4, energetic: 0.3, rhythmic: 0.25 });
    expect(next.prompts).toContainEqual({ text: 'steady momentum', weight: 0.5 });
    expect(next).toEqual(applyIntent({ state, currentTarget: target, intent }));
    expect({ state, target, intent }).toEqual(snapshot);
    expect(isAdaptiveState(state)).toBe(true);
  });

  it('can change direction repeatedly and clear back to learned taste without generating evidence', () => {
    const { state, target } = learnedLofi();
    const snapshot = structuredClone(state);
    freeze(state);
    const energy = request();
    const quiet = request({ summary: 'A dreamy reading room', purposeHint: 'relax',
      featureHints: ['dreamy', 'sparse'], contextPrompt: 'soft attacks and warm resonance' });
    const first = applyIntent({ state, currentTarget: target, intent: energy });
    const second = applyIntent({ state, currentTarget: first, intent: quiet });
    expect(second.features).toEqual({ lofi: 0.45, percussion: 0.4, dreamy: 0.3, sparse: 0.25 });
    expect(second.prompts.some(p => p.text === energy.contextPrompt)).toBe(false);
    const again = applyIntent({ state, currentTarget: second, intent: energy });
    expect(again.features).toEqual(first.features);
    expect(again.prompts).toEqual(first.prompts);
    const clear = applyIntent({ state, currentTarget: again });
    expect(clear.features).toEqual(target.features);
    expect(clear.prompts.some(p => p.text === energy.contextPrompt || p.text === quiet.contextPrompt)).toBe(false);
    expect(state).toEqual(snapshot);
  });

  it('maximizes feasible hinted groups without overriding hard constraints or inventing an empty catalog', () => {
    const { state, target } = learnedLofi();
    const partial = request({ requiredFeatures: ['jazz', 'calm'], excludedFeatures: ['percussion'],
      featureHints: ['ambient', 'energetic', 'rhythmic', 'piano', 'guitar'] });
    const next = applyIntent({ state, currentTarget: target, intent: partial });
    expect(matchesIntent(next.features, partial)).toBe(true);
    expect(next.features.rhythmic).toBe(0.25);
    expect(Boolean(next.features.piano) || Boolean(next.features.guitar)).toBe(true);
    expect(next.features.ambient).toBeUndefined();
    expect(next.features.energetic).toBeUndefined();
    const blocked = request({ requiredFeatures: ['jazz', 'calm', 'sparse'],
      featureHints: ['ambient', 'energetic', 'rhythmic'] });
    const fallback = applyIntent({ state, currentTarget: target, intent: blocked });
    expect(matchesIntent(fallback.features, blocked)).toBe(true);
    expect(fallback.features).toEqual({ jazz: 0.45, percussion: 0.4, calm: 0.3, sparse: 0.25 });
  });

  it('uses purpose for an unhinted request and leaves a supplemental-only request on learned ingredients', () => {
    const { state, target } = learnedLofi();
    const purpose = applyIntent({ state, currentTarget: target, intent: request({ featureHints: [] }) });
    expect(purpose.features).toEqual({ lofi: 0.45, percussion: 0.4, energetic: 0.3, rhythmic: 0.25 });
    const description = request({ purposeHint: null, featureHints: [], contextPrompt: 'warm resonance' });
    const next = applyIntent({ state, currentTarget: target, intent: description });
    expect(next.features).toEqual(target.features);
    expect(next.prompts).toContainEqual({ text: description.contextPrompt, weight: 0.5 });
  });

  it('honors restored request hints at initial selection, then allows thumbs and freshness to leave them', () => {
    const { state } = learnedLofi();
    const snapshot = structuredClone(state);
    freeze(state);
    const intent = freeze(request());
    const start = initialTarget(state, intent);
    expect(start.features).toEqual({ lofi: 0.45, percussion: 0.4, energetic: 0.3, rhythmic: 0.25 });
    const held = processVote({ state, audible: start.features, currentTarget: start, vote: 'up', evidenceWeight: 0, intent });
    expect(held.target.features).toEqual(start.features);
    const down = processVote({ state, audible: start.features, currentTarget: start, vote: 'down', evidenceWeight: 0, intent });
    expect(down.target.features).not.toEqual(start.features);
    expect(down.target.features.energetic === undefined || down.target.features.rhythmic === undefined).toBe(true);
    const fresh = evolveNoVote({ state, target: start, step: 1, intent });
    expect(fresh.features.energetic === undefined || fresh.features.rhythmic === undefined).toBe(true);
    expect(state).toEqual(snapshot);
    expect(intent.requiredFeatures).toEqual([]);
  });

  it('preserves the exact pre-fix clear/no-request trace', () => {
    const trace: unknown[] = [];
    for (const purpose of ['focus', 'relax', 'energy', 'explore', 'crazy'] as Purpose[]) {
      for (const seed of [0, 42, 97]) {
        let state = createLearner(seed, purpose);
        let target = initialTarget(state);
        for (let i = 0; i < 8; i++) {
          ({ state, target } = processVote({ state, audible: target.features, currentTarget: target,
            vote: i % 3 === 0 ? 'down' : 'up', evidenceWeight: i % 4 === 0 ? 0 : 1 }));
          target = applyIntent({ state, currentTarget: target });
          trace.push({ state, target });
        }
      }
    }
    expect(createHash('sha256').update(JSON.stringify(trace)).digest('hex'))
      .toBe('b71b3a83755f482e634316ce71f5a80e45f2209ec7fe190d617fbfcd76f4c7bf');
  });
});
