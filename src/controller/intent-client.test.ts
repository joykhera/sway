import { afterEach, expect, it, vi } from 'vitest';
import { interpretMusicIntent } from './intent-client.ts';
import { snapshotProfile, snapshotFeedback } from '../preferences/validation.ts';
import type { MusicIntent } from '../shared/intent.ts';

const intent: MusicIntent = { schemaVersion: 1, summary: 'Jazz', purposeHint: null, requiredFeatures: ['jazz'],
  excludedFeatures: [], featureHints: [], contextPrompt: '', avoid: [], references: [] };
const request = { text: 'jazz', purpose: 'focus' as const, currentFeatures: { jazz: 1 } };
afterEach(() => vi.unstubAllGlobals());

it('uses a same-origin JSON request and validates the response', async () => {
  const fetch = vi.fn(async () => Response.json({ status: 'ready', intent })); vi.stubGlobal('fetch', fetch);
  expect(await interpretMusicIntent(request, new AbortController().signal)).toEqual({ status: 'ready', intent });
  expect(fetch).toHaveBeenCalledWith('/api/intent', expect.objectContaining({ method: 'POST', credentials: 'same-origin',
    body: JSON.stringify(request), headers: { 'Content-Type': 'application/json' } }));
});

it.each([
  () => new Response('proxy broke', { status: 502 }),
  () => Response.json({ status: 'ready', intent: { ...intent, requiredFeatures: ['alien'] } }),
  () => Response.json({ status: 'ready', intent }, { status: 500 }),
  () => new Response(' '.repeat(16_385)),
])('rejects malformed, failed or oversized successful responses', async response => {
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  await expect(interpretMusicIntent(request, new AbortController().signal)).rejects.toThrow();
});

it('accepts a bounded friendly server error without treating it as a new brief', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'error', message: 'Try again later.' }, { status: 503 })));
  expect(await interpretMusicIntent(request, new AbortController().signal)).toEqual({ status: 'error', message: 'Try again later.' });
});

it('detaches and validates optional persisted brief and feedback attribution', () => {
  const profile = { purpose: 'focus', state: { scores: {}, votes: 0, seed: 3 }, updatedAt: 1, intent, intentText: 'jazz' };
  const saved = snapshotProfile(profile); expect(saved.intent).toEqual(intent); expect(saved.intent).not.toBe(intent);
  expect(() => snapshotProfile({ ...profile, intent: { ...intent, excludedFeatures: ['jazz'] } })).toThrow();
  const target = { features: { jazz: 1 }, prompts: [{ text: 'Jazz', weight: 1 }] };
  const feedback = { id: 's:1', sessionId: 's', at: 2, purpose: 'focus', vote: 'up', audible: { jazz: 1 },
    evidenceWeight: 0, targetBefore: target, targetAfter: target, intent, intentText: 'jazz', intentAppliedToAudible: false };
  expect(snapshotFeedback(feedback).intentAppliedToAudible).toBe(false);
  expect(() => snapshotFeedback({ ...feedback, intentAppliedToAudible: 'yes' })).toThrow();
  expect(() => snapshotProfile({ ...profile, intentText: 'a'.repeat(1201) })).toThrow();
});
