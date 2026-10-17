// WorkletPCMPlayer tests with injected Web Audio fakes (node env: no DOM audio).
// `worklet-url.ts` is mocked so the `?worker&url` import of the sibling-owned
// `pcm-worklet.ts` is never resolved here.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./worklet-url.ts', () => ({ workletUrl: 'mock://pcm-worklet.js' }));

import {
  WorkletPCMPlayer,
  createPCMPlayer,
  type AudioContextLike,
  type WorkletNodeLike,
} from './pcm-player.ts';
import type { WorkletInbound, WorkletOutbound } from './types.ts';
import { PENDING_CHUNK_LIMIT } from './constants.ts';

// ── Fakes ────────────────────────────────────────────────────────────────────

type FakeCtx = AudioContextLike & {
  calls: string[];
  resumes: number;
  closes: number;
  modules: string[];
  setState(state: string): void;
};

type FakeCtxOptions = {
  state?: string;
  sampleRate?: number;
  /** When set, addModule returns this promise instead of resolving immediately. */
  addModuleGate?: Promise<void>;
};

function makeFakeCtx(opts: FakeCtxOptions = {}): FakeCtx {
  const ctx = {
    calls: [] as string[],
    resumes: 0,
    closes: 0,
    modules: [] as string[],
    sampleRate: opts.sampleRate ?? 48000,
    state: opts.state ?? 'running',
    destination: {} as AudioNode,
    onstatechange: null as ((event: Event) => void) | null,
    audioWorklet: {
      addModule: (url: string) => {
        ctx.calls.push('addModule');
        ctx.modules.push(url);
        return opts.addModuleGate ?? Promise.resolve();
      },
    },
    resume: () => {
      ctx.calls.push('resume');
      ctx.resumes++;
      ctx.state = 'running';
      return Promise.resolve();
    },
    close: () => {
      ctx.calls.push('close');
      ctx.closes++;
      ctx.state = 'closed';
      return Promise.resolve();
    },
    setState(state: string) {
      ctx.state = state;
      ctx.onstatechange?.(new Event('statechange'));
    },
  };
  return ctx;
}

type Posted = { message: WorkletInbound; transfer: Transferable[] | undefined };

class FakeWorkletNode implements WorkletNodeLike {
  readonly posted: Posted[] = [];
  readonly connections: unknown[] = [];
  disconnects = 0;
  starts = 0;
  readonly port = {
    onmessage: null as ((event: { data: WorkletOutbound }) => void) | null,
    postMessage: (message: WorkletInbound, transfer?: Transferable[]) => {
      this.posted.push({ message, transfer });
    },
    start: () => {
      this.starts++;
    },
  };
  connect(destination: unknown) {
    this.connections.push(destination);
  }
  disconnect() {
    this.disconnects++;
  }
  /** Emit a worklet → main-thread stats message. */
  emitStats(data: Omit<WorkletOutbound, 'type'>) {
    this.port.onmessage?.({ data: { type: 'stats', ...data } });
  }
}

type Rig = {
  player: WorkletPCMPlayer;
  contexts: FakeCtx[];
  nodes: FakeWorkletNode[];
};

function makeRig(ctxOpts: FakeCtxOptions = {}): Rig {
  const contexts: FakeCtx[] = [];
  const nodes: FakeWorkletNode[] = [];
  const player = new WorkletPCMPlayer({
    createAudioContext: () => {
      const ctx = makeFakeCtx(ctxOpts);
      contexts.push(ctx);
      return ctx;
    },
    createWorkletNode: () => {
      const node = new FakeWorkletNode();
      nodes.push(node);
      return node;
    },
    workletUrl: 'mock://pcm-worklet.js',
  });
  return { player, contexts, nodes };
}

