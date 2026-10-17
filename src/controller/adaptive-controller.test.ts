import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePlayer, fakeLearner, fakeRelay } from '../../tests/e2e/harness.ts';
import type { Learner, ListeningPurpose, Target } from '../shared/protocol.ts';
import { SessionController, type ControllerConfig } from './index.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

class MeasuredPlayer extends FakePlayer {
  playbackState = 'ready';
  priming = false;
  audioContextState = 'running';
  getStats() { return { state: this.playbackState, priming: this.priming, audioContextState: this.audioContextState }; }
}

function rig(options: { auto?: boolean; purpose?: ListeningPurpose; config?: Partial<ControllerConfig>; learner?: Learner } = {}) {
  const relay = fakeRelay(options.auto ?? true);
  const player = new MeasuredPlayer();
  const learner = options.learner ?? fakeLearner().learner;
  const create = vi.spyOn(learner, 'createLearner');
  const vote = vi.spyOn(learner, 'processVote');
  const evolve = vi.spyOn(learner, 'evolveNoVote');
  const log = vi.fn();
  const controller = new SessionController({ learner, player, createTransport: relay.create, seed: 7,
    purpose: options.purpose, config: { generationLatencyMs: 0, ...options.config }, log });
  const start = async () => { await controller.start(); await vi.advanceTimersByTimeAsync(0); };
  return { relay, player, learner, create, vote, evolve, log, controller, start };
}

describe('audible feedback evidence', () => {
  it('freezes heard attribution and evidence while AudioContext is suspended or interrupted, then resumes', async () => {
    const r = rig();
    await r.start();
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(4000);
    r.controller.vote('up');
    const heard = { ambient: 0.375, jazz: 0.625 };
    expect(r.vote.mock.calls.at(-1)![0].audible).toEqual(heard);
    r.player.audioContextState = 'suspended';
    await vi.advanceTimersByTimeAsync(1000);
    r.controller.vote('down');
    r.player.audioContextState = 'interrupted';
    await vi.advanceTimersByTimeAsync(1000);
    r.controller.vote('up');
    expect(r.vote.mock.calls.slice(-2).map(([args]) => args.audible)).toEqual([heard, heard]);
    r.player.audioContextState = 'running';
    r.controller.vote('up');
    expect(r.vote.mock.calls.map(([args]) => args.evidenceWeight)).toEqual([1, 1, 0, 0, 1]);
    expect(r.vote.mock.calls.at(-1)![0].audible).not.toEqual(heard);
    expect(r.vote.mock.results.at(-1)?.value.state.votes).toBe(5);
  });

  it('counts and steers actions without evidence before readiness, during priming, or while reconnecting', async () => {
    const r = rig({ auto: false });
    await r.start();
    r.controller.vote('down');
    r.relay.last.open();
    r.relay.last.ready();
    r.player.priming = true;
    r.controller.vote('down');
    r.player.priming = false;
    r.player.playbackState = 'initializing';
    r.controller.vote('down');
    r.player.playbackState = 'ready';
    r.controller.vote('up');
    r.relay.last.serverMessage({ type: 'status', state: 'reconnecting' });
    r.controller.vote('down');
    expect(r.vote.mock.calls.map(([args]) => args.evidenceWeight)).toEqual([0, 0, 0, 1, 0]);
    expect(r.vote.mock.calls.map(([args]) => args.state.votes)).toEqual([0, 1, 2, 3, 4]);
    expect(r.vote.mock.results.at(-1)?.value.state.votes).toBe(5);
    expect(r.relay.last.steers.length).toBeGreaterThan(0);
    expect(r.log.mock.calls.filter(([event]) => event === 'vote').map(([, data]) => data.evidenceWeight)).toEqual([0, 0, 0, 1, 0]);
  });

  it('shares one observation across rapid repeated likes, accepting fresh exposure after six seconds', async () => {
    const r = rig();
    await r.start();
    r.controller.vote('up');
    r.controller.vote('up');
    await vi.advanceTimersByTimeAsync(5999);
    r.controller.vote('up');
    await vi.advanceTimersByTimeAsync(1);
    r.controller.vote('up');
    expect(r.vote.mock.calls.map(([args]) => args.evidenceWeight)).toEqual([1, 0, 0, 1]);
    expect(r.vote.mock.results.at(-1)?.value.state.votes).toBe(4);
    expect(r.relay.last.steers).toHaveLength(0);
  });

  it('accepts a meaningfully changed heard blend within the window but not a small next ramp step', async () => {
    const r = rig();
    await r.start();
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(1000);
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(100);
    r.controller.vote('down');
    expect(r.vote.mock.calls[1]![0].audible).toEqual({ ambient: 0.75, jazz: 0.25 });
    expect(r.vote.mock.calls.map(([args]) => args.evidenceWeight)).toEqual([1, 1, 0]);
    expect(r.relay.last.steers).toHaveLength(4);
  });

  it('recognizes A-to-B-to-A as repeated evidence even when the immediately preceding blend differs', async () => {
    const learner = fakeLearner().learner;
    learner.processVote = ({ state, currentTarget }) => {
      const id = currentTarget.features.ambient ? 'jazz' : 'ambient';
      const target: Target = { features: { [id]: 1 }, prompts: [{ text: id, weight: 1 }] };
      return { state: { ...state, votes: state.votes + 1 }, target };
    };
    const r = rig({ learner, config: { rampMs: 1, stepMs: 1 } });
    await r.start();
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(1);
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(1);
    r.controller.vote('down');
    expect(r.vote.mock.calls.map(([args]) => args.audible)).toEqual([{ ambient: 1 }, { jazz: 1 }, { ambient: 1 }]);
    expect(r.vote.mock.calls.map(([args]) => args.evidenceWeight)).toEqual([1, 1, 0]);
  });

  it('never moves the heard estimate backwards as buffering grows or older history is pruned', async () => {
    const r = rig({ config: { historyRetentionMs: 1000 } });
    await r.start();
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(4000);
    r.controller.vote('up');
    const heard = { ambient: 0.375, jazz: 0.625 };
    expect(r.vote.mock.calls.at(-1)![0].audible).toEqual(heard);
    r.player.bufferedMs = 20_000;
    await vi.advanceTimersByTimeAsync(3000);
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].audible).toEqual(heard);
    r.player.bufferedMs = 0;
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].audible).toEqual({ jazz: 1 });
  });

  it('starts a fresh heard timeline and evidence window on a new connection', async () => {
    const r = rig({ config: { rampMs: 1, stepMs: 1 } });
    await r.start();
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(1);
    r.controller.vote('up');
    r.relay.last.drop();
    await vi.advanceTimersByTimeAsync(1000);
    r.player.bufferedMs = 60_000;
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].audible).toEqual({ jazz: 1 });
    expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(1);
  });
});

