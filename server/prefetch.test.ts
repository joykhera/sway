import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../src/shared/protocol.ts';
import { createStreamSlots } from './limits.ts';
import { Session } from './session.ts';
import type { ClientSocket } from './session.ts';
import type { MusicUpstream, UpstreamEvents, UpstreamFactory } from './upstream/types.ts';

const prompts = [{ text: 'Soft piano', weight: 1 }];
const rate = 48000;
class ControlledUpstream implements MusicUpstream {
  start = vi.fn(async () => {});
  steer = vi.fn(async () => {});
  pause = vi.fn(() => {});
  resume = vi.fn(() => {});
  close = vi.fn(() => {});
  constructor(readonly events: UpstreamEvents) {}
  emit(ms: number, marker = 1, sampleRateHz = rate) {
    this.events.onAudio(Buffer.alloc(Math.round(ms * sampleRateHz * 4 / 1000), marker), { sampleRateHz, channels: 2 });
  }
}

class Socket implements ClientSocket {
  readyState = 1;
  messages: ServerMessage[] = [];
  audio: Buffer[] = [];
  send(data: string | Buffer) {
    if (typeof data === 'string') this.messages.push(JSON.parse(data) as ServerMessage);
    else this.audio.push(data);
  }
  get errors() { return this.messages.filter(message => message.type === 'error'); }
}

