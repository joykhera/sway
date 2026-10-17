// Standalone, keyless MusicSessionController so the UI runs before D ships the real one.
// It generates PCM locally and pumps it into an injected PCMPlayer on a timer, staying
// `chunkLeadMs` ahead of the wall clock. Votes steer the generator after `steerDelayMs`
// (latest vote wins); long silence triggers a slow "idle evolve" drift.
//
// `MockPreset`/`MockPcmGenerator` come from src/audio. The default generator is
// resolved lazily (dynamic import) rather than bound at module load, so this file —
// and its tests — never hard-depends on the audio barrel's contents. If the import
// is unavailable, a small built-in procedural generator keeps standalone mode alive.

import { DEFAULT_SAMPLE_RATE_HZ, TELEMETRY_SILENCE_FLOOR, TELEMETRY_WINDOW_MS } from '../audio/constants.ts';
import type { PCMPlayer } from '../audio/types.ts';
import type { MockPreset } from '../audio/index.ts';
import type {
  MusicSessionController,
  MusicSignature,
  SessionUiState,
  StreamLevels,
  Vote,
} from './contracts.ts';

/** Platform timer handle: number in browsers, Timeout under Node typings. */
type TimerHandle = unknown;
type SetTimerFn = (cb: () => void, ms: number) => TimerHandle;
type ClearTimerFn = (handle: TimerHandle) => void;

export type MockPcmGeneratorLike = {
  /** Returns up to `maxMs` of interleaved stereo s16le PCM at the session sample rate. */
  nextChunk(maxMs?: number): ArrayBuffer;
  /** The preset currently being generated, if the generator exposes it. */
  readonly preset?: MockPreset;
  setPreset?(p: MockPreset): void;
  cyclePreset?(): MockPreset;
  nudge?(): void;
};

export type MockControllerOptions = {
  /** REQUIRED for real playback; tests inject a fake PCMPlayer. */
  playerFactory?: () => PCMPlayer;
  /** Injectable; defaults to `new MockPcmGenerator()` from src/audio (built-in fallback until it lands). */
  generatorFactory?: () => MockPcmGeneratorLike;
  sampleRateHz?: number; // default DEFAULT_SAMPLE_RATE_HZ
  chunkLeadMs?: number; // audio generated ahead of wall clock, default 1200
  tickMs?: number; // pump interval, default 50
  steerDelayMs?: number; // vote → audible-change delay, default 1000
  idleEvolveMs?: number; // no-vote drift cadence, default 45000
  /** Injectable timers, defaulting to the globals *at call time* so vi.useFakeTimers() works. */
  setTimeoutFn?: SetTimerFn;
  clearTimeoutFn?: ClearTimerFn;
  setIntervalFn?: SetTimerFn;
  clearIntervalFn?: ClearTimerFn;
  /** Injectable clock; default Date.now. */
  now?: () => number;
};

const ACTIVE: ReadonlySet<string> = new Set(['connecting', 'playing']);
const ZERO_LEVELS: StreamLevels = { energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0 };

/** Whisperable identity per preset — honest words for what each generator preset sounds like. */
const PRESET_SIGNATURES: Readonly<Record<string, MusicSignature>> = {
  dusk: { genre: 'ambient', instrument: 'synth pad', mood: 'calm', texture: 'layered', focus: 'dusk' },
  glass: { genre: 'ambient', instrument: 'bell tones', mood: 'dreamy', texture: 'sparse', focus: 'glass' },
  ember: { genre: 'lofi', instrument: 'warm keys', mood: 'hopeful', texture: 'layered', focus: 'ember' },
  tide: { genre: 'ambient', instrument: 'deep drones', mood: 'melancholic', texture: 'layered', focus: 'tide' },
};

export class MockMusicSessionController implements MusicSessionController {
  private readonly playerFactory?: () => PCMPlayer;
  private readonly generatorFactory?: () => MockPcmGeneratorLike;
  private readonly sampleRateHz: number;
  private readonly chunkLeadMs: number;
  private readonly tickMs: number;
  private readonly steerDelayMs: number;
  private readonly idleEvolveMs: number;
  private readonly now: () => number;
  private readonly timers: {
    setTimeout: SetTimerFn;
    clearTimeout: ClearTimerFn;
    setInterval: SetTimerFn;
    clearInterval: ClearTimerFn;
  };

  private readonly listeners = new Set<(state: SessionUiState) => void>();
  private readonly statsListeners = new Set<(levels: StreamLevels) => void>();
  private state: SessionUiState = { status: 'idle' };

