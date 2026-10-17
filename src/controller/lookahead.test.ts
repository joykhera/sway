import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioFormat, ClientMessage, ServerMessage, Target } from '../shared/protocol.ts';
import type { MusicTransport, TransportHandlers } from '../transport/types.ts';
import { LOOKAHEAD_LIMITS as L, LookaheadPool, type LookaheadOptions } from './lookahead.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const targets = {
  up: { features: { ambient: 0.4, piano: 0.3 }, prompts: [{ text: 'ambient', weight: 0.8 }, { text: 'piano', weight: 0.6 }] },
  down: { features: { jazz: 0.4, guitar: 0.3 }, prompts: [{ text: 'jazz', weight: 0.8 }, { text: 'guitar', weight: 0.6 }] },
} satisfies Record<'up' | 'down', Target>;
const audio = (rate = 48000): AudioFormat => ({ format: 'pcm_s16le', channels: 2, sampleRateHz: rate });
const pcm = (ms: number, rate = 48000) => new ArrayBuffer(ms * rate / 1000 * 4);
const handlers = (): TransportHandlers => ({ onOpen: vi.fn(), onMessage: vi.fn(), onAudio: vi.fn(), onClose: vi.fn() });

class FakeTransport implements MusicTransport {
  handlers?: TransportHandlers;
  sent: ClientMessage[] = [];
  connections = 0;
  closes = 0;
  onConnect?: (transport: FakeTransport) => void;
  onSend?: (message: ClientMessage) => void;
  connect(handlers: TransportHandlers) { this.connections++; this.handlers = handlers; this.onConnect?.(this); }
  send(message: ClientMessage) { this.sent.push(structuredClone(message)); this.onSend?.(message); }
  close() { this.closes++; }
  open() { this.handlers!.onOpen(); }
  message(message: ServerMessage) { this.handlers!.onMessage(message); }
  ready(rate = 48000) { this.message({ type: 'ready', audio: audio(rate), prefetch: true }); }
  chunk(bytes: ArrayBuffer) { this.handlers!.onAudio(bytes); }
  paused() { this.message({ type: 'status', state: 'paused' }); }
  finish(ms = 6000, rate = 48000) { this.ready(rate); this.chunk(pcm(ms, rate)); this.paused(); }
}
function rig(options: LookaheadOptions = {}, setup?: (transport: FakeTransport) => void) {
  const transports: FakeTransport[] = [];
  const log = vi.fn();
  const pool = new LookaheadPool(() => {
    const transport = new FakeTransport();
    setup?.(transport);
    transports.push(transport);
    return transport;
  }, { log, ...options });
  return { pool, transports, log };
}

