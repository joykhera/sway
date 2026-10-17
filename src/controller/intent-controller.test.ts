import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { validateClientMessage } from '../../server/guard.ts';
import { SessionController } from './index.ts';
import { adaptiveLearner, isAdaptiveState } from '../learner/adaptive/adapter.ts';
import { FakePlayer, fakeRelay } from '../../tests/e2e/harness.ts';
import type { MusicIntent, InterpretResponse } from '../shared/intent.ts';
import type { SessionState, StreamLevels } from '../shared/protocol.ts';
import type { FeedbackRecord, PreferencesStore, SavedProfile } from '../preferences/types.ts';
import type { IntentInterpreter } from './intent-client.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);
const jazz: MusicIntent = { schemaVersion: 1, summary: 'Jazz for reading', purposeHint: 'focus',
  requiredFeatures: ['jazz'], excludedFeatures: [], featureHints: ['calm'], contextPrompt: 'For reading', avoid: [], references: [] };
const electronic: MusicIntent = { ...jazz, summary: 'Electronic workout', requiredFeatures: ['electronic'], featureHints: ['energetic'] };
const ready = (intent = jazz): InterpretResponse => ({ status: 'ready', intent });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function memory() {
  let profile: SavedProfile | undefined;
  const events: FeedbackRecord[] = [];
  const store: PreferencesStore = {
    async load() { return { profiles: profile ? { [profile.purpose]: structuredClone(profile) } : {} }; },
    async save(next, event) { profile = structuredClone(next); if (event) events.push(structuredClone(event)); },
    async selectPurpose() {}, async export() { return JSON.stringify({ profile, events }); },
    async clear() { profile = undefined; events.length = 0; },
  };
  return { store, events, get profile() { return profile; } };
}
function rig(interpretIntent: IntentInterpreter = async () => ready(), preferences?: PreferencesStore) {
  const learner = { ...adaptiveLearner };
  const vote = vi.spyOn(learner, 'processVote');
  const apply = vi.spyOn(learner, 'applyIntent');
  const evolve = vi.spyOn(learner, 'evolveNoVote');
  const player = new FakePlayer();
  const relay = fakeRelay();
  const controller = new SessionController({ learner, player, createTransport: relay.create, seed: 11,
    interpretIntent, preferences, restoreState: value => isAdaptiveState(value) ? value : undefined,
    config: { generationLatencyMs: 0, rampMs: 2000, stepMs: 100, noVoteEvolveMs: 5000 } });
  let state!: SessionState;
  controller.subscribe(next => { state = next; });
  return { controller, learner, vote, apply, evolve, player, relay, get state() { return state; },
    async start() { await controller.start(); await flush(); } };
}