describe('purpose lifecycle', () => {
  it('defaults to explore and only resets a changed purpose while inactive', async () => {
    const r = rig();
    expect(r.create).toHaveBeenLastCalledWith(7, 'explore');
    r.controller.setPurpose('focus');
    expect(r.create).toHaveBeenLastCalledWith(7, 'focus');
    await r.start();
    r.controller.vote('down');
    r.controller.setPurpose('energy');
    expect(r.create).toHaveBeenCalledTimes(2);
    r.controller.stop();
    r.controller.setPurpose('focus');
    expect(r.create).toHaveBeenCalledTimes(2);
    await r.start();
    expect(r.relay.last.sent[0]).toEqual({ type: 'start', prompts: [{ text: 'jazz', weight: 1 }] });
    r.controller.stop();
    r.controller.setPurpose('relax');
    expect(r.create).toHaveBeenCalledTimes(3);
    expect(r.create).toHaveBeenLastCalledWith(7, 'relax');
    await r.start();
    expect(r.relay.last.sent[0]).toEqual({ type: 'start', prompts: [{ text: 'ambient', weight: 1 }] });
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].state.votes).toBe(0);
    expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(1);
  });

  it('honors an initial purpose and allows a fresh purpose after an error', async () => {
    const r = rig({ purpose: 'energy' });
    expect(r.create).toHaveBeenLastCalledWith(7, 'energy');
    await r.start();
    r.controller.vote('down');
    r.relay.last.serverMessage({ type: 'error', code: 'bad_message', message: 'failed', retryable: false });
    r.controller.setPurpose('relax');
    expect(r.create).toHaveBeenLastCalledWith(7, 'relax');
    await r.start();
    r.controller.vote('up');
    expect(r.vote.mock.calls.at(-1)![0].state.votes).toBe(0);
    expect(r.vote.mock.calls.at(-1)![0].audible).toEqual({ ambient: 1 });
  });
});

