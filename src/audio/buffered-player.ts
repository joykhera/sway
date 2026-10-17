// HTTP-compatible PCM playback. AudioBufferSourceNodes run on the audio clock;
// the browser resamples source-rate buffers to the device rate. Main-thread
// stalls can still cause gaps when newly received audio is scheduled too late.
import {
  BYTES_PER_FRAME, CHANNELS, DEFAULT_SAMPLE_RATE_HZ, PREROLL_MS, REPRIME_MS,
  RING_CAPACITY_MS, PENDING_CHUNK_LIMIT,
} from './constants.ts';
import { decodeS16le, PcmByteAssembler } from './decode.ts';
import type { AudioFormat, PCMPlayer, PCMPlayerState, PCMPlayerStats } from './types.ts';

export interface BufferedAudioBufferLike {
  getChannelData(channel: number): Float32Array;
}
export interface BufferedSourceLike {
  buffer: BufferedAudioBufferLike | null;
  onended: ((event: Event) => void) | null;
  connect(destination: AudioNode): unknown;
  disconnect(): void;
  start(when?: number): void;
  stop(): void;
}
export interface BufferedAudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNode;
  onstatechange: ((event: Event) => void) | null;
  createBuffer(channels: number, frames: number, sampleRate: number): BufferedAudioBufferLike;
  createBufferSource(): BufferedSourceLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}
export type BufferedPCMPlayerOptions = {
  createAudioContext?: () => BufferedAudioContextLike;
  prerollMs?: number;
  reprimeMs?: number;
  capacityMs?: number;
  schedulingLeadMs?: number;
};

type Block = { bytes: Uint8Array; frames: number; rate: number };
type Scheduled = { source: BufferedSourceLike; start: number; end: number };
const BLOCK_SECONDS = 0.25;
const MIN_SCHEDULE_SECONDS = 0.05;
const MAX_SOURCE_RATE = 192_000;
const MIN_SOURCE_RATE = 8_000;

/**
 * Bounded scheduled-buffer fallback; keeps the WorkletPCMPlayer lifecycle.
 * Overflow drops newly arriving whole source frames (reported in droppedFrames),
 * preserving already scheduled audio. Small packets coalesce before scheduling;
 * at most PENDING_CHUNK_LIMIT sources and capacityMs of audio are retained.
 */
export class BufferedPCMPlayer implements PCMPlayer {
  private readonly makeContext: () => BufferedAudioContextLike;
  private readonly preroll: number;
  private readonly reprime: number;
  private readonly capacity: number;
  private readonly lead: number;
  private ctx: BufferedAudioContextLike | null = null;
  private initPromise: Promise<void> | null = null;
  private state: PCMPlayerState = 'idle';
  private rate = 0;
  private assembler = new PcmByteAssembler();
  private queue: Block[] = [];
  private sources: Scheduled[] = [];
  private priming = true;
  private hasStarted = false;
  private scheduledUntil = 0;
  private startsAt = 0;
  private underruns = 0;
  private chunksReceived = 0;
  private droppedFrames = 0;

  constructor(opts: BufferedPCMPlayerOptions = {}) {
    this.makeContext = opts.createAudioContext ?? (() => new AudioContext());
    this.preroll = (opts.prerollMs ?? PREROLL_MS) / 1000;
    this.reprime = (opts.reprimeMs ?? REPRIME_MS) / 1000;
    this.capacity = (opts.capacityMs ?? RING_CAPACITY_MS) / 1000;
    this.lead = (opts.schedulingLeadMs ?? 20) / 1000;
    if (![this.preroll, this.reprime, this.capacity, this.lead].every(Number.isFinite)
      || this.preroll <= 0 || this.reprime <= 0 || this.capacity < Math.max(this.preroll, this.reprime)
      || this.lead < 0) throw new RangeError('BufferedPCMPlayer: invalid buffering options');
  }

