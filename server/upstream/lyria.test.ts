import { describe, expect, it, vi } from 'vitest';
import type {
  LiveMusicCallbacks,
  LiveMusicServerMessage,
} from '@google/genai';
import { LyriaUpstream } from './lyria.ts';
import type { LyriaSessionLike } from './lyria.ts';
import type { UpstreamCallbacks } from './types.ts';

const SENTINEL_KEY = 'AIza_SENTINEL_SECRET_0123456789';
const PROMPTS_A = [{ text: 'A pad', weight: 1 }];
const PROMPTS_B = [{ text: 'B pad', weight: 1 }];
const PROMPTS_C = [{ text: 'C pad', weight: 1 }];

const tick = () => new Promise((r) => setTimeout(r, 0));

type Call = { kind: string; detail?: unknown };

function fakeConnect() {
  const calls: Call[] = [];
  let callbacks: LiveMusicCallbacks | null = null;
  let promptsGate: Promise<void> | null = null;
  const session: LyriaSessionLike = {
    setWeightedPrompts: vi.fn(async (p: unknown) => {
      calls.push({ kind: 'prompts', detail: p });
      if (promptsGate) await promptsGate;
    }),
    setMusicGenerationConfig: vi.fn(async (p: unknown) => {
      calls.push({ kind: 'config', detail: p });
    }),
    play: vi.fn(() => {
      calls.push({ kind: 'play' });
    }),
    close: vi.fn(() => {
      calls.push({ kind: 'close' });
    }),
  };
  return {
    session,
    calls,
    connect: vi.fn(async (cb: LiveMusicCallbacks) => {
      callbacks = cb;
      return session;
    }),
    emit: (m: Partial<LiveMusicServerMessage>) =>
      callbacks?.onmessage(m as LiveMusicServerMessage),
    closeSocket: (e?: { code?: number; reason?: string }) =>
      callbacks?.onclose?.(e as CloseEvent),
    errorSocket: (e?: { message?: string }) =>
      callbacks?.onerror?.(e as ErrorEvent),
    setPromptsGate: (p: Promise<void> | null) => {
      promptsGate = p;
    },
  };
}

function sink(): { cb: UpstreamCallbacks; audio: Buffer[]; filtered: string[][]; closed: (string | undefined)[]; warnings: string[] } {
  const audio: Buffer[] = [];
  const filtered: string[][] = [];
  const closed: (string | undefined)[] = [];
  const warnings: string[] = [];
  return {
    audio,
    filtered,
    closed,
    warnings,
    cb: {
      onAudio: (b) => audio.push(b),
      onFiltered: (p) => filtered.push(p),
      onWarning: (m) => warnings.push(m),
      onClosed: (r) => closed.push(r),
    },
  };
}

function startUpstream(extra?: { connect?: ReturnType<typeof fakeConnect>['connect'] }) {
  const f = extra?.connect ? null : fakeConnect();
  const connect = extra?.connect ?? f!.connect;
  const up = new LyriaUpstream({ apiKey: SENTINEL_KEY, connect });
  return { up, f: f! };
}

