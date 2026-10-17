import { FEATURE_GROUPS, FEATURE_IDS, GROUP_IDS, type FeatureId } from '../learner/vocabulary.ts';
import type { FeatureBlend, ListeningPurpose } from './protocol.ts';

export type { FeatureId };
export const INTENT_PATH = '/api/intent';
export const INTENT_LIMITS = Object.freeze({ text: 1200, summary: 180, contextPrompt: 200, avoid: 6, avoidText: 80,
  references: 3, referenceId: 40, referenceTitle: 160, referenceUrl: 512, hints: 8, message: 300 });
export type IntentReference = { id: string; title: string; url: string };
export type MusicIntent = {
  schemaVersion: 1;
  summary: string;
  purposeHint: ListeningPurpose | null;
  requiredFeatures: FeatureId[];
  excludedFeatures: FeatureId[];
  featureHints: FeatureId[];
  contextPrompt: string;
  avoid: string[];
  references: IntentReference[];
};
export type InterpretRequest = {
  text: string;
  purpose: ListeningPurpose;
  currentFeatures: FeatureBlend;
  currentIntent?: MusicIntent;
  preferences?: { liked: FeatureId[]; disliked: FeatureId[] };
};
export type InterpretResponse = { status: 'ready'; intent: MusicIntent }
  | { status: 'clarify' | 'unsupported' | 'error'; message: string };

const purposes: readonly ListeningPurpose[] = ['focus', 'relax', 'energy', 'explore', 'crazy'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string'
  && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const purpose = (value: unknown): value is ListeningPurpose => purposes.includes(value as ListeningPurpose);
const features = (value: unknown, maximum = FEATURE_IDS.length): value is FeatureId[] => Array.isArray(value)
  && value.length <= maximum && Object.keys(value).length === value.length && new Set(value).size === value.length
  && value.every(id => FEATURE_IDS.includes(id));

/** The current recipe catalog is the Cartesian product of one ID per group (375 recipes). */
export function intentConstraintsFeasible(required: readonly FeatureId[], excluded: readonly FeatureId[]): boolean {
  return !required.some(id => excluded.includes(id)) && GROUP_IDS.every(group => {
    const ids: readonly FeatureId[] = FEATURE_GROUPS[group];
    return required.filter(id => ids.includes(id)).length <= 1 && ids.some(id => !excluded.includes(id));
  });
}

export function parseMusicIntent(value: unknown): MusicIntent | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'summary', 'purposeHint', 'requiredFeatures', 'excludedFeatures',
    'featureHints', 'contextPrompt', 'avoid', 'references']) || value.schemaVersion !== 1
    || !text(value.summary, INTENT_LIMITS.summary) || (value.purposeHint !== null && !purpose(value.purposeHint))
    || !features(value.requiredFeatures, GROUP_IDS.length) || !features(value.excludedFeatures)
    || !features(value.featureHints, INTENT_LIMITS.hints) || !text(value.contextPrompt, INTENT_LIMITS.contextPrompt, true)
    || !Array.isArray(value.avoid) || value.avoid.length > INTENT_LIMITS.avoid || Object.keys(value.avoid).length !== value.avoid.length
    || !value.avoid.every(item => text(item, INTENT_LIMITS.avoidText)) || new Set(value.avoid).size !== value.avoid.length
    || !Array.isArray(value.references) || value.references.length > INTENT_LIMITS.references
    || !intentConstraintsFeasible(value.requiredFeatures, value.excludedFeatures)
    || value.featureHints.some(id => (value.excludedFeatures as FeatureId[]).includes(id))) return null;
  const references: IntentReference[] = [];
  for (const reference of value.references) {
    if (!record(reference) || !keys(reference, ['id', 'title', 'url'])
      || !text(reference.id, INTENT_LIMITS.referenceId) || !/^[a-zA-Z0-9:_-]+$/.test(reference.id)
      || !text(reference.title, INTENT_LIMITS.referenceTitle) || !text(reference.url, INTENT_LIMITS.referenceUrl)) return null;
    try {
      const url = new URL(reference.url);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    } catch { return null; }
    if (references.some(item => item.id === reference.id)) return null;
    references.push({ id: reference.id, title: reference.title, url: reference.url });
  }
  return { schemaVersion: 1, summary: value.summary, purposeHint: value.purposeHint as ListeningPurpose | null,
    requiredFeatures: [...value.requiredFeatures], excludedFeatures: [...value.excludedFeatures], featureHints: [...value.featureHints],
    contextPrompt: value.contextPrompt, avoid: [...value.avoid], references };
}

export function parseInterpretRequest(value: unknown): InterpretRequest | null {
  if (!record(value) || !keys(value, ['text', 'purpose', 'currentFeatures'], ['currentIntent', 'preferences'])
    || !text(value.text, INTENT_LIMITS.text) || !purpose(value.purpose) || !record(value.currentFeatures)
    || Object.keys(value.currentFeatures).length > FEATURE_IDS.length
    || Object.entries(value.currentFeatures).some(([id, weight]) => !FEATURE_IDS.includes(id as FeatureId)
      || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1)) return null;
  const currentIntent = value.currentIntent === undefined ? undefined : parseMusicIntent(value.currentIntent);
  if (currentIntent === null) return null;
  let preferences: InterpretRequest['preferences'];
  if (value.preferences !== undefined) {
    if (!record(value.preferences) || !keys(value.preferences, ['liked', 'disliked'])
      || !features(value.preferences.liked, INTENT_LIMITS.hints) || !features(value.preferences.disliked, INTENT_LIMITS.hints)
      || value.preferences.liked.some(id => (value.preferences as { disliked: FeatureId[] }).disliked.includes(id))) return null;
    preferences = { liked: [...value.preferences.liked], disliked: [...value.preferences.disliked] };
  }
  return { text: value.text.trim(), purpose: value.purpose, currentFeatures: { ...value.currentFeatures } as FeatureBlend,
    ...(currentIntent ? { currentIntent } : {}), ...(preferences ? { preferences } : {}) };
}

export function parseInterpretResponse(value: unknown): InterpretResponse | null {
  if (!record(value)) return null;
  if (value.status === 'ready' && keys(value, ['status', 'intent'])) {
    const intent = parseMusicIntent(value.intent);
    return intent ? { status: 'ready', intent } : null;
  }
  if (['clarify', 'unsupported', 'error'].includes(value.status as string) && keys(value, ['status', 'message'])
    && text(value.message, INTENT_LIMITS.message)) return { status: value.status as 'clarify' | 'unsupported' | 'error', message: value.message };
  return null;
}
