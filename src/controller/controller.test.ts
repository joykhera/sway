import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePlayer, fakeLearner, fakeRelay } from '../../tests/e2e/harness.ts';
import type { SessionState, StreamLevels } from '../shared/protocol.ts';
import { SessionController } from './index.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);
const texts = (m: { prompts: { text: string }[] }) => m.prompts.map((p) => p.text).sort();

async function boot(opts: { auto?: boolean } = {}) {
  const relay = fakeRelay(opts.auto ?? true);
  const player = new FakePlayer();
  const { learner, calls } = fakeLearner();
  const controller = new SessionController({ learner, player, createTransport: relay.create, seed: 1, config: { generationLatencyMs: 0, voteRampMs: 8000 } });
  const states: SessionState[] = [];
  controller.subscribe((s) => states.push(s));
  await controller.start();
  await flush();
  return { relay, player, calls, controller, states };
}

describe('start', () => {
  it('inits audio, sends start with the initial prompts, configures the player on ready', async () => {
    const { relay, player, states } = await boot();
    expect(player.initialized).toBe(1);
    expect(relay.last.sent[0]).toEqual({ type: 'start', prompts: [{ text: 'ambient', weight: 1 }] });
    expect(player.configured).toHaveLength(1);
    expect(states.map((s) => s.status)).toEqual(['idle', 'connecting', 'playing']);
  });

  it('ignores a second start while running', async () => {
    const { relay, controller } = await boot();
    await controller.start();
    expect(relay.transports).toHaveLength(1);
  });

  it('reports an error and never connects if audio cannot start', async () => {
    const relay = fakeRelay();
    const player = new FakePlayer();
    player.initFails = new Error('blocked');
    const c = new SessionController({ learner: fakeLearner().learner, player, createTransport: relay.create });
    await c.start();
    const states: SessionState[] = [];
    c.subscribe((s) => states.push(s));
    expect(states[0]).toEqual({ status: 'error', lastError: 'Audio could not start: blocked' });
    expect(relay.transports).toHaveLength(0);
  });

  it('only feeds audio to the player after ready', async () => {
    const { relay, player } = await boot({ auto: false });
    relay.last.open();
    relay.last.audio();
    expect(player.chunks).toBe(0);
    relay.last.ready();
    relay.last.audio();
    expect(player.chunks).toBe(1);
  });
});