  initializeFromUserGesture(): Promise<void> {
    if (this.ctx && this.state === 'ready') {
      const ctx = this.ctx;
      // Read the live state; a delayed/missing statechange event must not block resume.
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        return ctx.resume().then(() => { if (this.ctx === ctx) this.pump(); });
      }
      return this.initPromise ?? Promise.resolve();
    }
    if (this.initPromise) return this.initPromise;
    // Synchronous construction preserves browser user-gesture authorization.
    const ctx = this.makeContext();
    this.ctx = ctx;
    this.state = 'initializing';
    ctx.onstatechange = () => { if (this.ctx === ctx) this.pump(); };
    this.initPromise = this.finishInit(ctx).catch(async (error: unknown) => {
      if (this.ctx === ctx) {
        this.ctx = null;
        this.initPromise = null;
        this.state = 'idle';
        ctx.onstatechange = null;
        try { await ctx.close(); } catch { /* already closed */ }
      }
      throw error;
    });
    return this.initPromise;
  }

  private async finishInit(ctx: BufferedAudioContextLike): Promise<void> {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') await ctx.resume();
    if (this.ctx !== ctx) return; // close/re-init while resume was pending
    this.state = 'ready';
    this.pump();
  }

  configure(audio: AudioFormat): void {
    if (audio.format !== 'pcm_s16le' || audio.channels !== CHANNELS) {
      throw new TypeError('BufferedPCMPlayer: expected stereo pcm_s16le');
    }
    if (!Number.isFinite(audio.sampleRateHz) || audio.sampleRateHz < MIN_SOURCE_RATE
      || audio.sampleRateHz > MAX_SOURCE_RATE) {
      throw new RangeError('BufferedPCMPlayer: source sample rate must be 8000–192000 Hz');
    }
    this.rate = audio.sampleRateHz;
    // Unconfigured packets acquire the first declared rate. Previously configured
    // blocks retain their rate when the relay sends a new format after reconnect.
    for (const block of this.queue) if (block.rate === 0) block.rate = this.rate;
    this.trimQueue();
    this.pump();
  }

  enqueuePcm(bytes: ArrayBuffer): void {
    this.chunksReceived++;
    if (this.state === 'closed') return;
    this.refresh();
    const input = new Uint8Array(bytes);
    const totalBytes = this.assembler.carriedBytes + input.length;
    const frames = Math.floor(totalBytes / BYTES_PER_FRAME);
    const rate = this.rate || DEFAULT_SAMPLE_RATE_HZ;
    const available = Math.max(0, Math.floor((this.capacity - this.bufferedSeconds()) * rate + 1e-7));
    const accepted = Math.min(frames, available);
    // Bound allocations even for a single huge incoming burst. Discard only whole
    // frames; feed the final partial frame to the assembler so stereo stays aligned.
    const prefixLength = Math.max(0, accepted * BYTES_PER_FRAME - this.assembler.carriedBytes);
    const aligned = this.assembler.push(input.subarray(0, Math.min(prefixLength, input.length)));
    this.append(aligned);
    if (accepted < frames) {
      this.droppedFrames += frames - accepted;
      this.assembler.reset();
      const tail = totalBytes % BYTES_PER_FRAME;
      if (tail) this.assembler.push(input.subarray(input.length - tail));
    } else if (prefixLength < input.length) {
      this.assembler.push(input.subarray(prefixLength));
    }
    this.pump();
  }

  private append(bytes: Uint8Array): void {
    const blockFrames = Math.max(1, Math.floor((this.rate || DEFAULT_SAMPLE_RATE_HZ) * BLOCK_SECONDS));
    let offset = 0;
    while (offset < bytes.length) {
      let block = this.queue.at(-1);
      if (!block || block.rate !== this.rate || block.frames === block.bytes.length / BYTES_PER_FRAME) {
        block = { bytes: new Uint8Array(blockFrames * BYTES_PER_FRAME), frames: 0, rate: this.rate };
        this.queue.push(block);
      }
      const count = Math.min(bytes.length - offset, block.bytes.length - block.frames * BYTES_PER_FRAME);
      block.bytes.set(bytes.subarray(offset, offset + count), block.frames * BYTES_PER_FRAME);
      block.frames += count / BYTES_PER_FRAME;
      offset += count;
    }
  }

  private queuedSeconds(): number {
    return this.queue.reduce((sum, b) => sum + b.frames / (b.rate || DEFAULT_SAMPLE_RATE_HZ), 0);
  }

  private bufferedSeconds(): number {
    const now = this.ctx?.currentTime ?? 0;
    return this.queuedSeconds() + this.sources.reduce((sum, s) => sum + Math.max(0, s.end - Math.max(now, s.start)), 0);
  }

  private trimQueue(): void {
    let excess = this.bufferedSeconds() - this.capacity;
    while (excess > 1e-8 && this.queue.length) {
      const block = this.queue.at(-1)!;
      const rate = block.rate || DEFAULT_SAMPLE_RATE_HZ;
      const removed = Math.min(block.frames, Math.ceil(excess * rate));
      block.frames -= removed;
      this.droppedFrames += removed;
      excess -= removed / rate;
      if (!block.frames) this.queue.pop();
    }
  }

  private refresh(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const remaining: Scheduled[] = [];
    for (const entry of this.sources) {
      if (entry.end <= ctx.currentTime) {
        entry.source.onended = null;
        entry.source.disconnect();
      } else remaining.push(entry);
    }
    this.sources = remaining;
    if (!this.priming && ctx.state === 'running' && ctx.currentTime >= this.scheduledUntil) {
      this.priming = true;
      this.underruns++;
    }
  }

  private pump(): void {
    this.refresh();
    const ctx = this.ctx;
    if (!ctx || this.state !== 'ready' || !this.rate || ctx.state !== 'running') return;
    const queued = this.queuedSeconds();
    if (this.priming) {
      if (queued + 1e-8 < (this.hasStarted ? this.reprime : this.preroll)) return;
      this.priming = false;
      this.hasStarted = true;
      this.startsAt = ctx.currentTime + this.lead;
      this.scheduledUntil = this.startsAt;
    } else if (queued < MIN_SCHEDULE_SECONDS) return;

    while (this.queue.length && this.sources.length < PENDING_CHUNK_LIMIT) {
      const block = this.queue.shift()!;
      const buffer = ctx.createBuffer(CHANNELS, block.frames, block.rate);
      const interleaved = new Float32Array(block.frames * CHANNELS);
      decodeS16le(block.bytes.subarray(0, block.frames * BYTES_PER_FRAME), interleaved);
      for (let channel = 0; channel < CHANNELS; channel++) {
        const output = buffer.getChannelData(channel);
        for (let frame = 0; frame < block.frames; frame++) output[frame] = interleaved[frame * CHANNELS + channel]!;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const start = this.scheduledUntil;
      const end = start + block.frames / block.rate;
      this.sources.push({ source, start, end });
      this.scheduledUntil = end;
      source.onended = () => { if (this.ctx === ctx) this.pump(); };
      source.start(start);
    }
  }

  getBufferedDurationMs(): number {
    this.refresh();
    return this.ctx ? this.bufferedSeconds() * 1000 : 0;
  }

  getStats(): PCMPlayerStats {
    this.refresh();
    return {
      state: this.state,
      audioContextState: this.ctx?.state,
      bufferedMs: this.getBufferedDurationMs(),
      underruns: this.underruns,
      chunksReceived: this.chunksReceived,
      droppedFrames: this.droppedFrames,
      priming: this.priming || (this.ctx !== null && this.ctx.currentTime < this.startsAt),
      outputSampleRateHz: this.ctx?.sampleRate ?? 0,
      sourceSampleRateHz: this.rate,
    };
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const ctx = this.ctx;
    this.ctx = null;
    this.initPromise = null;
    if (ctx) ctx.onstatechange = null;
    for (const { source } of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* already ended */ }
      source.disconnect();
    }
    this.sources = [];
    this.queue = [];
    this.assembler.reset();
    this.priming = true;
    this.hasStarted = false;
    this.scheduledUntil = this.startsAt = this.underruns = this.droppedFrames = 0;
    if (ctx) { try { await ctx.close(); } catch { /* already closed */ } }
  }
}

export function createBufferedPCMPlayer(opts: BufferedPCMPlayerOptions = {}): BufferedPCMPlayer {
  return new BufferedPCMPlayer(opts);
}
