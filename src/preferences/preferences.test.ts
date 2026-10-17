import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPreferencesStore } from './index';
import type { FeedbackRecord, SavedProfile } from './types';
import { readFeedback, readProfile, readPurpose, snapshotFeedback, snapshotProfile } from './validation';

const profile = (): SavedProfile => ({
  purpose: 'focus', updatedAt: 1000,
  state: { seed: 42, votes: 3, scores: { piano: 0.2 } },
});
const event = (): FeedbackRecord => ({
  id: 'session-1:3', at: 1000, sessionId: 'session-1', purpose: 'focus', vote: 'up',
  audible: { piano: 0.5, ambient: 0.6 }, previous: { piano: 0.4, ambient: 0.6 }, evidenceWeight: 0.5,
  targetBefore: { features: { piano: 0.5 }, prompts: [{ text: 'Soft piano', weight: 0.5 }] },
  targetAfter: { features: { piano: 0.6 }, prompts: [{ text: 'Soft piano', weight: 0.6 }] },
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('preference record boundaries', () => {
  it('preserves opaque model fields and detaches queued data from later caller mutations', () => {
    const source = { ...profile(), state: { ...profile().state, purpose: 'focus',
      A: [[0.35, 0], [0, 0.35]], b: [0.2, -0.1], pairwiseEvidence: 1.5,
      unexpectedDislikes: [{ x: [0.1, 0.2], weight: 0.4 }], lastRecoveryVote: null } };
    const saved = snapshotProfile(source);
    expect(saved).toEqual(source);
    source.state.A[0]![0] = 99;
    source.state.unexpectedDislikes[0]!.x[0] = 100;
    expect(saved).not.toEqual(source);
    expect(readProfile({ ...saved, schemaVersion: 1 })).toEqual(saved);
  });

  it('retains raw zero-evidence votes and target diagnostic metadata without inventing evidence', () => {
    const raw = { ...event(), evidenceWeight: 0, targetAfter: { ...event().targetAfter,
      phrasingSalt: 123, lastDecision: { kind: 'hold', step: 4, reason: 'Keep this blend' } } };
    expect(snapshotFeedback(raw)).toEqual(raw);
    expect(readFeedback({ ...raw, schemaVersion: 1 })).toEqual(raw);
  });

  it('retains Crazy profiles, feedback, and selected-purpose metadata', () => {
    const saved = { ...profile(), purpose: 'crazy', state: { ...profile().state, purpose: 'crazy' } };
    expect(snapshotProfile(saved)).toEqual(saved);
    expect(readProfile({ ...saved, schemaVersion: 1 })).toEqual(saved);
    expect(snapshotFeedback({ ...event(), purpose: 'crazy' }).purpose).toBe('crazy');
    expect(readPurpose({ key: 'purpose', schemaVersion: 1, purpose: 'crazy' })).toBe('crazy');
  });

  it('omits corrupt or unsupported persisted envelopes without interpreting model mathematics', () => {
    expect(readProfile({ ...profile(), schemaVersion: 2 })).toBeUndefined();
    expect(readProfile({ ...profile(), schemaVersion: 1, purpose: 'unknown' })).toBeUndefined();
    expect(readProfile({ ...profile(), schemaVersion: 1, state: { ...profile().state, votes: -1 } })).toBeUndefined();
    expect(readPurpose({ key: 'purpose', schemaVersion: 1, purpose: 'relax' })).toBe('relax');
    expect(readPurpose({ key: 'purpose', schemaVersion: 2, purpose: 'relax' })).toBeUndefined();
    // The adapter, not storage, must reject a mathematically invalid covariance matrix.
    const opaque = { ...profile(), state: { ...profile().state, A: [[-1]] } };
    expect(snapshotProfile(opaque)).toEqual(opaque);
  });

  it('rejects nonfinite, cyclic, binary, oversized, sparse huge, or accessor payloads', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = { get read() { throw new Error('must never be evaluated'); } };
    for (const extra of [NaN, Infinity, cycle, new Uint8Array(12), 'x'.repeat(300_000), new Array(100_000), accessor]) {
      expect(() => snapshotProfile({ ...profile(), state: { ...profile().state, extra } })).toThrow(TypeError);
    }
    expect(() => snapshotProfile({ ...profile(), state: { ...profile().state, purpose: 'relax' } })).toThrow();
  });

  it('rejects invalid feedback while accepting both directions and optional comparisons', () => {
    const { previous: _, ...down } = event();
    expect(snapshotFeedback({ ...down, vote: 'down' }).previous).toBeUndefined();
    for (const changes of [{ evidenceWeight: -1 }, { evidenceWeight: 2 }, { id: '' }, { vote: 'sideways' },
      { audible: { piano: -1 } }, { targetBefore: { features: {}, prompts: [] } }, { previous: { piano: NaN } }]) {
      expect(() => snapshotFeedback({ ...event(), ...changes })).toThrow(TypeError);
    }
  });
});

// An opening-request stub only: no in-memory IDB implementation or simulated transactions.
function openingStub() {
  const request = {
    onblocked: null, onerror: null, onupgradeneeded: null, onsuccess: null,
    result: undefined, error: null, transaction: null,
  } as unknown as IDBOpenDBRequest;
  const open = vi.fn(() => request);
  const factory = { open } as unknown as IDBFactory;
  const fire = (name: 'onblocked' | 'onerror' | 'onupgradeneeded' | 'onsuccess') => {
    const callback = request[name] as ((this: IDBOpenDBRequest, event: Event) => void) | null;
    callback?.call(request, new Event(name.slice(2)));
  };
  return { request, open, factory, fire };
}

describe('storage failure lifecycle', () => {
  it('rejects every operation when IndexedDB is unavailable instead of pretending to persist', async () => {
    const store = createBrowserPreferencesStore({ indexedDB: null });
    for (const operation of [() => store.load(), () => store.save(profile(), event()),
      () => store.selectPurpose('focus'), () => store.export(), () => store.clear()]) {
      await expect(operation()).rejects.toThrow('IndexedDB is unavailable');
    }
  });

  it('validates snapshots and purpose consistency before attempting to open', async () => {
    const { factory, open } = openingStub();
    const store = createBrowserPreferencesStore({ indexedDB: factory });
    await expect(store.save(profile(), { ...event(), purpose: 'relax' })).rejects.toThrow('purposes differ');
    await expect(store.save({ ...profile(), updatedAt: Infinity })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects synchronous access failures and permits a later retry', async () => {
    const open = vi.fn(() => { throw new DOMException('Access denied', 'SecurityError'); });
    const store = createBrowserPreferencesStore({ indexedDB: { open } as unknown as IDBFactory });
    await expect(store.load()).rejects.toThrow('Access denied');
    await expect(store.load()).rejects.toThrow('Access denied');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('shares a pending open, bounds the wait, and closes a connection that arrives too late', async () => {
    vi.useFakeTimers();
    const { factory, request, open, fire } = openingStub();
    const store = createBrowserPreferencesStore({ indexedDB: factory, timeoutMs: 30 });
    const loaded = expect(store.load()).rejects.toThrow('opening timed out');
    const exported = expect(store.export()).rejects.toThrow('opening timed out');
    await vi.advanceTimersByTimeAsync(30);
    await Promise.all([loaded, exported]);
    expect(open).toHaveBeenCalledTimes(1);
    const close = vi.fn();
    Object.assign(request, { result: { close } });
    fire('onsuccess');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects blocked opens promptly and aborts a late upgrade', async () => {
    const { factory, request, fire } = openingStub();
    const store = createBrowserPreferencesStore({ indexedDB: factory });
    const loaded = expect(store.load()).rejects.toThrow('blocked');
    fire('onblocked');
    await loaded;
    const abort = vi.fn();
    Object.assign(request, { transaction: { abort } });
    fire('onupgradeneeded');
    expect(abort).toHaveBeenCalledOnce();
  });
});