describe('text intent controller', () => {
  it('applies and clears context without a vote; persists the brief with unchanged learned evidence', async () => {
    const db = memory(); const r = rig(undefined, db.store); await flush();
    await r.controller.interpretText('jazz only for reading');
    await r.controller.exportFeedback();
    expect(r.state).toMatchObject({ intent: jazz, intentStatus: 'ready', status: 'idle', purpose: 'explore' });
    expect(r.vote).not.toHaveBeenCalled(); expect(db.events).toHaveLength(0);
    expect(db.profile?.state.votes).toBe(0); expect(db.profile?.intent).toEqual(jazz);
    const model = structuredClone(db.profile!.state);
    const next = rig(undefined, db.store); await flush();
    expect(next.state.intent).toEqual(jazz);
    await next.start();
    expect(next.relay.last.sent[0]).toMatchObject({ type: 'start', prompts: expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/jazz/i) })]) });
    next.controller.stop(); next.controller.clearIntent(); await next.controller.exportFeedback();
    expect(db.profile?.intent).toBeUndefined(); expect(db.profile?.state).toEqual(model);
  });

  it('newest request wins, including clear, stop, and profile switches', async () => {
    const requests: ReturnType<typeof deferred<InterpretResponse>>[] = [];
    const signals: AbortSignal[] = [];
    const r = rig(async (_, signal) => { signals.push(signal); const d = deferred<InterpretResponse>(); requests.push(d); return d.promise; });
    const first = r.controller.interpretText('jazz'); await flush();
    const second = r.controller.interpretText('electronic'); await flush();
    requests[1]!.resolve(ready(electronic)); await second;
    requests[0]!.resolve(ready()); await first;
    expect(signals[0]!.aborted).toBe(true); expect(r.state.intent).toEqual(electronic);
    for (const cancel of [() => r.controller.clearIntent(), () => r.controller.stop(), () => r.controller.setPurpose('focus')]) {
      const pending = r.controller.interpretText('jazz'); await flush(); cancel();
      requests.at(-1)!.resolve(ready()); await pending;
      expect(r.state.intent).not.toEqual(jazz); expect(signals.at(-1)!.aborted).toBe(true);
    }
  });

  it('errors, clarification and malformed output retain current intent and playing audio', async () => {
    let response: unknown = ready();
    const r = rig(async () => response as InterpretResponse);
    await r.controller.interpretText('jazz'); await r.start();
    for (const next of [{ status: 'clarify', message: 'Which artist?' }, { status: 'error', message: 'Try again later.' }, { status: 'ready', intent: { ...jazz, requiredFeatures: ['invalid'] } }]) {
      response = next; await r.controller.interpretText('something else');
      expect(r.state.intent).toEqual(jazz); expect(r.state.status).toBe('playing'); expect(r.player.closed).toBe(0);
    }
    r.controller.stop();
    expect(r.state.intentStatus).toBe('ready'); expect(r.state.intentMessage).toBeUndefined();
  });

  it('keeps thumbs received during interpretation and passes intent through later votes and freshness', async () => {
    const pending = deferred<InterpretResponse>(); const db = memory();
    const r = rig(async () => pending.promise, db.store); await r.start();
    const request = r.controller.interpretText('jazz'); await flush();
    r.controller.vote('down'); const voted = structuredClone(r.vote.mock.results.at(-1)!.value.state);
    pending.resolve(ready()); await request;
    expect(r.apply.mock.calls.at(-1)![0].state).toEqual(voted);
    r.controller.vote('up'); expect(r.vote.mock.calls.at(-1)![0]).toMatchObject({ intent: jazz, evidenceWeight: 0 });
    await vi.advanceTimersByTimeAsync(2500);
    r.controller.vote('down'); expect(r.vote.mock.calls.at(-1)![0]).toMatchObject({ intent: jazz, evidenceWeight: 1 });
    await r.controller.exportFeedback();
    expect(db.events.at(-1)).toMatchObject({ intent: jazz, intentText: 'jazz', intentAppliedToAudible: true });
    expect(db.events[1]).toMatchObject({ evidenceWeight: 0, intentAppliedToAudible: false });
    await vi.advanceTimersByTimeAsync(6000);
    expect(r.evolve.mock.calls.at(-1)![0].intent).toEqual(jazz);
    r.controller.stop();
  });

  it('does not learn old buffered music as feedback on a new request', async () => {
    const r = rig(); await r.start(); r.player.bufferedMs = 10_000;
    await r.controller.interpretText('jazz');
    await vi.advanceTimersByTimeAsync(2500); r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(0);
    r.player.bufferedMs = 0; await vi.advanceTimersByTimeAsync(100); r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(1);
    r.controller.stop();
  });

  it('clearing during memory load cannot resurrect the saved brief', async () => {
    const db = memory(); const pending = deferred<Awaited<ReturnType<PreferencesStore['load']>>>();
    db.store.load = () => pending.promise;
    const r = rig(undefined, db.store);
    r.controller.clearIntent();
    const state = r.learner.createLearner(11, 'explore');
    pending.resolve({ profiles: { explore: { purpose: 'explore', state, updatedAt: 1, intent: jazz, intentText: 'jazz' } } });
    await flush(); await r.controller.exportFeedback();
    expect(r.state.intent).toBeUndefined(); expect(db.profile?.intent).toBeUndefined();
    expect(db.profile?.state).toEqual(state);
  });

  it('never sends an oversized prompt union between two valid requests', async () => {
    const a: MusicIntent = { ...jazz, contextPrompt: 'A quiet reading room',
      avoid: ['A'.repeat(80), 'B'.repeat(80), 'C'.repeat(80), 'D'.repeat(80), 'E'.repeat(80), 'F'.repeat(80)] };
    const b: MusicIntent = { ...electronic, contextPrompt: 'A high energy gym',
      avoid: ['G'.repeat(80), 'H'.repeat(80), 'I'.repeat(80), 'J'.repeat(80), 'K'.repeat(80), 'L'.repeat(80)] };
    let intent = a;
    const r = rig(async () => ready(intent)); await r.controller.interpretText('reading'); await r.start();
    intent = b; await r.controller.interpretText('workout'); await vi.advanceTimersByTimeAsync(2100);
    expect(r.relay.last.steers.length).toBeGreaterThan(0);
    for (const message of r.relay.last.sent) expect(validateClientMessage(message).ok).toBe(true);
    expect(r.relay.last.steers.at(-1)!.prompts).toEqual(r.apply.mock.results.at(-1)!.value.prompts);
    r.controller.stop();
  });


  it('a relay reconnect cannot relabel old queued audio with a newer intent', async () => {
    const r = rig(); await r.start(); r.player.bufferedMs = 10_000;
    await r.controller.interpretText('jazz'); await vi.advanceTimersByTimeAsync(2500);
    r.controller.vote('up'); expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(0);
    r.relay.last.serverMessage({ type: 'status', state: 'reconnecting' }); r.relay.last.ready();
    r.controller.vote('up'); expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(0);
    r.player.bufferedMs = 0; await vi.advanceTimersByTimeAsync(100);
    r.controller.vote('up'); expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(1);
    r.controller.stop();
  });

});