  private player: PCMPlayer | null = null;
  private generator: MockPcmGeneratorLike | null = null;
  private pumpHandle: TimerHandle | null = null;
  private voteHandle: TimerHandle | null = null;
  /** Invalidates in-flight async `start()` continuations after stop()/restart. */
  private runId = 0;
  private sessionStartMs = 0;
  private generatedMs = 0;
  private lastSteerMs = 0;
  /** Last known generator preset (from `preset`, `cyclePreset`'s return, or `setPreset`). */
  private activePreset: string | undefined;
  /** Rolling ~TELEMETRY_WINDOW_MS aggregates over recently pumped PCM. */
  private statsWindow: { ms: number; sumSq: number; crossings: number; frames: number; samples: number }[] = [];
  private statsWindowMs = 0;
  /** Previous left-channel sample (normalized) — zero-crossing detection across chunk edges. */
  private statsPrevLeft = 0;
  private latestStats: StreamLevels = ZERO_LEVELS;

  constructor(options: MockControllerOptions = {}) {
    this.playerFactory = options.playerFactory;
    this.generatorFactory = options.generatorFactory;
    this.sampleRateHz = options.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    this.chunkLeadMs = options.chunkLeadMs ?? 1200;
    this.tickMs = options.tickMs ?? 50;
    this.steerDelayMs = options.steerDelayMs ?? 1000;
    this.idleEvolveMs = options.idleEvolveMs ?? 45_000;
    this.now = options.now ?? (() => Date.now());
    // Resolve globals lazily (inside the wrapper) so fake timers installed after
    // construction still intercept everything.
    this.timers = {
      setTimeout: options.setTimeoutFn ?? ((cb, ms) => globalThis.setTimeout(cb, ms)),
      clearTimeout: options.clearTimeoutFn ?? ((h) => globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0])),
      setInterval: options.setIntervalFn ?? ((cb, ms) => globalThis.setInterval(cb, ms)),
      clearInterval: options.clearIntervalFn ?? ((h) => globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0])),
    };
  }

  subscribe(listener: (state: SessionUiState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state); // synchronous immediate emit, per contract
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeStats(listener: (levels: StreamLevels) => void): () => void {
    this.statsListeners.add(listener);
    // Synchronous snapshot: the rolling estimate while playing, zeros when idle.
    listener(this.state.status === 'playing' ? this.latestStats : ZERO_LEVELS);
    return () => {
      this.statsListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (ACTIVE.has(this.state.status)) return; // idempotent while connecting/playing
    const id = ++this.runId;
    this.activePreset = undefined; // no stale preset while connecting — resolved generator sets it below
    this.setStatus('connecting');

    if (!this.playerFactory) {
      this.setStatus('unavailable', 'no audio player configured (playerFactory missing)');
      return;
    }

    let player: PCMPlayer;
    let init: Promise<void>;
    try {
      player = this.playerFactory();
      // MUST be invoked synchronously inside the user gesture — nothing is awaited before this.
      init = player.initializeFromUserGesture();
      player.configure({ format: 'pcm_s16le', sampleRateHz: this.sampleRateHz, channels: 2 });
    } catch (e) {
      this.setStatus('unavailable', String(e));
      return;
    }
    this.player = player;

    // Resolve the generator in parallel with init; neither is needed until pumping.
    const genPromise = this.makeGenerator();
    try {
      await init;
      this.generator = await genPromise;
    } catch (e) {
      this.player = null;
      this.generator = null;
      void player.close();
      if (this.runId === id) this.setStatus('unavailable', String(e));
      return;
    }

    if (this.runId !== id) {
      // stop() ran while we were connecting — release the fresh player, stay stopped.
      this.player = null;
      this.generator = null;
      void player.close();
      return;
    }

    const t0 = this.now();
    this.sessionStartMs = t0;
    this.lastSteerMs = t0;
    this.generatedMs = 0;
    this.activePreset = this.generator?.preset;
    this.statsWindow = [];
    this.statsWindowMs = 0;
    this.statsPrevLeft = 0;
    this.latestStats = ZERO_LEVELS;
    this.setStatus('playing');
    this.pump(); // first burst immediately, then on the interval
    this.publishStats();
    this.pumpHandle = this.timers.setInterval(() => this.tick(), this.tickMs);
  }

  vote(v: Vote): void {
    if (this.state.status !== 'playing') return;
    this.lastSteerMs = this.now(); // reset the idle-evolve clock
    if (this.voteHandle !== null) {
      this.timers.clearTimeout(this.voteHandle); // debounce: latest vote wins
      this.voteHandle = null;
    }
    const gen = this.generator;
    this.voteHandle = this.timers.setTimeout(() => {
      this.voteHandle = null;
      if (v === 'down') {
        const next = gen?.cyclePreset?.();
        this.activePreset = typeof next === 'string' ? next : (gen?.preset ?? this.activePreset);
      } else {
        gen?.nudge?.();
        this.activePreset = gen?.preset ?? this.activePreset;
      }
      this.refreshSignature(); // preset steers update the identity — status stays 'playing'
    }, this.steerDelayMs);
    // No status emit on the vote itself — votes never change status.
  }

  stop(): void {
    const status = this.state.status;
    if (status === 'idle' || status === 'stopped') return; // no-op
    this.runId++;
    if (this.pumpHandle !== null) {
      this.timers.clearInterval(this.pumpHandle);
      this.pumpHandle = null;
    }
    if (this.voteHandle !== null) {
      this.timers.clearTimeout(this.voteHandle);
      this.voteHandle = null;
    }
    const player = this.player;
    this.player = null;
    this.generator = null;
    this.activePreset = undefined;
    this.statsWindow = [];
    this.statsWindowMs = 0;
    this.statsPrevLeft = 0;
    this.latestStats = ZERO_LEVELS;
    if (player) void player.close();
    this.setStatus('stopped');
  }

  // ---- internals ----

  private emit(): void {
    const snapshot = this.state;
    for (const l of [...this.listeners]) l(snapshot);
  }

  private setStatus(status: string, lastError?: string): void {
    const state: SessionUiState = lastError === undefined ? { status } : { status, lastError };
    const sig = this.signatureNow();
    if (sig && ACTIVE.has(status)) state.signature = sig;
    this.state = state;
    this.emit();
  }

  /** Recompute the signature from the current preset; emit only when it actually changed. */
  private refreshSignature(): void {
    if (!ACTIVE.has(this.state.status)) return;
    const sig = this.signatureNow();
    const prev = this.state.signature;
    if (sig === prev) return;
    if (sig && prev && sig.genre === prev.genre && sig.instrument === prev.instrument &&
      sig.mood === prev.mood && sig.texture === prev.texture && sig.focus === prev.focus) return;
    this.state = sig === undefined ? { ...this.state, signature: undefined } : { ...this.state, signature: sig };
    this.emit();
  }

  private signatureNow(): MusicSignature | undefined {
    const name = this.generator?.preset ?? this.activePreset;
    if (!name) return undefined;
    return PRESET_SIGNATURES[name] ?? { focus: name };
  }

  private tick(): void {
    if (this.state.status !== 'playing') return;
    this.pump();
    this.publishStats();
    const now = this.now();
    if (this.generator?.nudge && now - this.lastSteerMs >= this.idleEvolveMs) {
      this.lastSteerMs = now;
      this.generator.nudge();
      this.activePreset = this.generator.preset ?? this.activePreset;
      this.refreshSignature();
    }
  }

  /** Keep generated audio `chunkLeadMs` ahead of elapsed session time. */
  private pump(): void {
    const { player, generator } = this;
    if (!player || !generator) return;
    const targetMs = this.now() - this.sessionStartMs + this.chunkLeadMs;
    const frameBytes = 4; // stereo s16le
    for (let guard = 0; this.generatedMs < targetMs && guard < 256; guard++) {
      const chunk = generator.nextChunk(60);
      // Generators may legally emit mid-frame (≢0 mod 4) chunks — only empties stall us.
      if (!(chunk instanceof ArrayBuffer) || chunk.byteLength === 0) break;
      this.generatedMs += (chunk.byteLength / frameBytes / this.sampleRateHz) * 1000;
      this.accumulateStats(chunk);
      try {
        player.enqueuePcm(chunk);
      } catch {
        break; // a closed/torn-down player swallows further chunks
      }
    }
  }

  /**
   * Fold one pumped chunk into the rolling telemetry window: stereo RMS plus
   * left-channel zero crossings — the same measurements the worklet reports.
   */
  private accumulateStats(chunk: ArrayBuffer): void {
    if (chunk.byteLength % 2 !== 0) return; // not int16-aligned — skip rather than guess
    const view = new Int16Array(chunk);
    const n = view.length;
    if (n === 0) return;
    let sumSq = 0;
    let crossings = 0;
    let frames = 0;
    let prev = this.statsPrevLeft;
    for (let i = 0; i < n; i++) {
      const s = view[i]! / 32768;
      sumSq += s * s;
      if ((i & 1) === 0) {
        frames++;
        if (prev !== 0 && s !== 0 && s < 0 !== prev < 0) crossings++;
        if (s !== 0) prev = s;
      }
    }
    this.statsPrevLeft = prev;
    const ms = (frames / this.sampleRateHz) * 1000;
    this.statsWindow.push({ ms, sumSq, crossings, frames, samples: n });
    this.statsWindowMs += ms;
    // Trim whole entries until the window fits — small chunks make this cheap.
    while (this.statsWindowMs > TELEMETRY_WINDOW_MS && this.statsWindow.length > 1) {
      this.statsWindowMs -= this.statsWindow.shift()!.ms;
    }
  }

  /** Aggregate the rolling window into StreamLevels and push it to stats subscribers. */
  private publishStats(): void {
    let sumSq = 0;
    let crossings = 0;
    let frames = 0;
    let samples = 0;
    for (const e of this.statsWindow) {
      sumSq += e.sumSq;
      crossings += e.crossings;
      frames += e.frames;
      samples += e.samples;
    }
    const energy = samples > 0 ? Math.sqrt(sumSq / samples) : 0;
    const windowSec = this.statsWindowMs / 1000;
    // A periodic signal crosses zero twice per cycle → ZCR/2 tracks the dominant partial;
    // on a mixed pad it reads as spectral brightness. Both fields share that one estimator.
    const zcrHz = windowSec > 0 ? crossings / windowSec / 2 : 0;
    this.latestStats = {
      energy,
      brightnessHz: zcrHz,
      pitchHz: energy > TELEMETRY_SILENCE_FLOOR && zcrHz > 0 ? zcrHz : null,
      bufferedMs: this.player?.getBufferedDurationMs?.() ?? 0,
      underruns: 0,
    };
    if (this.statsListeners.size === 0) return;
    for (const l of [...this.statsListeners]) l(this.latestStats);
  }

  private async makeGenerator(): Promise<MockPcmGeneratorLike> {
    if (this.generatorFactory) return this.generatorFactory();
    try {
      const mod = await import('../audio/index.ts');
      if (typeof mod.MockPcmGenerator === 'function') {
        return new mod.MockPcmGenerator() as MockPcmGeneratorLike;
      }
    } catch {
      // audio barrel not built yet — fall through to the built-in generator
    }
    return new BasicMockPcmGenerator(this.sampleRateHz);
  }
}

// --- built-in procedural fallback (used only until src/audio ships MockPcmGenerator) ---

type BasicPreset = { name: string; freqs: number[]; level: number };

// Names mirror the audio lane's MockPreset union so setPreset stays meaningful.
const BASIC_PRESETS: readonly BasicPreset[] = [
  { name: 'dusk', freqs: [220, 277.19, 329.63, 440], level: 0.16 },
  { name: 'glass', freqs: [196, 246.94, 293.66, 392], level: 0.15 },
  { name: 'ember', freqs: [174.61, 220, 261.63, 349.23], level: 0.15 },
  { name: 'tide', freqs: [164.81, 207.65, 246.94, 329.63], level: 0.14 },
];

function clamp16(x: number): number {
  return Math.round(Math.max(-1, Math.min(1, x)) * 32767);
}

/** A soft detuned-sine pad; just enough to make the standalone mode audible. */
class BasicMockPcmGenerator implements MockPcmGeneratorLike {
  private presetIndex = 0;
  private frame = 0;
  private wobble = 0; // transient detune applied by nudge(), decays over time

  constructor(private readonly sampleRateHz: number) { }

  /** The preset currently being generated. */
  get preset(): MockPreset {
    return BASIC_PRESETS[this.presetIndex % BASIC_PRESETS.length]!.name as MockPreset;
  }

  nextChunk(maxMs = 60): ArrayBuffer {
    const frames = Math.max(1, Math.round((this.sampleRateHz * maxMs) / 1000));
    const buf = new ArrayBuffer(frames * 4);
    const view = new DataView(buf);
    const preset = BASIC_PRESETS[this.presetIndex % BASIC_PRESETS.length]!;
    const sr = this.sampleRateHz;
    for (let i = 0; i < frames; i++) {
      const t = (this.frame + i) / sr;
      const lfo = 0.72 + 0.28 * Math.sin(2 * Math.PI * 0.11 * t + this.presetIndex * 1.3);
      let l = 0;
      let r = 0;
      const n = preset.freqs.length;
      for (let f = 0; f < n; f++) {
        const base = preset.freqs[f]! * (1 + this.wobble * 0.0015 * (f + 1));
        l += Math.sin(2 * Math.PI * base * t + f * 0.7) / n;
        r += Math.sin(2 * Math.PI * base * 1.003 * t + f * 0.7) / n; // slight stereo detune
      }
      const s = preset.level * lfo;
      view.setInt16(i * 4, clamp16(l * s), true);
      view.setInt16(i * 4 + 2, clamp16(r * s), true);
    }
    this.frame += frames;
    this.wobble *= 0.9995;
    return buf;
  }

  setPreset(preset: MockPreset): void {
    const i = BASIC_PRESETS.findIndex((p) => p.name === preset);
    if (i >= 0) this.presetIndex = i;
  }

  cyclePreset(): MockPreset {
    this.presetIndex = (this.presetIndex + 1) % BASIC_PRESETS.length;
    return BASIC_PRESETS[this.presetIndex]!.name as MockPreset;
  }

  nudge(): void {
    this.wobble = Math.min(8, this.wobble + 2.5);
  }
}
