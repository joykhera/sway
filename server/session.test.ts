import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, StreamConfig, WeightedPrompt } from '../src/shared/protocol.ts';
import { createStreamSlots } from './limits.ts';
import type { StreamSlots } from './limits.ts';
import { Session } from './session.ts';
import type { ClientSocket } from './session.ts';
import type { MusicUpstream, UpstreamEvents, UpstreamFactory } from './upstream/types.ts';

class FakeUpstream implements MusicUpstream {
  started: { prompts: WeightedPrompt[]; config: StreamConfig } | undefined;
  steers: { prompts: WeightedPrompt[]; config?: StreamConfig }[] = [];
  closed = false;
  failStart = false;
  constructor(readonly events: UpstreamEvents) {}
  async start(prompts: WeightedPrompt[], config: StreamConfig) {
    this.started = { prompts, config };
    if (this.failStart) throw new Error('nope');
  }
  async steer(prompts: WeightedPrompt[], config?: StreamConfig) {
    this.steers.push(config ? { prompts, config } : { prompts });
  }
  close() {
    this.closed = true;
  }
  audio(channels = 2) {
    this.events.onAudio(Buffer.alloc(16), { sampleRateHz: 48000, channels });
  }
}

class FakeSocket implements ClientSocket {
  readyState = 1;
  json: ServerMessage[] = [];
  binary: Buffer[] = [];
  send(data: string | Buffer, opts?: { binary?: boolean }) {
    if (typeof data === 'string') this.json.push(JSON.parse(data) as ServerMessage);
    else {
      expect(opts?.binary).toBe(true);
      this.binary.push(data);
    }
  }
  types() {
    return this.json.map((m) => (m.type === 'status' ? `status:${m.state}` : m.type === 'error' ? `error:${m.code}` : m.type));
  }
}

const P = (text: string, weight = 1): WeightedPrompt[] => [{ text, weight }];

let ups: FakeUpstream[];
let failNext: number;
let slots: StreamSlots;
const factory: UpstreamFactory = (events) => {
  const up = new FakeUpstream(events);
  if (failNext > 0) {
    failNext--;
    up.failStart = true;
  }
  ups.push(up);
  return up;
};
const last = () => ups[ups.length - 1]!;

function setup() {
  const socket = new FakeSocket();
  const session = new Session(socket, factory, slots);
  return { socket, session };
}