const ready = { format: 'pcm_s16le', sampleRateHz: 48000, channels: 2 } as const;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkletPCMPlayer', () => {
  it('flushes configure + queued pcm in order after init', async () => {
    const { player, nodes } = makeRig();
    player.configure({ ...ready });
    player.enqueuePcm(new ArrayBuffer(8));
    player.enqueuePcm(new ArrayBuffer(12));
    await player.initializeFromUserGesture();

    expect(nodes).toHaveLength(1);
    const posted = nodes[0]!.posted;
    expect(posted.map((p) => p.message.type)).toEqual(['configure', 'pcm', 'pcm']);
    const cfg = posted[0]!.message;
    expect(cfg).toEqual({ type: 'configure', sourceSampleRateHz: 48000 });
    const pcm = posted[1]!.message;
    expect(pcm.type === 'pcm' && pcm.bytes.byteLength).toBe(8);
    expect(nodes[0]!.starts).toBe(1);
    expect(nodes[0]!.connections).toHaveLength(1);
  });

  it('sends pcm buffers in a non-empty transfer list (detach semantics)', async () => {
    const { player, nodes } = makeRig();
    player.configure({ ...ready });
    await player.initializeFromUserGesture();

    const bytes = new ArrayBuffer(16);
    player.enqueuePcm(bytes);
    const last = nodes[0]!.posted.at(-1)!;
    expect(last.message).toEqual({ type: 'pcm', bytes });
    expect(last.transfer).toBeDefined();
    expect(last.transfer).toContain(bytes);
    expect(last.transfer).not.toHaveLength(0);
  });

  it('initializeFromUserGesture is idempotent: same promise, one addModule, one node', async () => {
    let resolveModule!: () => void;
    const gate = new Promise<void>((r) => {
      resolveModule = r;
    });
    const { player, contexts, nodes } = makeRig({ addModuleGate: gate });

    const p1 = player.initializeFromUserGesture();
    const p2 = player.initializeFromUserGesture();
    expect(p2).toBe(p1); // same in-flight promise
    resolveModule();
    await p1;

    const p3 = player.initializeFromUserGesture();
    expect(p3).toBe(p1); // same settled promise
    expect(contexts[0]!.modules).toEqual(['mock://pcm-worklet.js']);
    expect(contexts).toHaveLength(1);
    expect(nodes).toHaveLength(1);
  });

  it('resumes a suspended ctx before addModule', async () => {
    const { player, contexts } = makeRig({ state: 'suspended' });
    await player.initializeFromUserGesture();
    expect(contexts[0]!.calls.slice(0, 2)).toEqual(['resume', 'addModule']);
    expect(contexts[0]!.resumes).toBe(1);
  });

  it('re-resumes on a later gesture when the ctx slipped back to suspended', async () => {
    const { player, contexts } = makeRig();
    await player.initializeFromUserGesture();
    const ctx = contexts[0]!;
    expect(ctx.resumes).toBe(0); // started running

    ctx.setState('suspended'); // onstatechange fires → flags resumeNeeded
    await player.initializeFromUserGesture();
    expect(ctx.resumes).toBe(1);
    // No re-init: still one ctx and one node.
    expect(contexts).toHaveLength(1);
  });

  it('reports live context suspension and resumption even when cached worklet stats remain playable', async () => {
    const { player, contexts, nodes } = makeRig();
    await player.initializeFromUserGesture();
    const ctx = contexts[0]!;
    nodes[0]!.emitStats({ bufferedMs: 250, underruns: 0, droppedFrames: 0, priming: false });
    expect(player.getStats()).toMatchObject({ state: 'ready', priming: false, audioContextState: 'running' });

    ctx.setState('suspended');
    expect(player.getStats()).toMatchObject({ state: 'ready', priming: false, audioContextState: 'suspended' });

    // No new worklet message: getStats must read the live context, not cached stats.
    await player.initializeFromUserGesture();
    expect(ctx.resumes).toBe(1);
    expect(player.getStats()).toMatchObject({ state: 'ready', priming: false, audioContextState: 'running' });
    expect(player.getBufferedDurationMs()).toBe(250);
  });

  it('close() resets the node, closes the ctx, and makes enqueuePcm a no-op', async () => {
    const { player, contexts, nodes } = makeRig();
    player.configure({ ...ready });
    await player.initializeFromUserGesture();
    const node = nodes[0]!;
    const ctx = contexts[0]!;
    const postedBefore = node.posted.length;

    await player.close();
    expect(node.posted.at(-1)!.message).toEqual({ type: 'reset' });
    expect(node.port.onmessage).toBeNull();
    expect(node.disconnects).toBe(1);
    expect(ctx.closes).toBe(1);
    expect(player.getStats().state).toBe('closed');

    player.enqueuePcm(new ArrayBuffer(8));
    expect(node.posted.length).toBe(postedBefore + 1); // only the reset got added
    await player.close(); // idempotent
    expect(ctx.closes).toBe(1);
  });

  it('builds a fresh ctx/node on init after close()', async () => {
    const { player, contexts, nodes } = makeRig();
    await player.initializeFromUserGesture();
    await player.close();
    await player.initializeFromUserGesture();
    expect(contexts).toHaveLength(2);
    expect(nodes).toHaveLength(2);
    expect(contexts[1]!.modules).toEqual(['mock://pcm-worklet.js']);
  });

  it('configure() rejects non-pcm_s16le formats and non-stereo channel counts', () => {
    const { player } = makeRig();
    expect(() =>
      player.configure({ format: 'opus' as never, sampleRateHz: 48000, channels: 2 }),
    ).toThrow(TypeError);
    expect(() =>
      player.configure({ format: 'pcm_s16le', sampleRateHz: 48000, channels: 1 as never }),
    ).toThrow(TypeError);
    expect(() => player.configure({ ...ready })).not.toThrow();
  });

  it('repeated configure() mid-stream posts the new source rate to the node', async () => {
    const { player, nodes } = makeRig();
    player.configure({ ...ready });
    await player.initializeFromUserGesture();
    player.configure({ format: 'pcm_s16le', sampleRateHz: 44100, channels: 2 });
    expect(nodes[0]!.posted.at(-1)!.message).toEqual({
      type: 'configure',
      sourceSampleRateHz: 44100,
    });
    expect(player.getStats().sourceSampleRateHz).toBe(44100);
  });

  it('getBufferedDurationMs() is 0 before stats and reflects emitted stats', async () => {
    const { player, nodes } = makeRig();
    expect(player.getBufferedDurationMs()).toBe(0);
    await player.initializeFromUserGesture();
    expect(player.getBufferedDurationMs()).toBe(0);

    nodes[0]!.emitStats({ bufferedMs: 250, underruns: 2, droppedFrames: 3, priming: false });
    expect(player.getBufferedDurationMs()).toBe(250);
    const stats = player.getStats();
    expect(stats).toMatchObject({
      state: 'ready',
      bufferedMs: 250,
      underruns: 2,
      droppedFrames: 3,
      priming: false,
      outputSampleRateHz: 48000,
    });
  });

  it('caps the pending queue at PENDING_CHUNK_LIMIT, dropping the oldest', async () => {
    const { player, nodes } = makeRig();
    player.configure({ ...ready });
    const total = PENDING_CHUNK_LIMIT + 10;
    for (let i = 0; i < total; i++) player.enqueuePcm(new ArrayBuffer(4 + i)); // tag by length
    await player.initializeFromUserGesture();

    const pcmMsgs = nodes[0]!.posted.filter((p) => p.message.type === 'pcm');
    expect(pcmMsgs).toHaveLength(PENDING_CHUNK_LIMIT);
    // First 10 (byteLength 4..13) were dropped; the queue kept the newest.
    const first = pcmMsgs[0]!.message;
    const last = pcmMsgs.at(-1)!.message;
    expect(first.type === 'pcm' && first.bytes.byteLength).toBe(4 + 10);
    expect(last.type === 'pcm' && last.bytes.byteLength).toBe(4 + total - 1);
  });

  it('createPCMPlayer() returns a PCMPlayer (default factories)', () => {
    const player = createPCMPlayer({
      createAudioContext: () => makeFakeCtx(),
      createWorkletNode: () => new FakeWorkletNode(),
      workletUrl: 'mock://x',
    });
    expect(typeof player.initializeFromUserGesture).toBe('function');
    expect(typeof player.close).toBe('function');
  });
});
