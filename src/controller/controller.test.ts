import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePlayer, fakeLearner, fakeRelay } from '../../tests/e2e/harness.ts';
import type { SessionState } from '../shared/protocol.ts';
import { SessionController } from './index.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);
const texts = (m: { prompts: { text: string }[] }) => m.prompts.map((p) => p.text).sort();

async function boot(opts: { auto?: boolean } = {}) {
  const relay = fakeRelay(opts.auto ?? true);
  const player = new FakePlayer();
  const { learner, calls } = fakeLearner();
  const controller = new SessionController({ learner, player, createTransport: relay.create, seed: 1, config: { generationLatencyMs: 0 } });
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
    expect(relay.last.steers.length).toBeGreaterThan(5);
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

  it('restarts the silence timer on every vote', async () => {
    const { controller, calls } = await boot();
    await vi.advanceTimersByTimeAsync(30_000);
    controller.vote('up');
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