describe('transition ramp', () => {
  it('sends the first step immediately, then one per second, reaching the target in 8 steps', async () => {
    const { relay, controller } = await boot();
    controller.vote('down');
    const t = relay.last;
    expect(t.steers).toHaveLength(1);
    expect(t.steers[0]!.prompts).toEqual([
      { text: 'ambient', weight: 0.875 },
      { text: 'jazz', weight: 0.125 },
    ]);
    await vi.advanceTimersByTimeAsync(7000);
    expect(t.steers).toHaveLength(8);
    expect(t.steers.at(-1)!.prompts).toEqual([{ text: 'jazz', weight: 1 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.steers).toHaveLength(8); // ramp finished; silence sends nothing until the evolve timer
  });

  it('uses strictly increasing revisions', async () => {
    const { relay, controller } = await boot();
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(3000);
    controller.vote('up');
    await vi.advanceTimersByTimeAsync(10_000);
    const revs = relay.last.steers.map((s) => s.revision);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(revs.length);
    expect(relay.last.accepted).toEqual(revs); // the relay would accept every one
  });

  it('thumbs-up on the current target sends a steer without restarting the stream', async () => {
    const { relay, controller } = await boot();
    controller.vote('up');
    expect(relay.transports).toHaveLength(1);
    expect(relay.last.sent.filter((m) => m.type === 'start')).toHaveLength(1);
  });
});

describe('rapid votes', () => {
  it('supersedes the in-flight ramp: newest vote wins and old ramps stop sending', async () => {
    const { relay, controller, calls } = await boot();
    controller.vote('down'); // ambient -> jazz
    controller.vote('down'); // jazz -> electronic
    controller.vote('down'); // electronic -> classical
    expect(calls.vote.map((c) => Object.keys(c.currentTarget.features)[0])).toEqual(['ambient', 'jazz', 'electronic']);
    await vi.advanceTimersByTimeAsync(20_000);
    const steers = relay.last.steers;
    expect(steers).toHaveLength(3 + 7); // one immediate step per vote, then only the last ramp's 7 remaining
    expect(texts(steers.at(-1)!)).toEqual(['classical']);
    // after the third vote the superseded targets only ever fade out
    for (const name of ['jazz', 'electronic']) {
      const w = steers.slice(2).map((s) => s.prompts.find((p) => p.text === name)?.weight ?? 0);
      expect(w).toEqual([...w].sort((a, b) => b - a));
    }
  });

  it('never blocks a vote during a transition', async () => {
    const { relay, controller } = await boot();
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(500);
    const before = relay.last.steers.length;
    controller.vote('down');
    expect(relay.last.steers.length).toBe(before + 1);
  });
});

describe('audible estimate', () => {
  it('discounts what is still sitting in the playback buffer', async () => {
    const { relay, player, controller, calls } = await boot();
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(4000);
    player.bufferedMs = 3000;
    controller.vote('up');
    // heard now = what was sent ~3 s ago = step 2 of 8 (ambient .75 / jazz .25)
    expect(calls.vote[1]!.audible).toEqual({ ambient: 0.75, jazz: 0.25 });
    // The fake learner holds the same pending target: preserve the existing ramp.
    expect(relay.last.steers).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(3000);
    expect(relay.last.steers).toHaveLength(8);
  });

  it('with an empty buffer uses the most recent step', async () => {
    const { controller, calls } = await boot();
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(4000);
    controller.vote('up');
    expect(calls.vote[1]!.audible).toEqual({ ambient: 0.375, jazz: 0.625 });
  });

  it('falls back to the earliest known blend when the buffer exceeds the history', async () => {
    const { player, controller, calls } = await boot();
    player.bufferedMs = 60_000;
    controller.vote('down');
    expect(calls.vote[0]!.audible).toEqual({ ambient: 1 });
  });
});

describe('no vote', () => {
  it('evolves after 45 s without touching learner state', async () => {
    const { relay, controller, calls } = await boot();
    await vi.advanceTimersByTimeAsync(44_000);
    expect(calls.evolve).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.evolve).toBe(1);
    expect(calls.vote).toHaveLength(0); // processVote (the only score-updating path) never called
    expect(relay.last.steers.length).toBeGreaterThan(0);
    void controller;
  });

  it('restarts the variation timer when a vote changes direction', async () => {
    const { controller, calls } = await boot();
    await vi.advanceTimersByTimeAsync(30_000);
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(44_000);
    expect(calls.evolve).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.evolve).toBe(1);
  });
});

describe('votes before the stream is ready', () => {
  it('before the socket opens: start already carries the new target', async () => {
    const { relay, controller, calls } = await boot({ auto: false });
    controller.vote('down');
    expect(calls.vote).toHaveLength(1);
    relay.last.open();
    expect(relay.last.sent).toEqual([{ type: 'start', prompts: [{ text: 'jazz', weight: 1 }] }]);
  });

  it('after start was sent but before ready: ramps to the new target once ready', async () => {
    const { relay, controller } = await boot({ auto: false });
    relay.last.open();
    controller.vote('down');
    expect(relay.last.steers).toHaveLength(0); // steer before start/ready would be rejected
    relay.last.ready();
    await vi.advanceTimersByTimeAsync(8000);
    expect(texts(relay.last.steers.at(-1)!)).toEqual(['jazz']);
    // a repeated ready (upstream reconnect inside the relay) must not restart the ramp
    const n = relay.last.steers.length;
    relay.last.ready();
    await vi.advanceTimersByTimeAsync(2000);
    expect(relay.last.steers).toHaveLength(n);
  });
});