function playing() {
  const s = setup();
  s.session.handle({ type: 'start', prompts: P('a') });
  last().audio();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ups = [];
  failNext = 0;
  slots = createStreamSlots(5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session', () => {
  it('start → connecting, ready + playing on first audio, then forwards binary', () => {
    const { socket, session } = setup();
    session.handle({ type: 'start', prompts: P('a'), config: { density: 0.4 } });
    expect(socket.types()).toEqual(['status:connecting']);
    expect(last().started).toEqual({ prompts: P('a'), config: { density: 0.4 } });
    last().audio();
    last().audio();
    expect(socket.types()).toEqual(['status:connecting', 'ready', 'status:playing']);
    expect(socket.json[1]).toEqual({ type: 'ready', audio: { format: 'pcm_s16le', sampleRateHz: 48000, channels: 2 } });
    expect(socket.binary).toHaveLength(2);
    expect(session.state).toBe('playing');
  });

  it('rejects steer before start and a second start', () => {
    const { socket, session } = setup();
    session.handle({ type: 'steer', revision: 1, prompts: P('b') });
    expect(socket.types()).toEqual(['error:bad_state']);
    session.handle({ type: 'start', prompts: P('a') });
    session.handle({ type: 'start', prompts: P('a') });
    expect(socket.types()).toEqual(['error:bad_state', 'status:connecting', 'error:bad_state']);
    expect(ups).toHaveLength(1);
  });

  it('drops stale revisions', () => {
    const { session } = playing();
    session.handle({ type: 'steer', revision: 5, prompts: P('five') });
    vi.advanceTimersByTime(1000);
    session.handle({ type: 'steer', revision: 5, prompts: P('dup') });
    session.handle({ type: 'steer', revision: 3, prompts: P('old') });
    vi.advanceTimersByTime(1000);
    expect(last().steers).toEqual([{ prompts: P('five') }]);
  });

  it('coalesces steers to one per 200 ms, newest wins', () => {
    const { session } = playing();
    session.handle({ type: 'steer', revision: 1, prompts: P('r1') });
    session.handle({ type: 'steer', revision: 2, prompts: P('r2') });
    session.handle({ type: 'steer', revision: 3, prompts: P('r3'), config: { brightness: 0.9 } });
    expect(last().steers).toEqual([{ prompts: P('r1') }]);
    vi.advanceTimersByTime(199);
    expect(last().steers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(last().steers).toEqual([{ prompts: P('r1') }, { prompts: P('r3'), config: { brightness: 0.9 } }]);
  });

  it('keeps only the latest pending steer while connecting and applies it after ready', () => {
    const { session } = setup();
    session.handle({ type: 'start', prompts: P('a') });
    session.handle({ type: 'steer', revision: 1, prompts: P('r1') });
    session.handle({ type: 'steer', revision: 2, prompts: P('r2') });
    vi.advanceTimersByTime(1000);
    expect(last().steers).toEqual([]);
    last().audio();
    expect(last().steers).toEqual([{ prompts: P('r2') }]);
  });

  it('sends the full merged config on config steers', () => {
    const { session } = setup();
    session.handle({ type: 'start', prompts: P('a'), config: { density: 0.2 } });
    last().audio();
    session.handle({ type: 'steer', revision: 1, prompts: P('a'), config: { brightness: 0.7 } });
    expect(last().steers).toEqual([{ prompts: P('a'), config: { density: 0.2, brightness: 0.7 } }]);
  });

  it('reconnects after an upstream drop with the latest prompts and sends a fresh ready', () => {
    const { socket, session } = playing();
    session.handle({ type: 'steer', revision: 1, prompts: P('latest') });
    const first = last();
    first.events.onClosed('code=1000');
    expect(first.closed).toBe(true);
    expect(socket.types().at(-1)).toBe('status:reconnecting');
    expect(session.state).toBe('reconnecting');
    session.handle({ type: 'steer', revision: 2, prompts: P('during') });
    vi.advanceTimersByTime(500);
    expect(ups).toHaveLength(2);
    expect(last().started?.prompts).toEqual(P('during'));
    first.audio(); // stale upstream is ignored
    expect(socket.binary).toHaveLength(1);
    last().audio();
    expect(socket.types().slice(-2)).toEqual(['ready', 'status:playing']);
    expect(session.state).toBe('playing');
    expect(slots.inUse).toBe(1);
  });

  it('gives up after 3 failed reconnects with upstream_lost', async () => {
    const { socket, session } = playing();
    failNext = 3;
    last().events.onClosed('dropped');
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
    expect(ups).toHaveLength(4);
    expect(socket.types().at(-1)).toBe('error:upstream_lost');
    const err = socket.json.at(-1);
    expect(err?.type === 'error' && err.retryable).toBe(true);
    expect(session.state).toBe('idle');
    expect(slots.inUse).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ups).toHaveLength(4);
    session.handle({ type: 'start', prompts: P('again') });
    expect(session.state).toBe('connecting');
  });

  it('reports upstream_unavailable when the first connect fails', async () => {
    failNext = 1;
    const { socket, session } = setup();
    session.handle({ type: 'start', prompts: P('a') });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.types()).toEqual(['status:connecting', 'error:upstream_unavailable']);
    expect(session.state).toBe('idle');
    expect(slots.inUse).toBe(0);
  });

  it('releases only the failed stream and never retries a terminal provider close', async () => {
    const failed = playing();
    const up = last();
    const unaffected = playing();
    up.events.onClosed('terminal provider failure', false);
    expect(failed.socket.json.at(-1)).toMatchObject({ type: 'error', code: 'upstream_lost', retryable: false });
    expect(up.closed).toBe(true);
    expect(failed.session.state).toBe('idle');
    expect(unaffected.session.state).toBe('playing');
    expect(last().closed).toBe(false);
    expect(slots.inUse).toBe(1);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(ups).toHaveLength(2);
    unaffected.session.dispose();
    expect(slots.inUse).toBe(0);
  });

  it('reports a terminal setup close as nonretryable upstream_unavailable', async () => {
    const { session, socket } = setup();
    session.handle({ type: 'start', prompts: P('a') });
    last().events.onClosed('terminal setup failure', false);
    expect(socket.json.at(-1)).toMatchObject({ type: 'error', code: 'upstream_unavailable', retryable: false });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(ups).toHaveLength(1);
    expect(slots.inUse).toBe(0);
  });

  it('turns filtered prompts into a retryable error and keeps streaming', () => {
    const { socket, session } = playing();
    last().events.onFiltered({ text: 'bad', reason: 'x' });
    expect(socket.json.at(-1)).toMatchObject({ type: 'error', code: 'prompt_filtered', retryable: true });
    expect(session.state).toBe('playing');
    expect(last().closed).toBe(false);
  });

  it('rejects non-stereo audio with internal', () => {
    const { socket, session } = setup();
    session.handle({ type: 'start', prompts: P('a') });
    last().audio(1);
    expect(socket.types()).toContain('error:internal');
    expect(socket.binary).toHaveLength(0);
    expect(last().closed).toBe(true);
    expect(session.state).toBe('idle');
  });

  it('stop closes upstream, reports stopped, and allows a new start', () => {
    const { socket, session } = playing();
    session.handle({ type: 'stop' });
    expect(ups[0]!.closed).toBe(true);
    expect(socket.types().at(-1)).toBe('status:stopped');
    expect(slots.inUse).toBe(0);
    session.handle({ type: 'start', prompts: P('b') });
    expect(ups).toHaveLength(2);
  });

  it('dispose closes upstream, clears timers and releases the slot (idempotent)', () => {
    const { session } = playing();
    session.handle({ type: 'steer', revision: 1, prompts: P('r1') });
    session.handle({ type: 'steer', revision: 2, prompts: P('r2') }); // pending timer
    session.dispose();
    session.dispose();
    expect(last().closed).toBe(true);
    expect(slots.inUse).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    session.handle({ type: 'start', prompts: P('x') });
    expect(ups).toHaveLength(1);
  });

  it('dispose during reconnect backoff cancels the retry', () => {
    const { session } = playing();
    last().events.onClosed('dropped');
    session.dispose();
    vi.advanceTimersByTime(10_000);
    expect(ups).toHaveLength(1);
    expect(slots.inUse).toBe(0);
  });

  it('returns capacity once MAX_STREAMS are in use', () => {
    slots = createStreamSlots(5);
    const sessions = Array.from({ length: 5 }, () => playing());
    const extra = setup();
    extra.session.handle({ type: 'start', prompts: P('a') });
    expect(extra.socket.json).toEqual([
      { type: 'error', code: 'capacity', message: expect.any(String), retryable: true },
    ]);
    expect(extra.session.state).toBe('idle');
    sessions[0]!.session.dispose();
    extra.session.handle({ type: 'start', prompts: P('a') });
    expect(extra.session.state).toBe('connecting');
  });
});
