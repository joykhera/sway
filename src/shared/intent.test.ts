import { describe, expect, it } from 'vitest';
import { RECIPES } from '../learner/adaptive/recipes.ts';
import { FEATURE_IDS } from '../learner/vocabulary.ts';
import { intentConstraintsFeasible, parseInterpretRequest, parseInterpretResponse, parseMusicIntent, type MusicIntent } from './intent.ts';

const intent = (): MusicIntent => ({ schemaVersion: 1, summary: 'Quiet music for reading', purposeHint: 'focus',
  requiredFeatures: ['piano'], excludedFeatures: ['percussion'], featureHints: ['calm'], contextPrompt: 'gentle rain in the distance', avoid: [], references: [] });
describe('music intent boundary', () => {
  it('returns a detached, versioned intent and rejects unknown fields/enums/invalid references', () => {
    const original = intent();
    const parsed = parseMusicIntent(original)!;
    original.featureHints.push('dreamy');
    expect(parsed.featureHints).toEqual(['calm']);
    for (const patch of [{ schemaVersion: 2 }, { purposeHint: 'workout' }, { extra: true }, { featureHints: ['metal'] },
      { references: [{ id: 'x', title: 'Track', url: 'javascript:alert(1)' }] },
      { references: [{ id: 'x', title: 'Track', url: 'https://user:pass@example.com/' }] }, { contextPrompt: 'x'.repeat(201) }]) {
      expect(parseMusicIntent({ ...intent(), ...patch })).toBeNull();
    }
  });
  it('rejects impossible constraints without silently relaxing a user request', () => {
    expect(parseMusicIntent({ ...intent(), requiredFeatures: ['piano', 'guitar'] })).toBeNull();
    expect(parseMusicIntent({ ...intent(), requiredFeatures: ['percussion'] })).toBeNull();
    expect(parseMusicIntent({ ...intent(), excludedFeatures: ['sparse', 'layered', 'rhythmic'] })).toBeNull();
    expect(parseMusicIntent({ ...intent(), featureHints: ['percussion'] })).toBeNull();
  });
  it('matches actual recipe feasibility across every required pair and excluded group', () => {
    const sets = [[], ['sparse', 'layered', 'rhythmic'], ['piano', 'synth', 'guitar', 'strings', 'percussion']] as const;
    for (const a of FEATURE_IDS) for (const b of FEATURE_IDS) for (const excluded of sets) {
      const required = [...new Set([a, b])];
      const actual = RECIPES.some(({ target }) => required.every(id => (target.features[id] ?? 0) > 0)
        && excluded.every(id => !(target.features[id] ?? 0)));
      expect(intentConstraintsFeasible(required, excluded)).toBe(actual);
    }
  });
  it('bounds requests and exposes only public ready/clarify/unsupported/error results', () => {
    const request = { text: '  piano for reading  ', purpose: 'focus', currentFeatures: { piano: .4 }, currentIntent: intent() };
    expect(parseInterpretRequest(request)?.text).toBe('piano for reading');
    expect(parseInterpretRequest({ ...request, endpoint: 'https://evil.test' })).toBeNull();
    expect(parseInterpretRequest({ ...request, currentFeatures: { piano: Infinity } })).toBeNull();
    expect(parseInterpretRequest({ ...request, preferences: { liked: ['piano'], disliked: ['piano'] } })).toBeNull();
    expect(parseInterpretResponse({ status: 'ready', intent: intent() })?.status).toBe('ready');
    expect(parseInterpretResponse({ status: 'clarify', message: 'Which song?' })).toEqual({ status: 'clarify', message: 'Which song?' });
    expect(parseInterpretResponse({ status: 'needs_lookup', query: 'song' })).toBeNull();
  });
});
