import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePlayer, fakeLearner, FORMAT } from '../../tests/e2e/harness.ts';
import type { AudioFormat, ClientMessage, LearnerState, SessionState, StreamLevels } from '../shared/protocol.ts';
import type { MusicTransport, TransportHandlers } from '../transport/types.ts';
import type { FeedbackRecord, PreferencesStore, SavedProfile } from '../preferences/types.ts';
import { SessionController } from './index.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
class SwapPlayer extends FakePlayer {
  swaps: Array<{ audio: AudioFormat; duration: number; fade: number }> = [];
  accept = true;
  getStats() { return { state: 'ready', priming: false, audioContextState: 'running' }; }
  replacePcm(audio: AudioFormat, chunks: ArrayBuffer[], fade: number) {
    if (!this.accept) return false;
    this.swaps.push({ audio, duration: chunks.reduce((n, c) => n + c.byteLength, 0) / (audio.sampleRateHz * 4) * 1000, fade });
    return true;
  }
}
class Wire implements MusicTransport {
  h!: TransportHandlers;
  sent: ClientMessage[] = [];
  closed = false;
  constructor(private supported = true, private fill = true) {}
  connect(h: TransportHandlers) { this.h = h; queueMicrotask(() => { if (!this.closed) h.onOpen(); }); }
  send(message: ClientMessage) {
    this.sent.push(message);
    if (message.type !== 'start') return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.h.onMessage({ type: 'ready', audio: FORMAT, prefetch: this.supported });
      if (!message.prefetchMs || this.fill) this.h.onAudio(new ArrayBuffer(message.prefetchMs ? 48000 * 4 * 6 : 16));
      if (message.prefetchMs && this.fill) this.h.onMessage({ type: 'status', state: 'paused' });
    });
  }
  close() { this.closed = true; }
}
function rig(options: { supported?: boolean; fill?: boolean; lookahead?: boolean } = {}) {
  const wires: Wire[] = [];
  const player = new SwapPlayer();
  const learner = fakeLearner().learner;
  const events: FeedbackRecord[] = [];
  let profile: SavedProfile | undefined;
  const preferences: PreferencesStore = {
    load: async () => ({ profiles: {} }),
    save: async (saved, event) => { profile = structuredClone(saved); if (event) events.push(structuredClone(event)); },
    selectPurpose: async () => {}, clear: async () => {}, export: async () => JSON.stringify({ profile, events }),
  };
  const process = vi.spyOn(learner, 'processVote');
  const states: SessionState[] = [];
  const c = new SessionController({ learner, player, seed: 7, preferences, lookahead: options.lookahead ?? true,
    createTransport: () => { const wire = new Wire(options.supported ?? true, options.fill ?? true); wires.push(wire); return wire; },
    config: { generationLatencyMs: 0, noVoteEvolveMs: 45000 } });
  c.subscribe(s => states.push(s));
  return { c, wires, player, learner, process, events, states, get profile() { return profile; },
    start: async () => { await c.start(); await vi.advanceTimersByTimeAsync(1100); },
    flush: () => vi.advanceTimersByTimeAsync(0) };
}

