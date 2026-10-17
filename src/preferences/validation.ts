import type { ListeningPurpose } from '../shared/protocol';
import type { FeedbackRecord, SavedProfile } from './types';

export const SCHEMA_VERSION = 1;
export const PURPOSES = ['focus', 'relax', 'energy', 'explore', 'crazy'] as const satisfies readonly ListeningPurpose[];
export const PROFILE_MAX_BYTES = 256 * 1024;
export const FEEDBACK_MAX_BYTES = 32 * 1024;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value: unknown): value is number => finite(value) && value >= 0;

export const isPurpose = (value: unknown): value is ListeningPurpose =>
  typeof value === 'string' && PURPOSES.some(purpose => purpose === value);

/** Bounded, detached JSON snapshot. Opaque model extensions survive without being interpreted. */
function snapshot(value: unknown, maxBytes: number): unknown {
  let budget = maxBytes;
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 16_384 || depth > 16 || budget < 0) throw new TypeError('Preference record exceeds limits');
    if (item === null || typeof item === 'boolean') { budget -= 5; return item; }
    if (finite(item)) { budget -= 24; return item; }
    if (typeof item === 'string') { budget -= item.length * 3 + 2; return item; }
    if (typeof item !== 'object' || item === null || (!Array.isArray(item) && !record(item))) {
      throw new TypeError('Preference records must contain finite JSON data');
    }
    if (ancestors.has(item)) throw new TypeError('Preference records cannot contain cycles');
    const keys = Object.keys(item);
    if (keys.length > (Array.isArray(item) ? 1024 : 256) || (Array.isArray(item) && item.length > 1024)) {
      throw new TypeError('Preference record exceeds limits');
    }
    if (Array.isArray(item) && (keys.length !== item.length || keys.some((key, i) => key !== String(i)))) {
      throw new TypeError('Preference records cannot contain sparse or extended arrays');
    }
    ancestors.add(item);
    budget -= 2;
    const copy: unknown[] | JsonRecord = Array.isArray(item) ? [] : Object.create(null) as JsonRecord;
    for (const key of keys) {
      budget -= key.length * 3 + 4;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) throw new TypeError('Preference records cannot contain accessors');
      const value = visit(descriptor.value, depth + 1);
      if (Array.isArray(copy)) copy.push(value);
      else copy[key] = value;
    }
    ancestors.delete(item);
    return copy;
  };
  const copy = visit(value, 0);
  if (budget < 0) throw new TypeError('Preference record exceeds limits');
  const json = JSON.stringify(copy);
  if (new TextEncoder().encode(json).byteLength > maxBytes) throw new TypeError('Preference record exceeds limits');
  return JSON.parse(json) as unknown;
}

function numericMap(value: unknown, nonnegative: boolean): boolean {
  return record(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, weight]) =>
    key.length > 0 && key.length <= 128 && finite(weight) && (!nonnegative || weight >= 0));
}

function target(value: unknown): boolean {
  return record(value) && numericMap(value.features, true) && Array.isArray(value.prompts)
    && value.prompts.length > 0 && value.prompts.length <= 64
    && value.prompts.every(prompt => record(prompt) && typeof prompt.text === 'string'
      && prompt.text.length > 0 && prompt.text.length <= 2048 && finite(prompt.weight) && prompt.weight > 0);
}

export function snapshotProfile(value: unknown): SavedProfile {
  const copy = snapshot(value, PROFILE_MAX_BYTES);
  if (!record(copy) || !isPurpose(copy.purpose) || !timestamp(copy.updatedAt) || !record(copy.state)
    || !numericMap(copy.state.scores, false) || !Number.isSafeInteger(copy.state.votes)
    || (copy.state.votes as number) < 0 || !Number.isSafeInteger(copy.state.seed)
    || (copy.state.seed as number) < 0 || (copy.state.seed as number) > 0xffff_ffff
    || ('purpose' in copy.state && copy.state.purpose !== copy.purpose)) {
    throw new TypeError('Invalid saved preference profile');
  }
  return copy as SavedProfile;
}

export function snapshotFeedback(value: unknown): FeedbackRecord {
  const copy = snapshot(value, FEEDBACK_MAX_BYTES);
  if (!record(copy) || !isPurpose(copy.purpose) || !timestamp(copy.at)
    || !['id', 'sessionId'].every(key => typeof copy[key] === 'string' && copy[key].length > 0 && copy[key].length <= 128)
    || (copy.vote !== 'up' && copy.vote !== 'down') || !numericMap(copy.audible, true)
    || ('previous' in copy && !numericMap(copy.previous, true))
    || !finite(copy.evidenceWeight) || copy.evidenceWeight < 0 || copy.evidenceWeight > 1
    || !target(copy.targetBefore) || !target(copy.targetAfter)) {
    throw new TypeError('Invalid saved feedback record');
  }
  return copy as FeedbackRecord;
}

export function readProfile(value: unknown): SavedProfile | undefined {
  try {
    if (!record(value) || value.schemaVersion !== SCHEMA_VERSION) return undefined;
    const { schemaVersion: _, ...profile } = value;
    return snapshotProfile(profile);
  } catch { return undefined; }
}

export function readFeedback(value: unknown): FeedbackRecord | undefined {
  try {
    if (!record(value) || value.schemaVersion !== SCHEMA_VERSION) return undefined;
    const { schemaVersion: _, ...feedback } = value;
    return snapshotFeedback(feedback);
  } catch { return undefined; }
}

export function readPurpose(value: unknown): ListeningPurpose | undefined {
  return record(value) && value.schemaVersion === SCHEMA_VERSION && value.key === 'purpose'
    && isPurpose(value.purpose) ? value.purpose : undefined;
}