describe('reconnect', () => {
  it('restores learner state and starts from the latest target; revisions keep increasing', async () => {
    const { relay, controller, calls, states } = await boot();
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(2000);
    const first = relay.last;
    const stepsBefore = first.steers.length;
    const lastRev = first.steers.at(-1)!.revision;
    first.drop();
    expect(states.at(-1)!.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.steers).toHaveLength(stepsBefore); // old ramp stopped
    expect(first.closed).toBe(true);
    expect(relay.transports).toHaveLength(2);
    expect(relay.last.sent[0]).toEqual({ type: 'start', prompts: [{ text: 'jazz', weight: 1 }] });
    expect(states.at(-1)!.status).toBe('playing');
    controller.vote('down');
    expect(calls.vote.at(-1)!.currentTarget.features).toEqual({ jazz: 1 }); // learner retained across reconnect
    expect(relay.last.steers[0]!.revision).toBeGreaterThan(lastRev);
  });

  it('reconnects on retryable server errors', async () => {
    const { relay } = await boot();
    relay.last.serverMessage({ type: 'error', code: 'upstream_lost', message: 'Lost', retryable: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(relay.transports).toHaveLength(2);
  });

  it('gives up after the backoff schedule is exhausted', async () => {
    const { relay, states } = await boot({ auto: false });
    for (const wait of [1000, 2000, 4000, 8000, 8000]) {
      relay.last.drop();
      await vi.advanceTimersByTimeAsync(wait);
    }
    relay.last.drop();
    expect(states.at(-1)).toEqual({ status: 'error', lastError: 'Could not reconnect to the music service' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.transports).toHaveLength(6);
  });
});

describe('server errors', () => {
  it('non-retryable error stops with a message and does not reconnect', async () => {
    const { relay, player, states } = await boot();
    relay.last.serverMessage({ type: 'error', code: 'bad_message', message: 'nope', retryable: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)).toEqual({ status: 'error', lastError: 'nope' });
    expect(relay.transports).toHaveLength(1);
    expect(relay.last.closed).toBe(true);
    expect(player.closed).toBe(1);
  });

  it('prompt_filtered keeps playing and moves to another combination without learning', async () => {
    const { relay, calls, states } = await boot();
    relay.last.serverMessage({ type: 'error', code: 'prompt_filtered', message: 'x', retryable: true });
    expect(relay.transports).toHaveLength(1);
    expect(states.at(-1)!.status).toBe('playing');
    expect(calls.evolve).toBe(1);
    expect(calls.vote).toHaveLength(0);
    expect(relay.last.steers.length).toBeGreaterThan(0);
  });

  it('relay-side reconnecting status is surfaced, and playing restores it', async () => {
    const { relay, states } = await boot();
    relay.last.serverMessage({ type: 'status', state: 'reconnecting' });
    expect(states.at(-1)!.status).toBe('reconnecting');
    relay.last.serverMessage({ type: 'status', state: 'playing' });
    expect(states.at(-1)!.status).toBe('playing');
  });
});

describe('start/stop races', () => {
  it('a start superseded by stop and a second start connects exactly once and ends playing', async () => {
    const relay = fakeRelay();
    const player = new FakePlayer();
    const pending: (() => void)[] = [];
    player.initializeFromUserGesture = () => new Promise<void>((resolve) => pending.push(resolve));
    const c = new SessionController({ learner: fakeLearner().learner, player, createTransport: relay.create });
    const states: string[] = [];
    c.subscribe((s) => states.push(s.status));
    void c.start();
    c.stop();
    void c.start();
    pending.forEach((resolve) => resolve());
    await flush();
    expect(relay.transports).toHaveLength(1);
    expect(states.at(-1)).toBe('playing');
  });

  it('a stale audio-init failure cannot overwrite the new session state', async () => {
    const relay = fakeRelay();
    const player = new FakePlayer();
    const fails: ((e: Error) => void)[] = [];
    const oks: (() => void)[] = [];
    let n = 0;
    player.initializeFromUserGesture = () => new Promise<void>((resolve, reject) => (n++ === 0 ? fails.push(reject) : oks.push(resolve)));
    const c = new SessionController({ learner: fakeLearner().learner, player, createTransport: relay.create });
    const states: string[] = [];
    c.subscribe((s) => states.push(s.status));
    void c.start();
    c.stop();
    void c.start();
    fails[0]!(new Error('context closed'));
    await flush();
    expect(states.at(-1)).toBe('connecting'); // not 'error'
    oks[0]!();
    await flush();
    expect(states.at(-1)).toBe('playing');
  });
});

describe('stop', () => {
  it('cleans up the transport, player and every timer', async () => {
    const { relay, player, controller, states } = await boot();
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(2000);
    controller.stop();
    expect(relay.last.sent.at(-1)).toEqual({ type: 'stop' });
    expect(relay.last.closed).toBe(true);
    expect(player.closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(states.at(-1)!.status).toBe('stopped');
  });

  it('ignores votes when not running', async () => {
    const { relay, controller, calls } = await boot();
    controller.stop();
    const n = relay.last.sent.length;
    controller.vote('down');
    expect(calls.vote).toHaveLength(0);
    expect(relay.last.sent).toHaveLength(n);
  });

  it('can start again afterwards, keeping the session preferences', async () => {
    const { relay, controller } = await boot();
    controller.vote('down');
    controller.stop();
    await controller.start();
    await flush();
    expect(relay.transports).toHaveLength(2);
    expect(relay.last.sent[0]).toEqual({ type: 'start', prompts: [{ text: 'jazz', weight: 1 }] });
  });
});

describe('vote responsiveness (issue #9)', () => {
  it('ramps a vote over voteRampMs (~3 steps at 2500 ms) while variations keep rampMs', async () => {
    // default config: voteRampMs 2500, rampMs 8000, stepMs 1000
    const relay = fakeRelay();
    const player = new FakePlayer();
    const { learner } = fakeLearner();
    const c = new SessionController({ learner, player, createTransport: relay.create, seed: 1, config: { generationLatencyMs: 0, noVoteEvolveMs: 20000 } });
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    const t = relay.last;
    c.vote('down');
    await vi.advanceTimersByTimeAsync(2500);
    const voteSteers = t.steers.length;
    expect(voteSteers).toBe(3); // t=0.4, 0.8, 1.0
    expect(t.steers.at(-1)!.prompts).toEqual([{ text: 'jazz', weight: 1 }]);
    // scheduled variation still uses the 8 s ramp
    const evolveStart = t.steers.length;
    await vi.advanceTimersByTimeAsync(20000); // evolve fires inside this window
    await vi.advanceTimersByTimeAsync(8000);
    expect(t.steers.length - evolveStart).toBe(8);
    c.stop();
  });

  it('emits a decision from the learner\'s lastDecision on each vote', async () => {
    const relay = fakeRelay();
    const player = new FakePlayer();
    const { learner } = fakeLearner();
    const base = learner.processVote;
    learner.processVote = (args) => {
      const r = base(args);
      return {
        state: r.state,
        target: {
          ...r.target,
          lastDecision: { kind: 'redirect', reason: 'moving away from ambient', phase: 'listening', step: 1, prediction: 0, uncertainty: 1 },
        },
      };
    };
    const c = new SessionController({ learner, player, createTransport: relay.create, seed: 1 });
    const states: SessionState[] = [];
    c.subscribe((s) => states.push(s));
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.vote('down');
    expect(states.at(-1)!.decision).toMatchObject({ vote: 'down', kind: 'redirect', reason: 'moving away from ambient' });
    c.stop();
  });

  it('surfaces nowPlaying from the audible estimate, and steerProgress rises then clears', async () => {
    const relay = fakeRelay();
    const player = new FakePlayer();
    const { learner } = fakeLearner();
    const c = new SessionController({
      learner, player, createTransport: relay.create, seed: 1,
      config: { generationLatencyMs: 100, voteRampMs: 2000, stepMs: 500 },
    });
    const states: SessionState[] = [];
    const levels: StreamLevels[] = [];
    c.subscribe((s) => states.push(s));
    c.subscribeStats((l) => levels.push(l));
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.vote('down');
    relay.last.audio(); // a fresh generated block lands right after the vote
    // pending steer exists: progress > 0 for the voted side
    await vi.advanceTimersByTimeAsync(300);
    expect(levels.at(-1)!.steerVote).toBe('down');
    expect(levels.at(-1)!.steerProgress).toBeGreaterThan(0);
    expect(levels.at(-1)!.steerProgress).toBeLessThanOrEqual(0.97);
    // eta = 100 latency + 0 buffer + 1000 half-ramp ≈ 1100 ms; let it land + clear
    await vi.advanceTimersByTimeAsync(5000);
    expect(levels.at(-1)!.steerProgress).toBeNull();
    // nowPlaying eventually names the voted target (jazz) once it's audible
    const np = states.filter((s) => s.nowPlaying).at(-1)!.nowPlaying;
    expect(np?.genre).toBe('jazz');
    c.stop();
  });

  it('holds steerProgress under 1 past the ETA until a new generated block lands', async () => {
    const relay = fakeRelay();
    const player = new FakePlayer();
    const { learner } = fakeLearner();
    const c = new SessionController({
      learner, player, createTransport: relay.create, seed: 1,
      config: { generationLatencyMs: 100, voteRampMs: 2000, stepMs: 500, noVoteEvolveMs: 60000 },
    });
    const levels: StreamLevels[] = [];
    c.subscribeStats((l) => levels.push(l));
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    relay.last.audio(); // the pre-vote block already playing
    c.vote('down');
    // ETA = 100 latency + 0 buffer + 1000 half-ramp = 1100 ms; sail past it
    // with no new generated block: the fill parks just under full.
    await vi.advanceTimersByTimeAsync(2000);
    expect(levels.at(-1)!.steerVote).toBe('down');
    expect(levels.at(-1)!.steerProgress).toBeGreaterThanOrEqual(0.95);
    expect(levels.at(-1)!.steerProgress).toBeLessThan(1);
    // A fresh block lands — the next stats tick reports a full fill.
    relay.last.audio();
    await vi.advanceTimersByTimeAsync(150);
    expect(levels.at(-1)!.steerProgress).toBe(1);
    // ~600 ms hold, then it clears back to null.
    await vi.advanceTimersByTimeAsync(700);
    expect(levels.at(-1)!.steerProgress).toBeNull();
    expect(levels.at(-1)!.steerVote).toBeNull();
    c.stop();
  });
});

describe('taste and moments', () => {
  it('captures the heard prompts and steers back to them without a vote', async () => {
    const { relay, controller, calls } = await boot();
    const ambient = controller.captureMoment();
    expect(ambient?.prompts).toEqual([{ text: 'ambient', weight: 1 }]);
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(8000);
    expect(relay.last.steers.at(-1)!.prompts).toEqual([{ text: 'jazz', weight: 1 }]);
    controller.recallMoment(ambient!);
    await vi.advanceTimersByTimeAsync(8000);
    expect(relay.last.steers.at(-1)!.prompts).toEqual([{ text: 'ambient', weight: 1 }]);
    expect(calls.vote).toHaveLength(1);
  });

  it('has no moment to capture before playback', () => {
    const c = new SessionController({ learner: fakeLearner().learner, player: new FakePlayer(), createTransport: fakeRelay().create });
    expect(c.captureMoment()).toBeNull();
  });

  it('has no moment once the session has stopped', async () => {
    const { controller } = await boot();
    controller.stop();
    expect(controller.captureMoment()).toBeNull();
  });

  it('exposes a copy of the learned scores', async () => {
    const { controller } = await boot();
    controller.vote('up');
    const taste = controller.getTaste();
    expect(taste).toEqual({ ambient: 1 });
    taste.ambient = 99;
    expect(controller.getTaste()).toEqual({ ambient: 1 });
  });

  it('getAudibleFeatures estimates the heard blend without consuming it', async () => {
    const { player, controller, calls } = await boot();
    controller.vote('down');
    await vi.advanceTimersByTimeAsync(4000);
    player.bufferedMs = 3000;
    // Same estimate the vote path would make: what was sent ~3 s ago.
    expect(controller.getAudibleFeatures()).toEqual({ ambient: 0.75, jazz: 0.25 });
    // Read-only: the next vote attributes the same blend — the cursor was not consumed.
    controller.vote('up');
    expect(calls.vote[1]!.audible).toEqual({ ambient: 0.75, jazz: 0.25 });
  });

  it('recallMoment is a steer, not a vote: no decision, no learner call', async () => {
    const { controller, calls, states } = await boot();
    const ambient = controller.captureMoment();
    controller.recallMoment(ambient!);
    expect(calls.vote).toHaveLength(0);
    expect(states.at(-1)!.decision).toBeUndefined();
    controller.stop();
  });

  it('exposes the player analyser tap, or null when the player has none', async () => {
    const { controller, player } = await boot();
    expect(controller.getAnalyser()).toBeNull();
    const analyser = { fftSize: 2048 } as unknown as AnalyserNode;
    player.analyser = analyser;
    expect(controller.getAnalyser()).toBe(analyser);
    controller.stop();
  });
});

describe('nudge', () => {
  it('ramps toward the picked feature without voting', async () => {
    const relay = fakeRelay(true);
    const { learner, calls } = fakeLearner();
    learner.nudge = ({ target, feature }) => ({
      features: { ...target.features, [feature]: 1 },
      prompts: [...target.prompts, { text: feature, weight: 1 }],
    });
    const controller = new SessionController({ learner, player: new FakePlayer(), createTransport: relay.create, seed: 1, config: { generationLatencyMs: 0 } });
    await controller.start();
    await flush();
    controller.nudge('jazz');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(relay.last.steers.at(-1)!.prompts).toEqual([{ text: 'ambient', weight: 1 }, { text: 'jazz', weight: 1 }]);
    expect(calls.vote).toHaveLength(0);
  });

  it('does nothing without a learner nudge or before playback', async () => {
    const { relay, controller } = await boot();
    controller.nudge('jazz');
    expect(relay.last.steers).toHaveLength(0);
  });
});