// Real sockets/providers are never opened by these fakes.
describe('LookaheadPool', () => {
  it('starts exactly two independent 6-second candidates, safely handling fully synchronous connect callbacks', () => {
    const { pool, transports } = rig({}, transport => {
      transport.onConnect = current => current.open();
      transport.onSend = message => { if (message.type === 'start') transport.finish(); };
    });
    pool.prepare(targets);
    expect(transports).toHaveLength(2);
    expect(transports[0]!.sent).toEqual([{ type: 'start', prompts: targets.up.prompts, prefetchMs: 6000 }]);
    expect(transports[1]!.sent).toEqual([{ type: 'start', prompts: targets.down.prompts, prefetchMs: 6000 }]);
    expect(transports.every(transport => transport.connections === 1)).toBe(true);
    const selected = pool.take('down', targets.down)!;
    expect(selected.audio).toEqual(audio());
    expect(selected.chunks[0]!.byteLength).toBe(pcm(6000).byteLength);
    expect(transports[0]!.closes).toBe(1);
    expect(transports[1]!.closes).toBe(0);
    selected.dispose();
    expect(transports[1]!.closes).toBe(1);
  });

  it('sends start only once when an injected transport repeats its open callback', () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const transport = transports[0]!;
    transport.open(); transport.open();
    transport.finish();
    const selected = pool.take('up', targets.up)!;
    transport.open();
    expect(transport.sent.filter(message => message.type === 'start')).toHaveLength(1);
    selected.dispose();
  });

  it.each([44100, 48000])('requires both pause and at least 3 seconds of valid %i Hz PCM', rate => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const transport = transports[0]!;
    transport.ready(rate);
    transport.chunk(pcm(2000, rate));
    transport.paused(); // The final in-flight PCM can arrive after paused.
    expect(pool.take('up', targets.up)).toBeUndefined();
    transport.chunk(pcm(1000, rate));
    expect(pool.take('up', targets.up)?.audio.sampleRateHz).toBe(rate);
  });

  it('retains all in-flight tail after pause and copies both incoming PCM and the take snapshot', () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const transport = transports[0]!;
    transport.ready();
    const first = pcm(4000);
    new Uint8Array(first)[0] = 13;
    transport.chunk(first);
    transport.paused();
    transport.chunk(pcm(2000));
    const selected = pool.take('up', targets.up)!;
    new Uint8Array(first)[0] = 99;
    expect(new Uint8Array(selected.chunks[0]!)[0]).toBe(13);
    expect(selected.chunks).toHaveLength(2);
    transport.chunk(pcm(2000));
    expect(selected.chunks).toHaveLength(2); // Stable snapshot; the late chunk goes to forwarding.
    const forward = handlers();
    selected.activate(forward);
    expect(forward.onAudio).toHaveBeenCalledTimes(1);
    expect((vi.mocked(forward.onAudio).mock.calls[0]![0]).byteLength).toBe(pcm(2000).byteLength);
    expect(transport.sent.at(-1)).toEqual({ type: 'resume' });
    expect(forward.onOpen).not.toHaveBeenCalled();
    expect(forward.onMessage).not.toHaveBeenCalled();
  });

  it('routes future events to the promoted controller without reconnecting and ignores repeated open/activate', async () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const transport = transports[1]!;
    transport.finish();
    const selected = pool.take('down', targets.down)!;
    const forward = handlers();
    transport.onSend = message => {
      if (message.type === 'resume') transport.message({ type: 'status', state: 'playing' });
    };
    selected.activate(forward);
    selected.activate(forward);
    transport.open();
    expect(transport.connections).toBe(1);
    expect(transport.sent.filter(message => message.type === 'resume')).toHaveLength(1);
    expect(forward.onOpen).not.toHaveBeenCalled();
    expect(forward.onMessage).toHaveBeenCalledWith({ type: 'status', state: 'playing' });
    const next = pcm(2000);
    transport.chunk(next);
    expect(forward.onAudio).toHaveBeenLastCalledWith(next);
    pool.clear();
    pool.prepare(targets);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.closes).toBe(0); // Promoted transport no longer belongs to the pool.
    transport.handlers!.onClose();
    transport.handlers!.onClose();
    expect(forward.onClose).toHaveBeenCalledTimes(1);
  });

  it('matches exact feature/text/weight content regardless of order or diagnostic metadata', () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    transports[0]!.finish();
    const reordered = {
      features: { piano: 0.3, ambient: 0.4 },
      prompts: [...targets.up.prompts].reverse(),
      lastDecision: { kind: 'hold' as const, reason: 'different diagnostic only', phase: 'listening', step: 0, prediction: 0, uncertainty: 0 },
    };
    expect(pool.take('up', reordered)).toBeDefined();
  });

  it.each(['feature', 'weight', 'text'])('invalidates the entire old generation on an exact %s mismatch', mismatch => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    transports.forEach(transport => transport.finish());
    const altered = structuredClone(targets.up);
    if (mismatch === 'feature') altered.features.ambient += 1e-12;
    if (mismatch === 'weight') altered.prompts[0]!.weight += 1e-12;
    if (mismatch === 'text') altered.prompts[0]!.text += '!';
    expect(pool.take('up', altered)).toBeUndefined();
    expect(transports.every(transport => transport.closes === 1)).toBe(true);
    expect(pool.take('down', targets.down)).toBeUndefined();
  });

  it('rejects absent prefetch capability, invalid format, changed format and audio before ready', () => {
    const failures: Array<(transport: FakeTransport) => void> = [
      transport => transport.message({ type: 'ready', audio: audio() }),
      transport => transport.message({ type: 'ready', audio: audio(), prefetch: false }),
      transport => transport.message({ type: 'ready', audio: { ...audio(), channels: 1 } as never, prefetch: true }),
      transport => transport.message({ type: 'ready', audio: audio(NaN), prefetch: true }),
      transport => transport.message({ type: 'ready', audio: audio(0), prefetch: true }),
      transport => { transport.ready(); transport.ready(44100); },
      transport => transport.chunk(pcm(1000)),
      transport => { transport.ready(); transport.chunk(new ArrayBuffer(3)); },
    ];
    for (const fail of failures) {
      const { pool, transports } = rig();
      pool.prepare(targets);
      fail(transports[0]!);
      expect(transports[0]!.closes).toBe(1);
      expect(pool.take('up', targets.up)).toBeUndefined();
      pool.clear();
    }
  });

  it('caps duration at 12 seconds even at a low rate and invalidates on the next whole frame', () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const transport = transports[0]!;
    transport.ready(8000);
    transport.chunk(pcm(12_000, 8000));
    transport.paused();
    expect(transport.closes).toBe(0);
    transport.chunk(new ArrayBuffer(4));
    expect(transport.closes).toBe(1);
    expect(pool.take('up', targets.up)).toBeUndefined();
  });

  it('caps bytes at 3 MiB independently of duration and bounds the number of tiny chunks', () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const highRate = transports[0]!;
    highRate.ready(192000);
    highRate.chunk(new ArrayBuffer(L.maximumBytes));
    highRate.paused();
    expect(highRate.closes).toBe(0);
    highRate.chunk(new ArrayBuffer(4));
    expect(highRate.closes).toBe(1);
    const tiny = transports[1]!;
    tiny.ready();
    for (let i = 0; i < L.maximumChunks; i++) tiny.chunk(new ArrayBuffer(4));
    expect(tiny.closes).toBe(0);
    tiny.chunk(new ArrayBuffer(4));
    expect(tiny.closes).toBe(1);
  });

  it('keeps the full byte/duration bound across take and late pre-activation tail', () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const transport = transports[0]!;
    transport.finish(10_000);
    const selected = pool.take('up', targets.up)!;
    transport.chunk(pcm(3000));
    expect(transport.closes).toBe(1);
    const forward = handlers();
    selected.activate(forward);
    expect(forward.onClose).toHaveBeenCalledTimes(1);
    expect(transport.sent.some(message => message.type === 'resume')).toBe(false);
  });

  it('silently disposes candidate errors/close/reconnect and does not retry', async () => {
    for (const failure of ['error', 'close', 'reconnect', 'stopped'] as const) {
      const { pool, transports } = rig();
      pool.prepare(targets);
      const transport = transports[0]!;
      if (failure === 'error') transport.message({ type: 'error', code: 'capacity', message: 'busy', retryable: true });
      else if (failure === 'close') transport.handlers!.onClose();
      else transport.message({ type: 'status', state: failure === 'reconnect' ? 'reconnecting' : 'stopped' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transports).toHaveLength(2);
      expect(transport.closes).toBe(1);
      expect(pool.take('up', targets.up)).toBeUndefined();
      pool.clear();
    }
  });

  it('enforces 15-second setup and 55-second TTL even if larger options are requested', async () => {
    const pending = rig({ setupMs: 999999, ttlMs: 999999 });
    pending.pool.prepare(targets);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pending.transports.every(transport => transport.closes === 1)).toBe(true);
    const ready = rig();
    ready.pool.prepare(targets);
    ready.transports.forEach(transport => transport.finish());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ready.transports.every(transport => transport.closes === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(ready.transports.every(transport => transport.closes === 1)).toBe(true);
  });

  it('notifies failed activation after expiry/disposal so the controller can recover', async () => {
    for (const cancel of ['expiry', 'clear', 'dispose'] as const) {
      const { pool, transports } = rig({ ttlMs: 100 });
      pool.prepare(targets);
      transports[0]!.finish();
      const selected = pool.take('up', targets.up)!;
      if (cancel === 'expiry') await vi.advanceTimersByTimeAsync(100);
      if (cancel === 'clear') pool.clear();
      if (cancel === 'dispose') selected.dispose();
      const forward = handlers();
      selected.activate(forward);
      selected.activate(forward);
      expect(forward.onClose).toHaveBeenCalledTimes(1);
      expect(transports[0]!.closes).toBe(1);
      expect(transports[0]!.sent.some(message => message.type === 'resume')).toBe(false);
    }
  });

  it('replenishes only on explicit prepare, ignores late cancelled callbacks, and closes unactivated handoffs', () => {
    const { pool, transports } = rig();
    pool.prepare(targets);
    const old = transports[0]!;
    old.finish();
    const selected = pool.take('up', targets.up)!;
    pool.prepare(targets);
    expect(old.closes).toBe(1);
    expect(transports).toHaveLength(4);
    old.open(); old.ready(); old.chunk(pcm(6000)); old.paused(); old.handlers!.onClose();
    expect(old.sent).toHaveLength(0);
    expect(old.closes).toBe(1);
    const forward = handlers();
    selected.activate(forward);
    expect(forward.onClose).toHaveBeenCalledTimes(1);
    transports[3]!.finish();
    expect(pool.take('down', targets.down)).toBeDefined();
    pool.clear(); pool.clear();
    expect(transports.every(transport => transport.closes === 1)).toBe(true);
  });

  it('contains synchronous factory/connect/send failures without retrying or preventing the sibling', () => {
    let attempt = 0;
    const surviving = new FakeTransport();
    const pool = new LookaheadPool(() => { if (attempt++ === 0) throw new Error('factory'); return surviving; });
    expect(() => pool.prepare(targets)).not.toThrow();
    surviving.finish();
    expect(pool.take('down', targets.down)).toBeDefined();
    pool.clear();
    for (const failure of ['connect', 'start', 'resume'] as const) {
      const { pool: next, transports } = rig({}, transport => {
        if (failure === 'connect') transport.onConnect = () => { throw new Error('connect'); };
        transport.onSend = message => { if ((failure === 'start' && message.type === 'start') || (failure === 'resume' && message.type === 'resume')) throw new Error('send'); };
      });
      expect(() => next.prepare(targets)).not.toThrow();
      if (failure === 'start') expect(() => transports[0]!.open()).not.toThrow();
      if (failure === 'resume') {
        transports[0]!.finish();
        const selected = next.take('up', targets.up)!;
        const forward = handlers();
        selected.activate(forward);
        expect(forward.onClose).toHaveBeenCalledTimes(1);
      }
      expect(transports[0]!.closes).toBe(1);
      next.clear();
    }
  });

  it('rejects malformed target snapshots and deadline values without opening sockets', () => {
    const { pool, transports } = rig();
    pool.prepare({ ...targets, up: { ...targets.up, prompts: [{ text: 'x', weight: NaN }] } });
    expect(transports).toHaveLength(0);
    expect(() => rig({ setupMs: 0 })).toThrow(RangeError);
    expect(() => rig({ ttlMs: Infinity })).toThrow(RangeError);
  });
});
