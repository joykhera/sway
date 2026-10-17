// Actual adaptive learner -> team controller -> WebSocket transport -> real relay.
// The provider is a paced mock; these tests make no Google calls.
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createRelay, type Relay } from '../../server/app.ts';
import { createStreamSlots } from '../../server/limits.ts';
import { createMockFactory } from '../../server/upstream/mock.ts';
import { adaptiveLearner, isAdaptiveState } from '../../src/learner/adaptive/adapter.ts';
import { SessionController } from '../../src/controller/index.ts';
import { createBrowserController } from '../../src/controller/browser.ts';
import type { Learner, LearnerState, SessionState, WeightedPrompt } from '../../src/shared/protocol.ts';
import { WebSocketTransport, type WebSocketLike } from '../../src/transport/websocket.ts';
import { FakePlayer } from './harness.ts';

let relay: Relay | undefined;
let controller: SessionController | undefined;
afterEach(async () => {
  controller?.stop();
  await relay?.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const until = async (predicate: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Adaptive integration condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function backend() {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  const started: WeightedPrompt[][] = [], steered: WeightedPrompt[][] = [];
  const slots = createStreamSlots(1);
  const mock = createMockFactory();
  relay = createRelay({ slots, createUpstream: events => {
    const up = mock(events), start = up.start.bind(up), steer = up.steer.bind(up);
    up.start = (p, c) => { started.push(p); return start(p, c); };
    up.steer = (p, c) => { steered.push(p); return steer(p, c); };
    return up;
  } });
  const url = `ws://127.0.0.1:${await relay.listen(0)}/api/music`;
  return { url, started, steered, slots };
}

it('carries full adaptive memory through feedback, novelty, restart and purpose change', async () => {
  const b = await backend();
  let latest: LearnerState | undefined;
  const evidenceWeights: number[] = [];
  let novelty = 0;
  const learner: Learner = {
    ...adaptiveLearner,
    createLearner: (...args) => (latest = adaptiveLearner.createLearner(...args)),
    processVote: args => {
      evidenceWeights.push(args.evidenceWeight ?? 1);
      const result = adaptiveLearner.processVote(args); latest = result.state; return result;
    },
    evolveNoVote: args => { novelty++; return adaptiveLearner.evolveNoVote(args); },
  };
  const player = new FakePlayer();
  const states: SessionState[] = [];
  controller = new SessionController({ learner, player, seed: 42,
    config: { rampMs: 120, stepMs: 40, noVoteEvolveMs: 700, generationLatencyMs: 0 },
    createTransport: () => new WebSocketTransport(b.url, url => new WebSocket(url) as unknown as WebSocketLike),
  });
  controller.setPurpose('focus');
  expect(isAdaptiveState(latest!)).toBe(true);
  expect((latest as { purpose?: string }).purpose).toBe('focus');
  controller.subscribe(state => states.push(state));
  await controller.start();
  controller.vote('up'); // Accepted action before any audio, but no preference evidence.
  expect(evidenceWeights).toEqual([0]);
  await until(() => states.at(-1)?.status === 'playing' && player.chunks > 3);
  controller.vote('down');
  await until(() => b.steered.length > 0 && JSON.stringify(b.steered.at(-1)) !== JSON.stringify(b.started[0]));
  await new Promise(resolve => setTimeout(resolve, 180));
  controller.vote('up');
  expect(evidenceWeights.at(-1)).toBe(1);
  expect(isAdaptiveState(latest!)).toBe(true);
  const learned = JSON.stringify(latest);
  const beforeNovelty = novelty;
  await until(() => novelty > beforeNovelty);
  expect(JSON.stringify(latest)).toBe(learned); // Freshness after a Like adds no reward.
  expect(latest?.votes).toBe(3);
  controller.stop();
  await until(() => b.slots.inUse === 0 && relay!.sessions.size === 0);
  controller.setPurpose('focus');
  expect(JSON.stringify(latest)).toBe(learned);
  await controller.start();
  await until(() => b.started.length === 2 && states.at(-1)?.status === 'playing');
  expect(JSON.stringify(latest)).toBe(learned);
  controller.stop();
  controller.setPurpose('energy');
  expect(latest?.votes).toBe(0);
  expect((latest as { purpose?: string }).purpose).toBe('energy');
});

it('production browser factory uses adaptive hold behavior with the existing real relay', async () => {
  const b = await backend();
  vi.stubGlobal('WebSocket', WebSocket);
  const player = new FakePlayer();
  const states: SessionState[] = [];
  controller = createBrowserController({ player, url: b.url, seed: 42, purpose: 'focus',
    // Leave room for paced PCM to arrive before the unchanged Like. Freshness
    // keeps its original deadline, rather than restarting at the click.
    config: { rampMs: 120, stepMs: 40, noVoteEvolveMs: 700, generationLatencyMs: 0 },
  });
  controller.subscribe(state => states.push(state));
  await controller.start();
  await until(() => states.at(-1)?.status === 'playing' && player.chunks > 2);
  controller.vote('up');
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(b.steered).toHaveLength(0); // Like holds instead of baseline feature amplification.
  await until(() => b.steered.length > 0);
  expect(JSON.stringify(b.steered.at(-1))).not.toBe(JSON.stringify(b.started[0]));
  controller.stop();
  await until(() => b.slots.inUse === 0);
});
