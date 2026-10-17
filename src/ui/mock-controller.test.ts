import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DEFAULT_SAMPLE_RATE_HZ } from '../audio/constants.ts';
import type { PCMPlayer } from '../audio/types.ts';
import type { SessionUiState } from './contracts.ts';
import { MockMusicSessionController, type MockPcmGeneratorLike } from './mock-controller.ts';

// stereo s16le: 4 bytes per frame
const BYTES_PER_MS = (DEFAULT_SAMPLE_RATE_HZ * 4) / 1000; // 192 @ 48 kHz

type FakePlayer = PCMPlayer & {
  initializeFromUserGesture: Mock<() => Promise<void>>;
  configure: Mock<PCMPlayer['configure']>;
  enqueuePcm: Mock<PCMPlayer['enqueuePcm']>;
  getBufferedDurationMs: Mock<() => number>;
  close: Mock<() => Promise<void>>;
};

function makePlayer(): FakePlayer {
  return {
    initializeFromUserGesture: vi.fn(() => Promise.resolve()),
    configure: vi.fn(),
    enqueuePcm: vi.fn(),
    getBufferedDurationMs: vi.fn(() => 0),
    close: vi.fn(() => Promise.resolve()),
  };
}

type FakeGenerator = {
  nextChunk: Mock<(maxMs?: number) => ArrayBuffer>;
  cyclePreset: Mock<() => unknown>;
  setPreset: Mock<(p: unknown) => void>;
  nudge: Mock<() => void>;
};

// `MockPreset` isn't finalized until src/audio lands, so hand fakes across the
// generatorFactory boundary via an unchecked cast — robust to whatever it becomes.
function asGenerator(g: FakeGenerator): MockPcmGeneratorLike {
  return g as unknown as MockPcmGeneratorLike;
}

/** Irregular chunk sizes (~36–72 ms) to prove the pump measures bytes, not chunks. */
function makeGenerator(): FakeGenerator {
  const sizes = [48, 60, 72, 36];
  let i = 0;
  return {
    nextChunk: vi.fn((_maxMs?: number) => {
      const ms = sizes[i++ % sizes.length]!;
      return new ArrayBuffer(Math.round(ms * BYTES_PER_MS));
    }),
    cyclePreset: vi.fn(() => 'preset-b'),
    setPreset: vi.fn(),
    nudge: vi.fn(),
  } as unknown as FakeGenerator;
}

function makeController(
  players: FakePlayer[] = [],
  gens: FakeGenerator[] = [],
  extra: ConstructorParameters<typeof MockMusicSessionController>[0] = {},
) {
  return new MockMusicSessionController({
    playerFactory: () => {
      const p = makePlayer();
      players.push(p);
      return p;
    },
    generatorFactory: () => {
      const g = makeGenerator();
      gens.push(g);
      return asGenerator(g);
    },
    ...extra,
  });
}

function enqueuedMs(player: FakePlayer): number {
  const bytes = player.enqueuePcm.mock.calls.reduce(
    (sum, call) => sum + (call[0] as ArrayBuffer).byteLength,
    0,
  );
  return bytes / BYTES_PER_MS;
}