describe('prepared feedback branches through the controller', () => {
  it('prepares both branches without saving speculative votes, promotes and replenishes the selected stream', async () => {
    const r = rig(); await r.start();
    expect(r.wires).toHaveLength(3);
    expect(r.wires.slice(1).map(w => w.sent[0])).toEqual([
      { type: 'start', prompts: [{ text: 'ambient', weight: 1 }], prefetchMs: 6000 },
      { type: 'start', prompts: [{ text: 'jazz', weight: 1 }], prefetchMs: 6000 },
    ]);
    expect(r.profile?.state.votes).toBe(0);
    expect(r.events).toHaveLength(0);
    r.c.vote('down'); await r.flush();
    expect(r.player.swaps).toEqual([{ audio: FORMAT, duration: 6000, fade: 100 }]);
    expect(r.wires[2]!.sent.at(-1)).toEqual({ type: 'resume' });
    expect(r.wires[0]!.closed).toBe(true); expect(r.wires[1]!.closed).toBe(true);
    expect(r.profile?.state.votes).toBe(1); expect(r.events).toHaveLength(1);
    const chunks = r.player.chunks;
    r.wires[0]!.h.onAudio(new ArrayBuffer(8));
    expect(r.player.chunks).toBe(chunks);
    r.wires[2]!.h.onAudio(new ArrayBuffer(8));
    expect(r.player.chunks).toBe(chunks + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.wires).toHaveLength(5);
    r.c.stop(); expect(r.wires.every(w => w.closed)).toBe(true);
  });

  it('waits for delayed audio and uses a ready cache without waiting for a resumed provider block', async () => {
    const r = rig({ fill: false }); await r.start();
    expect(r.player.swaps).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4000);
    const down = r.wires[2]!;
    down.h.onAudio(new ArrayBuffer(48000 * 4 * 6));
    down.h.onMessage({ type: 'status', state: 'paused' });
    const stats: StreamLevels[] = [];
    const off = r.c.subscribeStats(s => stats.push(s));
    r.c.vote('down');
    expect(r.player.swaps).toHaveLength(1);
    expect(stats.at(-1)?.steerProgress).toBe(0);
    expect(r.states.at(-1)).toMatchObject({ signature: { genre: 'jazz' }, nowPlaying: { genre: 'jazz' } });
    expect(r.c.captureMoment()).toMatchObject({ features: { jazz: 1 }, prompts: [{ text: 'jazz', weight: 1 }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(stats.at(-1)?.steerProgress).toBe(1);
    off(); r.c.stop();
  });

  it('keeps main’s short vote ramp when a click precedes cache readiness', async () => {
    const r = rig({ fill: false }); await r.start();
    r.c.vote('down');
    expect(r.player.swaps).toHaveLength(0);
    expect(r.wires[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.wires[0]!.sent.at(-1)).toMatchObject({ type: 'steer', prompts: [{ text: 'jazz', weight: 1 }] });
    r.c.stop();
  });

  it.each(['recall', 'nudge'] as const)('invalidates old cached branches after %s without fabricating votes', async action => {
    const r = rig(); await r.start();
    const target = { features: { piano: 1 }, prompts: [{ text: 'piano', weight: 1 }] };
    r.learner.nudge = () => target;
    if (action === 'recall') r.c.recallMoment(target);
    else r.c.nudge('piano');
    expect(r.wires[1]!.closed).toBe(true);
    expect(r.wires[2]!.closed).toBe(true);
    expect(r.events).toHaveLength(0);
    expect(r.profile?.state.votes).toBe(0);
    r.c.stop();
  });

  it('preserves rejected-blend attribution across the cached switch and gates overlap feedback', async () => {
    const r = rig(); await r.start(); r.c.vote('down');
    r.c.vote('up'); await r.flush();
    expect(r.events[1]).toMatchObject({ evidenceWeight: 0 });
    expect(r.events[1]?.previous).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1100);
    r.c.vote('up'); await r.flush();
    expect(r.events[2]).toMatchObject({ audible: { jazz: 1 }, previous: { ambient: 1 }, evidenceWeight: 1 });
    r.c.stop();
  });

  it('keeps the correlation ledger when a Like switches to a new continuation of the same blend', async () => {
    const r = rig(); await r.start(); r.c.vote('up');
    await vi.advanceTimersByTimeAsync(1100); r.c.vote('up'); await r.flush();
    expect(r.events.map(e => e.evidenceWeight)).toEqual([1, 0]);
    expect(r.profile?.state.votes).toBe(2);
    r.c.stop();
  });

  it.each([{ fill: false }, { supported: false }, { lookahead: false }])('falls back without interrupting playback when unavailable: %j', async options => {
    const r = rig(options); await r.start(); const active = r.wires[0]!;
    r.c.vote('down'); await r.flush();
    expect(r.player.swaps).toHaveLength(0);
    expect(active.closed).toBe(false);
    expect(active.sent.some(m => m.type === 'steer')).toBe(true);
    expect(r.states.at(-1)?.status).toBe('playing');
    expect(r.events).toHaveLength(1);
    r.c.stop();
  });

  it('closes a taken branch if the player cannot safely swap', async () => {
    const r = rig(); await r.start(); r.player.accept = false; r.c.vote('down');
    expect(r.wires.slice(1).every(w => w.closed)).toBe(true);
    expect(r.wires[0]!.closed).toBe(false);
    expect(r.wires[0]!.sent.at(-1)?.type).toBe('steer');
    r.c.stop();
  });

  it('discards stale predictions when the actual learner decision differs', async () => {
    const r = rig(); await r.start();
    r.process.mockImplementationOnce(({ state }) => ({ state: { ...state, votes: state.votes + 1 } as LearnerState,
      target: { features: { classical: 1 }, prompts: [{ text: 'classical', weight: 1 }] } }));
    r.c.vote('down'); await r.flush();
    expect(r.player.swaps).toHaveLength(0);
    expect(r.wires.slice(1).every(w => w.closed)).toBe(true);
    expect(r.events[0]?.targetAfter.features).toEqual({ classical: 1 });
    r.c.stop();
  });

  it('keeps the original freshness deadline after a cached Like', async () => {
    const r = rig(); await r.start();
    await vi.advanceTimersByTimeAsync(30000); r.c.vote('up');
    await vi.advanceTimersByTimeAsync(14000);
    expect(r.wires.some(w => w.sent.some(m => m.type === 'steer'))).toBe(true);
    r.c.stop();
  });

  it('cancels prefetched generations on disconnect and does not retry candidate failures in a loop', async () => {
    const r = rig(); await r.start();
    r.wires[1]!.h.onMessage({ type: 'error', code: 'capacity', message: 'full', retryable: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(r.wires).toHaveLength(3);
    r.wires[0]!.h.onClose();
    expect(r.wires.slice(0, 3).every(w => w.closed)).toBe(true);
    r.c.stop(); await vi.advanceTimersByTimeAsync(20000);
    expect(r.wires).toHaveLength(3);
  });
});