describe('request changes and vote progress', () => {
  it.each(['apply', 'clear'] as const)('%s cancels superseded vote progress without marking it complete', async action => {
    let intent = jazz;
    const r = rig(async () => ready(intent));
    await r.controller.interpretText('jazz'); await r.start();
    const stats: StreamLevels[] = []; r.controller.subscribeStats(s => stats.push(s));
    r.controller.vote('down');
    expect(stats.at(-1)?.steerVote).toBe('down');
    await vi.advanceTimersByTimeAsync(100);
    if (action === 'apply') { intent = electronic; await r.controller.interpretText('electronic'); }
    else r.controller.clearIntent();
    expect(stats.at(-1)).toMatchObject({ steerCanceled: true, steerProgress: null, steerVote: null });
    await vi.advanceTimersByTimeAsync(1200);
    expect(stats.at(-1)?.steerProgress).toBeNull();
    r.controller.vote('up');
    expect(stats.at(-1)).toMatchObject({ steerVote: 'up', steerProgress: 0 });
    r.controller.stop();
  });

  it.each(['clarify', 'error'] as const)('%s leaves the current vote transition in place', async status => {
    const r = rig(async () => ({ status, message: 'Try another description.' })); await r.start();
    const stats: StreamLevels[] = []; r.controller.subscribeStats(s => stats.push(s));
    r.controller.vote('down'); await r.controller.interpretText('something');
    await vi.advanceTimersByTimeAsync(100);
    expect(stats.some(s => s.steerCanceled)).toBe(false);
    expect(stats.at(-1)?.steerVote).toBe('down');
    r.controller.stop();
  });

  it('does not finish a vote while the upstream reconnects and awaits ready', async () => {
    const r = rig(); await r.start();
    const stats: StreamLevels[] = []; r.controller.subscribeStats(s => stats.push(s));
    r.controller.vote('down'); r.relay.last.audio();
    r.relay.last.serverMessage({ type: 'status', state: 'reconnecting' });
    expect(stats.at(-1)).toMatchObject({ steerCanceled: true, steerProgress: null });
    await vi.advanceTimersByTimeAsync(3000);
    expect(stats.at(-1)?.steerProgress).toBeNull();
    r.relay.last.ready(); r.controller.vote('up');
    expect(stats.at(-1)?.steerVote).toBe('up');
    r.controller.stop();
  });
});