describe('MockMusicSessionController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the current state immediately on subscribe, then on every change; unsubscribe works', async () => {
    const c = makeController();
    const seen: SessionUiState[] = [];
    const unsub = c.subscribe((s) => seen.push(s));
    expect(seen).toEqual([{ status: 'idle' }]);

    const p = c.start();
    expect(seen.map((s) => s.status)).toEqual(['idle', 'connecting']);
    await p;
    expect(seen.at(-1)?.status).toBe('playing');

    unsub();
    c.stop();
    expect(seen.at(-1)?.status).toBe('playing'); // 'stopped' never delivered
  });

  it('start() binds the autoplay gesture synchronously, then configures, then plays', async () => {
    const players: FakePlayer[] = [];
    const c = makeController(players);
    const p = c.start(); // deliberately NOT awaited
    const player = players[0]!;
    // these must have already happened synchronously inside the gesture
    expect(player.initializeFromUserGesture).toHaveBeenCalledTimes(1);
    expect(player.configure).toHaveBeenCalledWith({
      format: 'pcm_s16le',
      sampleRateHz: 48000,
      channels: 2,
    });
    await p;
    expect(player.enqueuePcm).toHaveBeenCalled(); // initial pump burst
  });

  it('is a no-op to call start() while connecting or playing', async () => {
    const players: FakePlayer[] = [];
    const c = makeController(players);
    const p1 = c.start();
    const p2 = c.start(); // connecting → ignored
    await Promise.all([p1, p2]);
    await c.start(); // playing → ignored
    expect(players).toHaveLength(1);
  });

  it('pumps irregular PCM chunks staying roughly chunkLeadMs ahead of the clock', async () => {
    const players: FakePlayer[] = [];
    const c = makeController(players);
    await c.start();
    const player = players[0]!;

    // t≈0 → target ≈ 1200 ms of audio; overshoot bounded by one max chunk (72 ms)
    const first = enqueuedMs(player);
    expect(first).toBeGreaterThanOrEqual(1200);
    expect(first).toBeLessThan(1200 + 100);

    player.enqueuePcm.mockClear();
    vi.advanceTimersByTime(1000); // 20 ticks × 50 ms
    const cumulative = first + enqueuedMs(player);
    // generated audio tracks elapsed(1000) + lead(1200), with ≤ one-chunk overshoot
    expect(cumulative).toBeGreaterThanOrEqual(2200);
    expect(cumulative).toBeLessThan(2200 + 100);

    for (const call of player.enqueuePcm.mock.calls) {
      const buf = call[0] as ArrayBuffer;
      expect(buf).toBeInstanceOf(ArrayBuffer);
      expect(buf.byteLength % 4).toBe(0);
    }
  });

  it('vote(down) fires cyclePreset after steerDelayMs — and emits nothing', async () => {
    const gens: FakeGenerator[] = [];
    const c = makeController([], gens);
    const seen: SessionUiState[] = [];
    c.subscribe((s) => seen.push(s));
    await c.start();
    const emitted = seen.length;

    c.vote('down');
    expect(seen.length).toBe(emitted); // votes never change status
    vi.advanceTimersByTime(999);
    expect(gens[0]!.cyclePreset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gens[0]!.cyclePreset).toHaveBeenCalledTimes(1);
    expect(gens[0]!.nudge).not.toHaveBeenCalled();
  });

  it('vote(up) fires nudge after steerDelayMs', async () => {
    const gens: FakeGenerator[] = [];
    const c = makeController([], gens);
    await c.start();
    c.vote('up');
    vi.advanceTimersByTime(1000);
    expect(gens[0]!.nudge).toHaveBeenCalledTimes(1);
    expect(gens[0]!.cyclePreset).not.toHaveBeenCalled();
  });

  it('debounces rapid votes: only the latest vote is applied, once', async () => {
    const gens: FakeGenerator[] = [];
    const c = makeController([], gens);
    await c.start();
    c.vote('up');
    vi.advanceTimersByTime(400);
    c.vote('down');
    vi.advanceTimersByTime(400);
    c.vote('up'); // latest wins → nudge, not cyclePreset
    vi.advanceTimersByTime(999);
    expect(gens[0]!.nudge).not.toHaveBeenCalled();
    expect(gens[0]!.cyclePreset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gens[0]!.nudge).toHaveBeenCalledTimes(1);
    expect(gens[0]!.cyclePreset).not.toHaveBeenCalled();
  });

  it('ignores votes before a session starts', () => {
    const gens: FakeGenerator[] = [];
    const c = makeController([], gens);
    c.vote('down');
    c.vote('up');
    vi.advanceTimersByTime(10_000);
    expect(gens).toHaveLength(0); // generator never even built
  });

  it('evolves the sound after idleEvolveMs without a vote; voting resets that clock', async () => {
    const gens: FakeGenerator[] = [];
    const c = makeController([], gens);
    await c.start();

    vi.advanceTimersByTime(44_000);
    expect(gens[0]!.nudge).not.toHaveBeenCalled();
    c.vote('down'); // t≈44s — resets the idle clock, steer lands at ~45s
    vi.advanceTimersByTime(2_000); // t≈46s
    expect(gens[0]!.cyclePreset).toHaveBeenCalledTimes(1);
    // had the vote not reset the clock, an idle nudge would have fired at ~45s
    expect(gens[0]!.nudge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(44_000); // t≈90s → 90−44=46s ≥ 45s
    expect(gens[0]!.nudge).toHaveBeenCalledTimes(1);
  });

  it('stop() clears timers, closes the player, emits stopped; a later start() rebuilds', async () => {
    const players: FakePlayer[] = [];
    const gens: FakeGenerator[] = [];
    const c = makeController(players, gens);
    const seen: string[] = [];
    c.subscribe((s) => seen.push(s.status));
    await c.start();

    c.vote('down'); // pending steer — must be cleared
    const before = players[0]!.enqueuePcm.mock.calls.length;
    c.stop();
    expect(players[0]!.close).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe('stopped');

    vi.advanceTimersByTime(10_000);
    expect(players[0]!.enqueuePcm.mock.calls.length).toBe(before); // pump stopped
    expect(gens[0]!.cyclePreset).not.toHaveBeenCalled(); // pending vote dropped
    expect(gens[0]!.nudge).not.toHaveBeenCalled(); // no idle evolve either

    await c.start(); // clean rebuild
    expect(players).toHaveLength(2);
    expect(gens).toHaveLength(2);
    expect(players[1]!.initializeFromUserGesture).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe('playing');
  });

  it('stop() is a no-op when idle', () => {
    const players: FakePlayer[] = [];
    const c = makeController(players);
    const seen: SessionUiState[] = [];
    c.subscribe((s) => seen.push(s));
    c.stop();
    expect(players).toHaveLength(0);
    expect(seen).toEqual([{ status: 'idle' }]);
  });

  it('init failure → unavailable + lastError, cleanup, no pumping; retry still possible', async () => {
    const players: FakePlayer[] = [];
    const c = new MockMusicSessionController({
      playerFactory: () => {
        const p = makePlayer();
        if (players.length === 0) {
          p.initializeFromUserGesture.mockRejectedValue(new Error('autoplay denied'));
        }
        players.push(p);
        return p;
      },
      generatorFactory: () => asGenerator(makeGenerator()),
    });
    const seen: SessionUiState[] = [];
    c.subscribe((s) => seen.push(s));

    await c.start();
    expect(players[0]!.close).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.status)).toEqual(['idle', 'connecting', 'unavailable']);
    expect(seen.at(-1)!.lastError).toContain('autoplay denied');

    vi.advanceTimersByTime(5_000);
    expect(players[0]!.enqueuePcm).not.toHaveBeenCalled();

    await c.start(); // retry recovers with a fresh player
    expect(players).toHaveLength(2);
    expect(seen.at(-1)!.status).toBe('playing');
    expect(seen.at(-1)!.lastError).toBeUndefined();
  });

  it('respects injected timer functions', async () => {
    const players: FakePlayer[] = [];
    const intervals: Array<() => void> = [];
    const timeouts: Array<() => void> = [];
    const c = new MockMusicSessionController({
      playerFactory: () => {
        const p = makePlayer();
        players.push(p);
        return p;
      },
      generatorFactory: () => asGenerator(makeGenerator()),
      setIntervalFn: (cb) => {
        intervals.push(cb);
        return 1;
      },
      setTimeoutFn: (cb) => {
        timeouts.push(cb);
        return 1;
      },
    });
    await c.start();
    expect(intervals).toHaveLength(1);
    c.vote('down');
    expect(timeouts).toHaveLength(1);
  });
});
