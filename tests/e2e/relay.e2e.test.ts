// Controller + WebSocketTransport against A's real relay in mock mode (no Google calls).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createRelay, type Relay } from '../../server/app.ts';
import { createStreamSlots, type StreamSlots } from '../../server/limits.ts';
import { createMockFactory } from '../../server/upstream/mock.ts';
import type { MusicUpstream, UpstreamFactory } from '../../server/upstream/types.ts';
import { SessionController } from '../../src/controller/index.ts';
import type { SessionState, WeightedPrompt } from '../../src/shared/protocol.ts';
import { WebSocketTransport, type WebSocketLike } from '../../src/transport/websocket.ts';
import { FakePlayer, fakeLearner } from './harness.ts';

let relay: Relay;
let slots: StreamSlots;
let url: string;
let steered: WeightedPrompt[][];
let started: WeightedPrompt[][];
let sockets: WebSocket[];
let controller: SessionController | undefined;

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  steered = [];
  started = [];
  sockets = [];
  slots = createStreamSlots(5);
  const mock = createMockFactory();
  const spy: UpstreamFactory = (events) => {
    const up: MusicUpstream = mock(events);
    const start = up.start.bind(up);
    const steer = up.steer.bind(up);
    up.start = (p, c) => (started.push(p), start(p, c));
    up.steer = (p, c) => (steered.push(p), steer(p, c));
    return up;
  };
  relay = createRelay({ createUpstream: spy, slots });
  url = `ws://127.0.0.1:${await relay.listen(0)}/api/music`;
});

afterEach(async () => {
  controller?.stop();
  await relay.close();
  vi.restoreAllMocks();
});

function make(config = {}) {
  const player = new FakePlayer();
  const { learner, calls } = fakeLearner();
  const states: SessionState[] = [];
  controller = new SessionController({
    learner,
    player,
    config: { stepMs: 250, rampMs: 1000, reconnectBackoffMs: [50, 50], ...config },
    createTransport: () =>
      new WebSocketTransport(url, (u) => {
        const ws = new WebSocket(u);
        sockets.push(ws);
        return ws as unknown as WebSocketLike;
      }),
  });
  controller.subscribe((s) => states.push(s));
  return { controller, player, calls, states };
}

const lastPrompts = () => steered.at(-1)!.map((p) => p.text).sort();

describe('controller against the relay', () => {
  it('streams audio, steers on thumbs, and the relay applies the newest vote', async () => {
    const { controller, player, states } = make();
    await controller.start();
    await until(() => states.at(-1)!.status === 'playing');
    expect(player.configured[0]).toEqual({ format: 'pcm_s16le', sampleRateHz: 48000, channels: 2 });
    await until(() => player.chunks > 3);
    expect(started[0]).toEqual([{ text: 'ambient', weight: 1 }]);

    controller.vote('down');
    controller.vote('down');
    controller.vote('down'); // ambient -> jazz -> electronic -> classical, all within one tick
    await until(() => steered.length > 0 && lastPrompts().join() === 'classical', 4000);
    expect(slots.inUse).toBe(1);
  });

  it('releases the stream slot and closes the session on stop', async () => {
    const { controller, states } = make();
    await controller.start();
    await until(() => states.at(-1)!.status === 'playing');
    controller.stop();
    await until(() => slots.inUse === 0 && relay.sessions.size === 0);
  });

  it('reconnects after the socket drops and keeps streaming from the latest target', async () => {
    const { controller, player, states } = make();
    await controller.start();
    await until(() => states.at(-1)!.status === 'playing');
    controller.vote('down');
    sockets[0]!.terminate();
    await until(() => states.some((s) => s.status === 'reconnecting'));
    await until(() => started.length === 2 && states.at(-1)!.status === 'playing');
    expect(started[1]).toEqual([{ text: 'jazz', weight: 1 }]);
    const before = player.chunks;
    await until(() => player.chunks > before + 2);
    await until(() => slots.inUse === 1); // old session released, new one holds the slot
  });

  it('shows a retryable error from a full relay and recovers when capacity returns', async () => {
    const taken = [1, 2, 3, 4, 5].map(() => slots.tryAcquire());
    expect(taken.every(Boolean)).toBe(true);
    const { controller, states } = make({ reconnectBackoffMs: [100, 100, 100, 100, 100] });
    await controller.start();
    await until(() => states.some((s) => s.status === 'reconnecting'));
    slots.release();
    await until(() => states.at(-1)!.status === 'playing', 8000);
  });
});