describe('fresh variations and reconnects', () => {
  it('retries freshness without variation or evidence while output is suspended, advancing only once running', async () => {
    const r = rig({ config: { noVoteEvolveMs: 100 } });
    r.player.audioContextState = 'suspended';
    await r.start();
    await vi.advanceTimersByTimeAsync(300);
    r.player.audioContextState = 'interrupted';
    await vi.advanceTimersByTimeAsync(200);
    expect(r.evolve).not.toHaveBeenCalled();
    expect(r.vote).not.toHaveBeenCalled();
    expect(r.relay.last.steers).toHaveLength(0);
    expect(r.log.mock.calls.filter(([event]) => event === 'evolve')).toHaveLength(0);
    r.player.audioContextState = 'running';
    await vi.advanceTimersByTimeAsync(100);
    expect(r.evolve).toHaveBeenCalledTimes(1);
    expect(r.evolve.mock.calls[0]![0].step).toBe(1);
    expect(r.evolve.mock.calls[0]![0].state.votes).toBe(0);
    expect(r.vote).not.toHaveBeenCalled();
  });

  it('retains the actual start target when the relay reconnects before its first ready', async () => {
    const r = rig({ auto: false });
    await r.start();
    r.relay.last.open();
    r.controller.vote('down');
    r.relay.last.serverMessage({ type: 'status', state: 'reconnecting' });
    r.controller.vote('down');
    r.relay.last.ready();
    expect(r.relay.last.steers[0]!.prompts).toEqual([
      { text: 'ambient', weight: 0.875 },
      { text: 'electronic', weight: 0.125 },
    ]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(r.relay.last.steers.at(-1)!.prompts).toEqual([{ text: 'electronic', weight: 1 }]);
  });

  it('holds a liked target without redundant steers or postponing the 45-second variation deadline', async () => {
    const r = rig();
    await r.start();
    await vi.advanceTimersByTimeAsync(30_000);
    r.controller.vote('up');
    expect(r.relay.last.steers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(r.evolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.evolve.mock.calls[0]![0].step).toBe(1);
    expect(r.evolve.mock.calls[0]![0].state.votes).toBe(1);
    expect(r.vote).toHaveBeenCalledTimes(1);
    expect(r.log).toHaveBeenCalledWith('evolve', { step: 1, target: { ambient: 1 } });
  });

  it('continues fresh variations when held-target Likes keep arriving faster than the cadence', async () => {
    const r = rig({ config: { noVoteEvolveMs: 100 } });
    await r.start();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(40);
      r.controller.vote('up');
    }
    // The Likes at 40/80ms must not move the first deadline; Likes during the
    // resulting ramp must not move subsequent deadlines either.
    expect(r.evolve.mock.calls.map(([args]) => args.step)).toEqual([1, 2]);
    expect(r.vote).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(60);
    expect(r.evolve.mock.calls.map(([args]) => args.step)).toEqual([1, 2, 3]);
    expect(r.vote).toHaveBeenCalledTimes(6); // Timed freshness adds no votes.
  });

  it('pauses relay-side reconnect ramps, novelty and evidence until ready, then resumes the latest target', async () => {
    const r = rig();
    await r.start();
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(2000);
    r.relay.last.serverMessage({ type: 'status', state: 'reconnecting' });
    const sent = r.relay.last.steers.length;
    await vi.advanceTimersByTimeAsync(60_000);
    r.relay.last.serverMessage({ type: 'error', code: 'prompt_filtered', message: 'filtered', retryable: true });
    r.relay.last.serverMessage({ type: 'status', state: 'playing' });
    r.controller.vote('down');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.evolve).not.toHaveBeenCalled();
    expect(r.vote.mock.calls.at(-1)![0].evidenceWeight).toBe(0);
    expect(r.relay.last.steers).toHaveLength(sent);
    r.relay.last.ready();
    await vi.advanceTimersByTimeAsync(7000);
    expect(r.relay.last.steers.at(-1)!.prompts).toEqual([{ text: 'electronic', weight: 1 }]);
    await vi.advanceTimersByTimeAsync(37_999);
    expect(r.evolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.evolve.mock.calls[0]![0].step).toBe(1);
    expect(r.relay.transports).toHaveLength(1);
  });

  it('advances explicit novelty steps across filtering and reconnects, resetting only for a changed purpose', async () => {
    const r = rig();
    await r.start();
    r.relay.last.serverMessage({ type: 'error', code: 'prompt_filtered', message: 'filtered', retryable: true });
    await vi.advanceTimersByTimeAsync(45_000);
    r.relay.last.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.evolve.mock.calls.map(([args]) => args.step)).toEqual([1, 2, 3]);
    expect(r.vote).not.toHaveBeenCalled();
    r.controller.stop();
    r.controller.setPurpose('explore');
    await r.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.evolve.mock.calls.at(-1)![0].step).toBe(4);
    r.controller.stop();
    r.controller.setPurpose('focus');
    await r.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.evolve.mock.calls.at(-1)![0].step).toBe(1);
  });
});
