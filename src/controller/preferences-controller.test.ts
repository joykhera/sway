import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePlayer, fakeLearner, fakeRelay } from '../../tests/e2e/harness.ts';
import type { LearnerState, ListeningPurpose, SessionState } from '../shared/protocol.ts';
import type { FeedbackRecord, PreferencesStore, SavedProfile } from '../preferences/types.ts';
import { SessionController } from './index.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function memoryStore() {
  let purpose: ListeningPurpose | undefined;
  let profiles: Partial<Record<ListeningPurpose, SavedProfile>> = {};
  let events: FeedbackRecord[] = [];
  const store: PreferencesStore = {
    load: vi.fn(async () => structuredClone({ purpose, profiles })),
    save: vi.fn(async (profile: SavedProfile, event?: FeedbackRecord) => {
      profiles[profile.purpose] = structuredClone(profile);
      if (event) events.push(structuredClone(event));
    }),
    selectPurpose: vi.fn(async (next) => { purpose = next; }),
    export: vi.fn(async () => JSON.stringify({ purpose, profiles, feedback: events })),
    clear: vi.fn(async () => { purpose = undefined; profiles = {}; events = []; }),
  };
  return { store, get profiles() { return profiles; }, get events() { return events; } };
}
class MeasuredPlayer extends FakePlayer {
  priming = false;
  audioContextState = 'running';
  getStats() { return { state: 'ready', priming: this.priming, audioContextState: this.audioContextState }; }
}
function rig(store?: PreferencesStore, restoreState: (value: unknown) => LearnerState | undefined = (value: unknown) => value as LearnerState) {
  const relay = fakeRelay();
  const player = new MeasuredPlayer();
  const learner = fakeLearner().learner;
  const vote = vi.spyOn(learner, 'processVote');
  const controller = new SessionController({ learner, player, createTransport: relay.create,
    preferences: store, restoreState, seed: 7,
    config: { generationLatencyMs: 0, noVoteEvolveMs: 1_000_000, voteRampMs: 8000 } });
  const states: SessionState[] = [];
  controller.subscribe(state => states.push(state));
  return { controller, relay, player, vote, states, start: async () => { await controller.start(); await flush(); } };
}

describe('feedback on an exploration change', () => {
  it('compares a fresh audible Like to the rejected blend once, retaining the whole transition', async () => {
    const db = memoryStore();
    const r = rig(db.store);
    await r.start();
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(1000);
    r.controller.vote('up');
    const vote = r.vote.mock.calls.at(-1)![0];
    expect(vote.audible).toEqual({ ambient: 0.75, jazz: 0.25 });
    expect(vote.comparison).toEqual({ previous: { ambient: 1 } });
    expect(vote.evidenceWeight).toBe(1);
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].comparison).toBeUndefined();
    await r.controller.exportFeedback();
    expect(db.events).toHaveLength(3);
    expect(db.events[1]).toMatchObject({ previous: { ambient: 1 }, evidenceWeight: 1 });
    expect(db.events[2]).toMatchObject({ evidenceWeight: 0 });
    expect(new Set(db.events.map(event => event.id)).size).toBe(3);
    r.controller.stop();
  });

  it('does not label an unheard destination or suspended playback as the liked change', async () => {
    const r = rig();
    await r.start();
    r.player.bufferedMs = 20_000;
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(2000);
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].comparison).toBeUndefined();
    expect(r.vote.mock.calls.at(-1)![0].audible).toEqual({ ambient: 1 });
    r.player.bufferedMs = 0;
    r.player.audioContextState = 'suspended';
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0]).toMatchObject({ evidenceWeight: 0 });
    expect(r.vote.mock.calls.at(-1)![0].comparison).toBeUndefined();
    r.controller.stop();
  });

  it.each(['expired', 'reconnected', 'stopped'] as const)('does not reuse a %s rejected episode', async (condition) => {
    const r = rig();
    await r.start();
    r.controller.vote('down');
    if (condition === 'expired') await vi.advanceTimersByTimeAsync(120_001);
    if (condition === 'reconnected') {
      r.relay.last.drop();
      await vi.advanceTimersByTimeAsync(1000);
    }
    if (condition === 'stopped') { r.controller.stop(); await r.start(); }
    await vi.advanceTimersByTimeAsync(8000);
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].comparison).toBeUndefined();
    r.controller.stop();
  });
});

