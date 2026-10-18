import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../log.ts';
import { createIntentInterpreter } from './service.ts';
import type { Fetch } from './lookup.ts';
import type { IntentEvent } from './telemetry.ts';

const input = { text: 'private-listener-description', purpose: 'focus' as const, currentFeatures: {} };
const intent = { schemaVersion: 1, summary: 'private-summary', purposeHint: null, requiredFeatures: [], excludedFeatures: [],
  featureHints: ['ambient'], contextPrompt: 'private-supplement', avoid: [], references: [] };
const ready = (references: string[] = []) => ({ status: 'ready', message: '', lookupQuery: '', intent: { ...intent, references } });
const completion = (value: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
const signal = () => new AbortController().signal;
const capture = () => { const events: IntentEvent[] = []; return { events, observer: (event: IntentEvent) => { events.push(event); } }; };
afterEach(() => vi.restoreAllMocks());

describe('intent metadata observability', () => {
  it('logs default success metadata with a generated ID and no private text or credentials', async () => {
    const sink = vi.spyOn(log, 'info').mockImplementation(() => {});
    const fetcher = vi.fn<Fetch>().mockResolvedValue(completion(ready()));
    expect((await createIntentInterpreter({ apiKey: 'secret-sentinel', fetcher })(input, signal(), { requestId: 'private-injected-id secret-sentinel' })).status).toBe('ready');
    const events = sink.mock.calls.map(call => call[2] as IntentEvent);
    expect(events.map(event => event.event)).toEqual(['started', 'completion', 'finished']);
    expect(events[1]).toMatchObject({ httpStatus: 200, callCount: 1, outcome: 'response' });
    expect(events[2]).toMatchObject({ status: 'ready', reason: 'accepted', callCount: 1, sourceCount: 0,
      featureHints: ['ambient'], requiredFeatures: [], excludedFeatures: [], contextLength: intent.contextPrompt.length });
    expect(new Set(events.map(event => event.requestId)).size).toBe(1);
    expect(events[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.every(event => Number.isFinite(event.durationMs) && event.durationMs >= 0)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/secret-sentinel|private-|authorization|https?:\/\//);
  });
  it('records one repair and lookup counts without provider output, source content or URLs', async () => {
    const { events, observer } = capture();
    const responses = [completion('private-provider-output secret-sentinel'),
      completion({ status: 'needs_lookup', message: '', lookupQuery: 'private-query', intent: null }), completion(ready(['wiki:1']))];
    const fetcher = vi.fn<Fetch>().mockImplementation(async () => responses.shift()!);
    const lookup = vi.fn().mockResolvedValue([{ id: 'wiki:1', title: 'private-title', extract: 'private-source', url: 'https://en.wikipedia.org/?curid=1' }]);
    expect((await createIntentInterpreter({ apiKey: 'secret-sentinel', fetcher, lookup, observer })(input, signal())).status).toBe('ready');
    expect(events.map(event => event.event)).toEqual(['started', 'completion', 'repair', 'completion', 'lookup', 'completion', 'finished']);
    expect(events.find(event => event.event === 'repair')).toMatchObject({ reason: 'invalid_plan', callCount: 1 });
    expect(events.find(event => event.event === 'lookup')).toMatchObject({ sourceCount: 1, outcome: 'ready' });
    expect(events.at(-1)).toMatchObject({ status: 'ready', callCount: 3, sourceCount: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toMatch(/secret-sentinel|private-|wiki:1|wikipedia/);
  });
  it('records provider rate failure without retry or raw response details', async () => {
    const { events, observer } = capture();
    const fetcher = vi.fn<Fetch>().mockResolvedValue(new Response('secret-sentinel private-provider-body', { status: 429 }));
    expect((await createIntentInterpreter({ apiKey: 'secret-sentinel', fetcher, observer })(input, signal())).status).toBe('error');
    expect(events[1]).toMatchObject({ event: 'completion', httpStatus: 429, callCount: 1 });
    expect(events.at(-1)).toMatchObject({ status: 'error', reason: 'provider_rate_limit', callCount: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toMatch(/secret-sentinel|private-/);
  });
  it('records caller cancellation with null HTTP status and no exception message', async () => {
    const { events, observer } = capture();
    const controller = new AbortController();
    const fetcher = vi.fn<Fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('private-abort secret-sentinel')), { once: true });
    }));
    const pending = createIntentInterpreter({ apiKey: 'secret-sentinel', fetcher, observer })(input, controller.signal);
    controller.abort();
    expect((await pending).status).toBe('error');
    expect(events[1]).toMatchObject({ event: 'completion', httpStatus: null, outcome: 'aborted', callCount: 1 });
    expect(events.at(-1)).toMatchObject({ status: 'abort', reason: 'aborted', callCount: 1 });
    expect(JSON.stringify(events)).not.toMatch(/secret-sentinel|private-/);
  });
  it('distinguishes missing song evidence from lookup transport failure without another completion', async () => {
    for (const fail of [false, true]) {
      const { events, observer } = capture();
      const lookup = fail ? vi.fn().mockRejectedValue(new Error('private-lookup secret-sentinel'))
        : vi.fn().mockResolvedValue([{ id: 'wiki:1', title: 'Artist name', extract: 'private-source', url: 'https://en.wikipedia.org/?curid=1' }]);
      const fetcher = vi.fn<Fetch>().mockResolvedValue(completion({ status: 'needs_lookup', message: '', lookupQuery: 'Artist name', intent: null }));
      expect((await createIntentInterpreter({ apiKey: 'secret-sentinel', fetcher, lookup, observer })({ ...input, text: 'track "Private title"' }, signal())).status).toBe('clarify');
      expect(events.at(-1)).toMatchObject({ status: 'clarify', reason: fail ? 'lookup_failed' : 'song_title_missing', callCount: 1 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(events)).not.toMatch(/secret-sentinel|private-|Private title|Artist name|wikipedia/);
    }
  });
  it('does not change behavior when either the observer or default logger throws', async () => {
    for (const useObserver of [false, true]) {
      const throwing = () => { throw new Error('diagnostic failure'); };
      vi.spyOn(log, 'info').mockImplementation(throwing);
      const fetcher = vi.fn<Fetch>().mockResolvedValue(completion(ready()));
      expect((await createIntentInterpreter({ apiKey: 'key', fetcher, ...(useObserver ? { observer: throwing } : {}) })(input, signal())).status).toBe('ready');
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });
  it('contains asynchronous observer failures without awaiting them', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(completion(ready()));
    expect((await createIntentInterpreter({ apiKey: 'key', fetcher,
      observer: async () => { throw new Error('async diagnostic failure'); } })(input, signal())).status).toBe('ready');
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