describe('LyriaUpstream', () => {
  it('sends nothing until setupComplete; resolves start with 48k stereo format', async () => {
    const { up, f } = startUpstream();
    const { cb } = sink();
    const p = up.start(
      { prompts: PROMPTS_A, config: { density: 0.5, temperature: 1.2 } },
      cb,
    );
    await tick();
    expect(f.calls).toEqual([]); // connect resolved (socket open) but no sends yet
    f.emit({ setupComplete: {} });
    const { audio } = await p;
    expect(audio).toEqual({
      format: 'pcm_s16le',
      sampleRateHz: 48000,
      channels: 2,
    });
    await tick();
    expect(f.calls.map((c) => c.kind)).toEqual(['prompts', 'config', 'play']);
    expect(f.calls[0]?.detail).toEqual({ weightedPrompts: PROMPTS_A });
    expect(f.calls[1]?.detail).toEqual({
      musicGenerationConfig: { density: 0.5, temperature: 1.2 },
    });
  });

  it('steer before setupComplete queues the newest prompt set only', async () => {
    const { up, f } = startUpstream();
    const { cb } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    up.steer(PROMPTS_B);
    up.steer(PROMPTS_C);
    f.emit({ setupComplete: {} });
    await p;
    await tick();
    const promptCalls = f.calls.filter((c) => c.kind === 'prompts');
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.detail).toEqual({ weightedPrompts: PROMPTS_C });
  });

  it('coalesces steers newest-wins while a send is in flight', async () => {
    const { up, f } = startUpstream();
    const { cb } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    // Hold the first setWeightedPrompts in-flight.
    let release: (() => void) | null = null;
    f.setPromptsGate(new Promise<void>((r) => (release = r)));
    f.emit({ setupComplete: {} });
    await p;
    up.steer(PROMPTS_B);
    up.steer(PROMPTS_C);
    release!();
    f.setPromptsGate(null);
    await tick();
    await tick();
    const promptCalls = f.calls.filter((c) => c.kind === 'prompts');
    expect(promptCalls).toHaveLength(2); // A (in-flight) then newest C — B dropped
    expect(promptCalls[0]?.detail).toEqual({ weightedPrompts: PROMPTS_A });
    expect(promptCalls[1]?.detail).toEqual({ weightedPrompts: PROMPTS_C });
  });

  it('decodes base64 audioChunks → onAudio Buffers', async () => {
    const { up, f } = startUpstream();
    const { cb, audio } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    f.emit({ setupComplete: {} });
    await p;
    const payload = Buffer.from('hello pcm').toString('base64');
    f.emit({
      serverContent: {
        audioChunks: [{ data: payload, mimeType: 'audio/pcm;rate=48000' }],
      },
    });
    expect(audio).toHaveLength(1);
    expect(audio[0]?.toString()).toBe('hello pcm');
  });

  it('warns when mimeType reports a different sample rate', async () => {
    const { up, f } = startUpstream();
    const { cb, warnings } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    f.emit({ setupComplete: {} });
    await p;
    f.emit({
      serverContent: {
        audioChunks: [{ data: 'AA==', mimeType: 'audio/pcm;rate=44100' }],
      },
    });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain('44100');
  });

  it('filteredPrompt → onFiltered', async () => {
    const { up, f } = startUpstream();
    const { cb, filtered } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    f.emit({ setupComplete: {} });
    await p;
    f.emit({ filteredPrompt: { text: 'banned thing', filteredReason: 'policy' } });
    expect(filtered).toEqual([['banned thing']]);
  });

  it('socket close after start → onClosed; close() suppresses onClosed', async () => {
    const { up, f } = startUpstream();
    const { cb, closed } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    f.emit({ setupComplete: {} });
    await p;
    f.closeSocket({ code: 1006, reason: 'abnormal' });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain('1006');
  });

  it('socket close BEFORE setupComplete rejects start (no onClosed)', async () => {
    const { up, f } = startUpstream();
    const { cb, closed } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    f.closeSocket({ code: 1006 });
    await expect(p).rejects.toThrow(/closed/);
    expect(closed).toHaveLength(0);
  });

  it('socket error before setupComplete rejects start', async () => {
    const { up, f } = startUpstream();
    const { cb } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    f.errorSocket({ message: 'boom' });
    await expect(p).rejects.toThrow(/boom/);
  });

  it('close() is idempotent and never reports onClosed', async () => {
    const { up, f } = startUpstream();
    const { cb, closed } = sink();
    const p = up.start({ prompts: PROMPTS_A }, cb);
    await tick();
    f.emit({ setupComplete: {} });
    await p;
    await up.close();
    await up.close();
    f.closeSocket({ code: 1000 }); // server echoes our close — must not report
    expect(closed).toHaveLength(0);
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });

  it('connect() rejection propagates as start() failure', async () => {
    const connect = vi.fn(async () => {
      throw new Error('no socket');
    });
    const up = new LyriaUpstream({ apiKey: SENTINEL_KEY, connect });
    const { cb } = sink();
    await expect(up.start({ prompts: PROMPTS_A }, cb)).rejects.toThrow(
      'no socket',
    );
  });

  it('never leaks the API key into messages or logs', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { up, f } = startUpstream();
      const { cb } = sink();
      const p = up.start({ prompts: PROMPTS_A }, cb);
      await tick();
      f.emit({ setupComplete: {} });
      await p;
      up.steer(PROMPTS_B);
      f.emit({ filteredPrompt: { text: 'x' } });
      f.errorSocket({ message: 'died' });
      await tick();
      for (const call of f.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL_KEY);
      }
      for (const spy of [out, err]) {
        for (const c of spy.mock.calls) {
          expect(String(c[0])).not.toContain(SENTINEL_KEY);
        }
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