describe('persistent profile controller', () => {
  it('restores each profile on a new controller and keeps their evidence separate', async () => {
    const db = memoryStore();
    const r = rig(db.store);
    r.controller.setPurpose('crazy');
    await r.start();
    r.controller.vote('down');
    r.controller.vote('up');
    r.controller.stop();
    r.controller.setPurpose('relax');
    await r.start();
    r.controller.vote('up');
    r.controller.stop();
    await r.controller.exportFeedback();
    expect(db.profiles.crazy?.state.votes).toBe(2);
    expect(db.profiles.relax?.state.votes).toBe(1);
    const next = rig(db.store);
    await flush();
    expect(next.states.at(-1)).toMatchObject({ purpose: 'relax', savedVotes: 1, memory: 'ready' });
    next.controller.setPurpose('crazy');
    await next.start();
    next.controller.vote('up');
    expect(next.vote.mock.calls[0]![0].state.votes).toBe(2);
    expect(next.vote.mock.calls[0]![0].comparison).toBeUndefined();
    next.controller.stop();
    await next.controller.exportFeedback();
    expect(db.events.map(event => event.purpose)).toEqual(['crazy', 'crazy', 'relax', 'crazy']);
  });

  it('creates audio inside the gesture, then waits for preferences before connecting', async () => {
    const db = memoryStore();
    const load = deferred<Awaited<ReturnType<PreferencesStore['load']>>>();
    db.store.load = () => load.promise;
    const r = rig(db.store);
    const started = r.controller.start();
    expect(r.player.initialized).toBe(1);
    expect(r.relay.transports).toHaveLength(0);
    load.resolve({ purpose: 'crazy', profiles: { crazy: { purpose: 'crazy', updatedAt: Date.now(), state: { seed: 2, votes: 8, scores: {} } } } });
    await started;
    await flush();
    r.controller.vote('up');
    expect(r.vote.mock.calls[0]![0].state.votes).toBe(8);
    expect(r.states.at(-1)).toMatchObject({ purpose: 'crazy', status: 'playing' });
    r.controller.stop();
  });

  it('records feedback during loading with zero evidence, without overwriting restored learning', async () => {
    const db = memoryStore();
    const load = deferred<Awaited<ReturnType<PreferencesStore['load']>>>();
    db.store.load = () => load.promise;
    const r = rig(db.store);
    const started = r.controller.start();
    const clickedAt = Date.now();
    r.controller.vote('down');
    r.controller.stop();
    load.resolve({ profiles: { explore: { purpose: 'explore', updatedAt: clickedAt, state: { seed: 2, votes: 5, scores: {} } } } });
    await started;
    await r.controller.exportFeedback();
    expect(r.relay.transports).toHaveLength(0);
    expect(db.events[0]).toMatchObject({ vote: 'down', at: clickedAt, evidenceWeight: 0 });
    expect(db.profiles.explore?.state.votes).toBe(6);
  });

  it('keeps canceled loading feedback in its original profile after switching', async () => {
    const db = memoryStore();
    const load = deferred<Awaited<ReturnType<PreferencesStore['load']>>>();
    db.store.load = () => load.promise;
    const r = rig(db.store);
    const started = r.controller.start();
    r.controller.vote('down');
    r.controller.stop();
    r.controller.setPurpose('crazy');
    load.resolve({ profiles: { crazy: { purpose: 'crazy', updatedAt: Date.now(), state: { seed: 2, votes: 8, scores: {} } } } });
    await started;
    await r.controller.exportFeedback();
    expect(db.events[0]).toMatchObject({ purpose: 'explore', evidenceWeight: 0 });
    expect(db.profiles.explore?.state.votes).toBe(1);
    await r.start();
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].state.votes).toBe(8);
    r.controller.stop();
  });

  it('honors an explicit same-purpose choice over the saved selection during loading', async () => {
    const db = memoryStore();
    const load = deferred<Awaited<ReturnType<PreferencesStore['load']>>>();
    db.store.load = () => load.promise;
    const r = rig(db.store);
    r.controller.setPurpose('explore');
    load.resolve({ purpose: 'crazy', profiles: {} });
    await r.start();
    expect(r.states.at(-1)?.purpose).toBe('explore');
    r.controller.stop();
  });

  it('rejects corrupt saved models and continues playback when storage fails', async () => {
    const db = memoryStore();
    await db.store.save({ purpose: 'explore', updatedAt: Date.now(), state: { seed: 0, votes: 999, scores: {} } });
    const r = rig(db.store, value => (value as LearnerState).votes === 999 ? undefined : value as LearnerState);
    await r.start();
    r.controller.vote('up');
    expect(r.vote.mock.calls[0]![0].state.votes).toBe(0);
    r.controller.stop();
    const failed = memoryStore();
    failed.store.load = async () => { throw new Error('blocked'); };
    failed.store.save = async () => { throw new Error('quota'); };
    const next = rig(failed.store);
    await next.start();
    next.controller.vote('up');
    await flush();
    expect(next.states.at(-1)).toMatchObject({ status: 'playing', memory: 'unavailable' });
    next.controller.stop();
  });

  it('never overwrites an unread saved profile after a transient load failure', async () => {
    const db = memoryStore();
    await db.store.save({ purpose: 'explore', updatedAt: Date.now(), state: { seed: 2, votes: 8, scores: {} } });
    const writesBefore = vi.mocked(db.store.save).mock.calls.length;
    db.store.load = async () => { throw new Error('transient blocked database'); };
    const r = rig(db.store);
    await r.start();
    r.controller.vote('up');
    await flush();
    expect(vi.mocked(db.store.save).mock.calls).toHaveLength(writesBefore);
    expect(db.profiles.explore?.state.votes).toBe(8);
    expect(r.states.at(-1)).toMatchObject({ status: 'playing', memory: 'unavailable' });
    r.controller.stop();
    await r.controller.resetPreferences();
    await r.start();
    r.controller.vote('up');
    await flush();
    expect(db.profiles.explore?.state.votes).toBe(1);
    r.controller.stop();
  });

  it('clears every saved profile and feedback after pending writes, and refuses reset during playback', async () => {
    const db = memoryStore();
    const r = rig(db.store);
    await r.start();
    r.controller.vote('up');
    await expect(r.controller.resetPreferences()).rejects.toThrow('End the session');
    r.controller.stop();
    await r.controller.resetPreferences();
    expect(db.events).toEqual([]);
    expect(db.profiles).toEqual({});
    expect(r.states.at(-1)).toMatchObject({ savedVotes: 0, memory: 'ready' });
    await r.start();
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].state.votes).toBe(0);
    r.controller.stop();
  });
});