function harness(maxSlots = 3, factoryOverride?: UpstreamFactory) {
  const slots = createStreamSlots(maxSlots);
  const ups: ControlledUpstream[] = [];
  const factory: UpstreamFactory = factoryOverride ?? (events => {
    const up = new ControlledUpstream(events);
    ups.push(up);
    return up;
  });
  const client = () => {
    const socket = new Socket();
    const session = new Session(socket, factory, slots);
    return { session, socket };
  };
  return { slots, ups, client };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded speculative relay session', () => {
  it('pauses after complete emitted chunks reach the requested duration and keeps in-flight tail', () => {
    const h = harness();
    const { session, socket } = h.client();
    session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    const up = h.ups[0]!;
    up.emit(2000, 1);
    expect(up.pause).not.toHaveBeenCalled();
    up.emit(2000, 2);
    expect(session.state).toBe('paused');
    expect(up.pause).toHaveBeenCalledOnce();
    expect(h.slots.inUse).toBe(1);
    expect(socket.messages).toContainEqual({ type: 'ready', audio: { format: 'pcm_s16le', sampleRateHz: rate, channels: 2 }, prefetch: true });
    expect(socket.messages.at(-1)).toEqual({ type: 'status', state: 'paused' });
    up.emit(2000, 3); // PAUSE is not an acknowledgment; already generated tail must survive.
    expect(socket.audio.map(chunk => chunk[0])).toEqual([1, 2, 3]);
    expect(up.pause).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('resumes the same upstream once, preserving ordered PCM and removing all speculative limits', async () => {
    const h = harness();
    const { session, socket } = h.client();
    session.handle({ type: 'start', prompts, prefetchMs: 4000 });
    const up = h.ups[0]!;
    up.emit(4000, 1);
    up.emit(1000, 2);
    session.handle({ type: 'resume' });
    session.handle({ type: 'resume' });
    expect(up.resume).toHaveBeenCalledOnce();
    expect(up.start).toHaveBeenCalledOnce();
    expect(h.ups).toHaveLength(1);
    expect(session.state).toBe('playing');
    up.emit(20_000, 3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.audio.map(chunk => chunk[0])).toEqual([1, 2, 3]);
    expect(socket.errors).toEqual([]);
    expect(up.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    session.dispose();
  });

  it('rejects a provider that ignores pause at the hard bound instead of silently dropping audio', async () => {
    const h = harness();
    const { session, socket } = h.client();
    session.handle({ type: 'start', prompts, prefetchMs: 4000 });
    const up = h.ups[0]!;
    up.emit(4000, 1);
    up.emit(8000, 2); // Exactly 12 s is accepted, including in-flight tail.
    up.emit(1, 3); // The whole offending chunk is rejected and the candidate invalidated.
    expect(socket.audio.map(chunk => chunk[0])).toEqual([1, 2]);
    expect(socket.errors.at(-1)).toMatchObject({ retryable: false, message: expect.stringContaining('audio limit') });
    expect(up.close).toHaveBeenCalledOnce();
    expect(h.slots.inUse).toBe(0);
    expect(session.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.ups).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires a paused candidate after 60 seconds and releases its slot', () => {
    const h = harness();
    const { session, socket } = h.client();
    session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    const up = h.ups[0]!;
    up.emit(3000);
    vi.advanceTimersByTime(59_999);
    expect(up.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(up.close).toHaveBeenCalledOnce();
    expect(socket.errors.at(-1)?.message).toContain('Paused prefetch expired');
    expect(h.slots.inUse).toBe(0);
  });

  it('bounds first-audio setup and total lifetime independently of paused expiry', () => {
    const h = harness();
    const stalled = h.client();
    stalled.session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    vi.advanceTimersByTime(15_000);
    expect(stalled.socket.errors.at(-1)?.message).toContain('setup deadline');
    expect(h.slots.inUse).toBe(0);
    const slow = h.client();
    slow.session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    const up = h.ups[1]!;
    vi.advanceTimersByTime(14_000);
    up.emit(1000);
    vi.advanceTimersByTime(16_000);
    up.emit(2000); // Paused TTL would expire at +90 s, but total lifetime is only 75 s.
    vi.advanceTimersByTime(44_999);
    expect(up.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(slow.socket.errors.at(-1)?.message).toContain('lifetime expired');
    expect(h.slots.inUse).toBe(0);
  });

  it('ignores stale audio and asynchronous setup rejection after stop and replacement', async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    const ups: ControlledUpstream[] = [];
    const h = harness(1, events => {
      const up = new ControlledUpstream(events);
      if (ups.length === 0) up.start.mockImplementation(() => new Promise<void>((_, reject) => { rejectStart = reject; }));
      ups.push(up);
      return up;
    });
    const { session, socket } = h.client();
    session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    session.handle({ type: 'stop' });
    session.handle({ type: 'start', prompts });
    ups[1]!.emit(1000, 2);
    ups[0]!.emit(4000, 1);
    rejectStart!(new Error('late failed setup'));
    await vi.advanceTimersByTimeAsync(80_000);
    expect(socket.audio.map(chunk => chunk[0])).toEqual([2]);
    expect(socket.errors).toEqual([]);
    expect(session.state).toBe('playing');
    expect(h.slots.inUse).toBe(1);
    expect(ups[0]!.close).toHaveBeenCalledOnce();
    session.dispose();
    session.dispose();
    expect(h.slots.inUse).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry lost or filtered speculative upstreams', async () => {
    for (const filtered of [false, true]) {
      const h = harness();
      const { session, socket } = h.client();
      session.handle({ type: 'start', prompts, prefetchMs: 3000 });
      h.ups[0]!.emit(3000);
      if (filtered) h.ups[0]!.events.onFiltered({ text: 'blocked' });
      else h.ups[0]!.events.onClosed('lost');
      await vi.advanceTimersByTimeAsync(80_000);
      expect(h.ups).toHaveLength(1);
      expect(socket.errors).toHaveLength(1);
      expect(socket.errors[0]?.retryable).toBe(false);
      expect(h.slots.inUse).toBe(0);
    }
  });

  it('releases a failed setup without retries for both rejected and synchronously thrown starts', async () => {
    for (const synchronous of [false, true]) {
      const created: ControlledUpstream[] = [];
      const h = harness(1, events => {
        const up = new ControlledUpstream(events);
        up.start.mockImplementation(() => {
          if (synchronous) throw new Error('setup failed synchronously');
          return Promise.reject(new Error('setup rejected'));
        });
        created.push(up);
        return up;
      });
      const { session, socket } = h.client();
      session.handle({ type: 'start', prompts, prefetchMs: 3000 });
      await vi.advanceTimersByTimeAsync(80_000);
      expect(created).toHaveLength(1);
      expect(created[0]!.close).toHaveBeenCalledOnce();
      expect(socket.errors).toHaveLength(1);
      expect(socket.errors[0]?.retryable).toBe(false);
      expect(h.slots.inUse).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('counts active and paused sessions against the same capacity and frees each slot once', () => {
    const h = harness(3);
    const clients = Array.from({ length: 4 }, () => h.client());
    clients[0]!.session.handle({ type: 'start', prompts });
    clients[1]!.session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    clients[2]!.session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    h.ups[0]!.emit(1000);
    h.ups[1]!.emit(3000);
    h.ups[2]!.emit(3000);
    clients[3]!.session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    expect(clients[3]!.socket.errors.at(-1)?.code).toBe('capacity');
    expect(h.slots.inUse).toBe(3);
    clients[1]!.session.handle({ type: 'stop' });
    clients[3]!.session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    expect(h.slots.inUse).toBe(3);
    expect(h.ups).toHaveLength(4);
    for (const client of clients) { client.session.dispose(); client.session.dispose(); }
    expect(h.slots.inUse).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails unsupported prefetch closed but leaves ordinary upstreams compatible', () => {
    const starts = vi.fn(async () => {});
    const closes = vi.fn();
    const h = harness(1, () => ({ start: starts, steer: async () => {}, close: closes }));
    const { session, socket } = h.client();
    session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    expect(starts).not.toHaveBeenCalled();
    expect(closes).toHaveBeenCalledOnce();
    expect(socket.errors.at(-1)?.retryable).toBe(false);
    expect(h.slots.inUse).toBe(0);
    session.handle({ type: 'start', prompts });
    expect(starts).toHaveBeenCalledOnce();
    expect(session.state).toBe('connecting');
    session.dispose();
  });

  it('requires resume before steering a cached stream and rejects resume before audio is ready', () => {
    const h = harness();
    const { session, socket } = h.client();
    session.handle({ type: 'resume' });
    session.handle({ type: 'start', prompts, prefetchMs: 3000 });
    session.handle({ type: 'resume' });
    h.ups[0]!.emit(3000);
    session.handle({ type: 'steer', revision: 8, prompts });
    expect(socket.errors.map(error => error.code)).toEqual(['bad_state', 'bad_state', 'bad_state']);
    expect(h.ups[0]!.steer).not.toHaveBeenCalled();
    session.handle({ type: 'resume' });
    session.handle({ type: 'steer', revision: 1, prompts });
    expect(h.ups[0]!.steer).toHaveBeenCalledOnce();
    session.dispose();
  });
});
