import { describe, expect, it } from 'vitest';
import {
  BufferedPCMPlayer, createBufferedPCMPlayer,
  type BufferedAudioBufferLike, type BufferedAudioContextLike,
  type BufferedPCMPlayerOptions, type BufferedSourceLike,
} from './buffered-player.ts';
import { PENDING_CHUNK_LIMIT } from './constants.ts';

class FakeBuffer implements BufferedAudioBufferLike {
  readonly data: Float32Array[];
  constructor(readonly frames: number, readonly rate: number, channels: number) {
    this.data = Array.from({ length: channels }, () => new Float32Array(frames));
  }
  getChannelData(channel: number) { return this.data[channel]!; }
}
class FakeSource implements BufferedSourceLike {
  buffer: FakeBuffer | null = null;
  onended: ((event: Event) => void) | null = null;
  startAt = NaN;
  stops = 0;
  disconnects = 0;
  connections = 0;
  ended = false;
  connect() { this.connections++; }
  disconnect() { this.disconnects++; }
  start(when = 0) { this.startAt = when; }
  stop() { this.stops++; }
}
class FakeContext implements BufferedAudioContextLike {
  currentTime = 0;
  state = 'running';
  destination = {} as AudioNode;
  onstatechange: ((event: Event) => void) | null = null;
  sources: FakeSource[] = [];
  buffers: FakeBuffer[] = [];
  resumes = 0;
  closes = 0;
  resumeGate?: Promise<void>;
  constructor(readonly sampleRate = 48000) {}
  createBuffer(channels: number, frames: number, rate: number) {
    const buffer = new FakeBuffer(frames, rate, channels);
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async resume() {
    this.resumes++;
    await this.resumeGate;
    if (this.state !== 'closed') this.setState('running');
  }
  async close() { this.closes++; this.setState('closed'); }
  setState(state: string) { this.state = state; this.onstatechange?.(new Event('statechange')); }
  advance(seconds: number) {
    if (this.state !== 'running') return;
    this.currentTime += seconds;
    for (const source of [...this.sources]) {
      if (!source.ended && source.buffer && source.startAt + source.buffer.frames / source.buffer.rate <= this.currentTime) {
        source.ended = true;
        source.onended?.(new Event('ended'));
      }
    }
  }
}
const format = (rate = 48000) => ({ format: 'pcm_s16le', channels: 2, sampleRateHz: rate } as const);
function pcm(frames: number, left = 1000, right = -2000): ArrayBuffer {
  const bytes = new ArrayBuffer(frames * 4);
  const view = new DataView(bytes);
  for (let frame = 0; frame < frames; frame++) {
    view.setInt16(frame * 4, left, true);
    view.setInt16(frame * 4 + 2, right, true);
  }
  return bytes;
}
function rig(opts: BufferedPCMPlayerOptions = {}, outputRate = 48000) {
  const contexts: FakeContext[] = [];
  const player = createBufferedPCMPlayer({
    ...opts,
    createAudioContext: () => {
      const ctx = new FakeContext(outputRate);
      contexts.push(ctx);
      return ctx;
    },
  });
  return { player, contexts };
}

// These exercise scheduling and decoded content, not just method-call snapshots.
describe('BufferedPCMPlayer', () => {
  it.each([44100, 48000])('keeps source duration/pitch and adjacent scheduling at %i Hz output', async (outputRate) => {
    const { player, contexts } = rig({}, outputRate);
    player.configure(format(48000));
    player.enqueuePcm(pcm(96000, -32768, 32767));
    expect(contexts).toHaveLength(0);
    expect(player.getBufferedDurationMs()).toBe(0);
    await player.initializeFromUserGesture();
    const ctx = contexts[0]!;
    expect(ctx.sources).toHaveLength(0); // only 2 s, below 3 s preroll
    player.enqueuePcm(pcm(96000, -32768, 32767));
    expect(ctx.sources).toHaveLength(16);
    expect(player.getBufferedDurationMs()).toBeCloseTo(4000);
    expect(player.getStats()).toMatchObject({ priming: true, outputSampleRateHz: outputRate, sourceSampleRateHz: 48000 });
    ctx.advance(0.02);
    expect(player.getStats().priming).toBe(false);
    for (let i = 0; i < ctx.sources.length; i++) {
      const source = ctx.sources[i]!;
      expect(source.startAt).toBeCloseTo(0.02 + i * 0.25);
      expect(source.buffer!.rate).toBe(48000); // browser performs device-rate conversion
      expect(source.buffer!.data[0]![0]).toBe(-1);
      expect(source.buffer!.data[1]![0]).toBe(32767 / 32768);
    }
    ctx.advance(1);
    expect(player.getBufferedDurationMs()).toBeCloseTo(3000);
    expect(player.getStats().underruns).toBe(0);
  });

  it('supports enqueue → init → configure and preserves split stereo frames', async () => {
    const { player, contexts } = rig({ prerollMs: 1, reprimeMs: 1, schedulingLeadMs: 0 });
    const original = pcm(48, 12345, -23456);
    for (let offset = 0; offset < original.byteLength; offset += 3) player.enqueuePcm(original.slice(offset, offset + 3));
    await player.initializeFromUserGesture();
    expect(contexts[0]!.sources).toHaveLength(0);
    player.configure(format());
    const buffers = contexts[0]!.buffers;
    expect(buffers.reduce((sum, b) => sum + b.frames, 0)).toBe(48);
    expect([...buffers[0]!.data[0]!]).toEqual(Array(48).fill(12345 / 32768));
    expect([...buffers[0]!.data[1]!]).toEqual(Array(48).fill(-23456 / 32768));
  });

  it('supports init → configure → enqueue and keeps old-rate audio on reconfigure', async () => {
    const { player, contexts } = rig({ prerollMs: 500, reprimeMs: 500 });
    await player.initializeFromUserGesture();
    player.configure(format(44100));
    player.enqueuePcm(pcm(22050));
    player.configure(format(24000));
    player.enqueuePcm(pcm(12000));
    const ctx = contexts[0]!;
    expect(ctx.buffers.map(b => b.rate)).toEqual([44100, 44100, 24000, 24000]);
    expect(ctx.sources.map(s => s.startAt)).toEqual([0.02, 0.27, 0.52, 0.77]);
    expect(player.getBufferedDurationMs()).toBeCloseTo(1000);
  });

  it('reprimes only after real exhaustion and resumes after the smaller threshold', async () => {
    const { player, contexts } = rig({ schedulingLeadMs: 0 });
    player.configure(format());
    await player.initializeFromUserGesture();
    player.enqueuePcm(pcm(144000));
    const ctx = contexts[0]!;
    ctx.advance(3);
    expect(player.getStats()).toMatchObject({ priming: true, underruns: 1, bufferedMs: 0 });
    player.getStats();
    expect(player.getStats().underruns).toBe(1);
    player.enqueuePcm(pcm(48000));
    expect(player.getStats().priming).toBe(true);
    const before = ctx.sources.length;
    player.enqueuePcm(pcm(24000));
    expect(ctx.sources.length).toBeGreaterThan(before);
    expect(ctx.sources[before]!.startAt).toBe(3);
    expect(player.getStats()).toMatchObject({ priming: false, underruns: 1 });
  });

  it.each(['suspended', 'interrupted'])('reports live %s state, freezes time, and resumes from another gesture', async (pausedState) => {
    const { player, contexts } = rig({ schedulingLeadMs: 0 });
    player.configure(format());
    await player.initializeFromUserGesture();
    player.enqueuePcm(pcm(144000));
    const ctx = contexts[0]!;
    ctx.advance(0.5);
    ctx.setState(pausedState);
    ctx.advance(30);
    expect(player.getStats()).toMatchObject({ state: 'ready', audioContextState: pausedState, priming: false, underruns: 0, bufferedMs: 2500 });
    player.enqueuePcm(pcm(48000));
    expect(player.getBufferedDurationMs()).toBeCloseTo(3500);
    await player.initializeFromUserGesture();
    expect(ctx.resumes).toBe(1);
    expect(player.getStats()).toMatchObject({ audioContextState: 'running', underruns: 0 });
    expect(ctx.sources.at(-1)!.startAt).toBeCloseTo(3.75);
  });

  it('creates context synchronously, shares initialization, and handles stop/init races', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const contexts: FakeContext[] = [];
    const player = new BufferedPCMPlayer({ createAudioContext: () => {
      const ctx = new FakeContext();
      if (!contexts.length) { ctx.state = 'suspended'; ctx.resumeGate = gate; }
      contexts.push(ctx);
      return ctx;
    } });
    player.configure(format());
    player.enqueuePcm(pcm(144000));
    const initial = player.initializeFromUserGesture();
    expect(contexts).toHaveLength(1);
    expect(player.initializeFromUserGesture()).toBe(initial);
    await player.close();
    const next = player.initializeFromUserGesture();
    player.enqueuePcm(pcm(144000));
    await next;
    release();
    await initial;
    expect(contexts[0]!.sources).toHaveLength(0);
    expect(contexts[0]!.closes).toBe(1);
    expect(contexts[1]!.sources).toHaveLength(12);
    expect(player.getStats().state).toBe('ready');
  });

  it('stops/disconnects every source, ignores closed input, and starts clean on reuse', async () => {
    const { player, contexts } = rig({ schedulingLeadMs: 0 });
    player.configure(format());
    await player.initializeFromUserGesture();
    player.enqueuePcm(pcm(144000));
    const ctx = contexts[0]!;
    await player.close();
    await player.close();
    expect(ctx.sources.every(s => s.stops === 1 && s.disconnects === 1 && s.onended === null)).toBe(true);
    expect(ctx.closes).toBe(1);
    expect(ctx.onstatechange).toBeNull();
    player.enqueuePcm(pcm(144000));
    expect(player.getStats()).toMatchObject({ state: 'closed', bufferedMs: 0, priming: true, underruns: 0, droppedFrames: 0 });
    await player.initializeFromUserGesture();
    expect(contexts[1]!.sources).toHaveLength(0);
    player.enqueuePcm(pcm(144000));
    expect(contexts[1]!.sources).toHaveLength(12);
  });

  it('bounds an oversized burst before and after init, dropping whole new frames', async () => {
    const { player, contexts } = rig({ capacityMs: 4000 });
    player.configure(format());
    player.enqueuePcm(pcm(480000));
    expect(player.getStats().droppedFrames).toBe(288000);
    await player.initializeFromUserGesture();
    const ctx = contexts[0]!;
    expect(ctx.sources).toHaveLength(16);
    expect(player.getBufferedDurationMs()).toBeCloseTo(4000);
    player.enqueuePcm(pcm(480000));
    expect(player.getStats().droppedFrames).toBe(768000);
    expect(ctx.sources).toHaveLength(16);
  });

  it('bounds unknown-rate input and trims it when the declared rate is slower', async () => {
    const { player, contexts } = rig({ capacityMs: 4000 });
    player.enqueuePcm(pcm(480000));
    player.configure(format(8000));
    await player.initializeFromUserGesture();
    expect(player.getBufferedDurationMs()).toBeCloseTo(4000);
    expect(contexts[0]!.buffers.reduce((sum, b) => sum + b.frames, 0)).toBe(32000);
    expect(player.getStats().droppedFrames).toBe(448000);
  });

  it('preserves stereo alignment after overflowing a split frame', async () => {
    const { player, contexts } = rig({ prerollMs: 1, reprimeMs: 1, capacityMs: 1, schedulingLeadMs: 0 });
    player.configure(format());
    const bytes = pcm(100, 123, -456);
    player.enqueuePcm(bytes.slice(0, 1));
    player.enqueuePcm(bytes.slice(1, bytes.byteLength - 1));
    await player.initializeFromUserGesture();
    const ctx = contexts[0]!;
    ctx.advance(0.001);
    player.enqueuePcm(bytes.slice(bytes.byteLength - 1));
    player.enqueuePcm(pcm(47, 789, -987));
    const resumed = ctx.buffers.at(-1)!;
    expect(resumed.frames).toBe(48);
    expect(resumed.data[0]![0]).toBe(123 / 32768);
    expect(resumed.data[1]![0]).toBe(-456 / 32768);
    expect(resumed.data[0]![1]).toBe(789 / 32768);
    expect(resumed.data[1]![1]).toBe(-987 / 32768);
  });

  it('coalesces tiny chunks and caps live nodes while retaining only bounded queued audio', async () => {
    const { player, contexts } = rig({ prerollMs: 50, reprimeMs: 50, schedulingLeadMs: 0 });
    player.configure(format());
    await player.initializeFromUserGesture();
    for (let i = 0; i < 500; i++) player.enqueuePcm(pcm(2400));
    const ctx = contexts[0]!;
    expect(ctx.sources).toHaveLength(PENDING_CHUNK_LIMIT);
    expect(player.getBufferedDurationMs()).toBeCloseTo(20000);
    expect(player.getStats().droppedFrames).toBe(240000);
    ctx.advance(0.5);
    expect(ctx.sources.filter(s => s.disconnects === 0).length).toBeLessThanOrEqual(PENDING_CHUNK_LIMIT);
    expect(player.getBufferedDurationMs()).toBeCloseTo(19500);
    expect(player.getStats().underruns).toBe(0);
  });

  it('cleans up failed initialization and permits a subsequent gesture retry', async () => {
    const bad = new FakeContext();
    bad.state = 'suspended';
    bad.resumeGate = Promise.reject(new Error('resume denied'));
    const good = new FakeContext();
    let attempt = 0;
    const retry = new BufferedPCMPlayer({ createAudioContext: () => attempt++ === 0 ? bad : good });
    await expect(retry.initializeFromUserGesture()).rejects.toThrow('resume denied');
    expect(bad.closes).toBe(1);
    expect(retry.getStats().state).toBe('idle');
    await retry.initializeFromUserGesture();
    expect(retry.getStats().state).toBe('ready');
  });

  it('rejects incompatible formats and invalid timing/rates', () => {
    const { player } = rig();
    expect(() => player.configure({ ...format(), channels: 1 } as never)).toThrow(TypeError);
    expect(() => player.configure(format(NaN))).toThrow(RangeError);
    expect(() => player.configure(format(0))).toThrow(RangeError);
    expect(() => createBufferedPCMPlayer({ capacityMs: 100 })).toThrow(RangeError);
  });
});
