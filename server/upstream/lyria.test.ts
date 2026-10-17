import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLyriaFactory, parseAudioFormat } from './lyria.ts';
import type { UpstreamEvents } from './types.ts';

type Callbacks = {
  onmessage: (m: object) => void;
  onclose?: (e: { code: number; reason: string }) => void;
};

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  callbacks: undefined as Callbacks | undefined,
  openNow: true,
  afterPrompts: undefined as (() => void) | undefined,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    live = {
      music: {
        connect: async (params: { callbacks: Callbacks }) => {
          fake.callbacks = params.callbacks;
          if (!fake.openNow) return new Promise(() => {});
          return {
            setWeightedPrompts: async (p: unknown) => {
              fake.calls.push(`prompts ${JSON.stringify(p)}`);
              fake.afterPrompts?.();
            },
            setMusicGenerationConfig: async (p: unknown) => void fake.calls.push(`config ${JSON.stringify(p)}`),
            play: () => void fake.calls.push('play'),
            pause: () => void fake.calls.push('pause'),
            close: () => void fake.calls.push('close'),
          };
        },
      },
    };
  },
}));

function events(): UpstreamEvents & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onAudio: (b, f) => log.push(`audio ${b.toString()} ${f.sampleRateHz}`),
    onFiltered: (i) => log.push(`filtered ${i.text}`),
    onWarning: (m) => log.push(`warning ${m}`),
    onClosed: (r) => log.push(`closed ${r}`),
  };
}

beforeEach(() => {
  fake.calls = [];
  fake.callbacks = undefined;
  fake.openNow = true;
  fake.afterPrompts = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('lyria adapter (fake SDK)', () => {
  it('waits for setupComplete before sending prompts, config and play', async () => {
    const ev = events();
    const up = createLyriaFactory('k')(ev);
    const started = up.start([{ text: 'a', weight: 1 }], { density: 0.3 });
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.calls).toEqual([]);
    fake.callbacks!.onmessage({ setupComplete: {} });
    await started;
    expect(fake.calls).toEqual([
      'prompts {"weightedPrompts":[{"text":"a","weight":1}]}',
      'config {"musicGenerationConfig":{"density":0.3}}',
      'play',
    ]);
    fake.callbacks!.onmessage({
      serverContent: { audioChunks: [{ data: Buffer.from('pcm').toString('base64'), mimeType: 'audio/l16;rate=44100' }] },
      filteredPrompt: { text: 'bad' },
      warning: 'w',
    });
    expect(ev.log).toEqual(['audio pcm 44100', 'filtered bad', 'warning {"warning":"w"}']);
  });

  it('rejects start when the socket closes before setup, without firing twice after close()', async () => {
    fake.openNow = false;
    const ev = events();
    const up = createLyriaFactory('k')(ev);
    const started = up.start([{ text: 'a', weight: 1 }], {});
    await new Promise((r) => setTimeout(r, 0));
    fake.callbacks!.onclose?.({ code: 1008, reason: 'quota' });
    await expect(started).rejects.toThrow(/closed before setup/);
    expect(ev.log).toEqual(['closed code=1008 reason=quota']);
    up.close();
    fake.callbacks!.onclose?.({ code: 1000, reason: '' });
    expect(ev.log).toHaveLength(1);
  });

  it('resends the full config on config steers', async () => {
    const up = createLyriaFactory('k')(events());
    const started = up.start([{ text: 'a', weight: 1 }], {});
    await new Promise((r) => setTimeout(r, 0));
    fake.callbacks!.onmessage({ setupComplete: {} });
    await started;
    fake.calls = [];
    await up.steer([{ text: 'b', weight: 1 }], { density: 0.1, brightness: 0.9 });
    expect(fake.calls[1]).toBe('config {"musicGenerationConfig":{"density":0.1,"brightness":0.9}}');
    up.close();
    expect(fake.calls.at(-1)).toBe('close');
  });

  it('pauses and resumes the existing SDK session without resetting prompts or context', async () => {
    const up = createLyriaFactory('k')(events());
    const started = up.start([{ text: 'a', weight: 1 }], {});
    fake.callbacks!.onmessage({ setupComplete: {} });
    await started;
    fake.calls = [];
    up.pause!();
    up.resume!();
    expect(fake.calls).toEqual(['pause', 'play']);
    up.close();
    up.pause!();
    up.resume!();
    expect(fake.calls).toEqual(['pause', 'play', 'close']);
  });

  it('does not resurrect a cancelled setup after sending prompts', async () => {
    const up = createLyriaFactory('k')(events());
    fake.afterPrompts = () => up.close();
    const started = up.start([{ text: 'a', weight: 1 }], { density: 0.4 });
    fake.callbacks!.onmessage({ setupComplete: {} });
    await expect(started).rejects.toThrow('closed during setup');
    expect(fake.calls).toEqual(['prompts {"weightedPrompts":[{"text":"a","weight":1}]}', 'close']);
  });
});

describe('parseAudioFormat', () => {
  it('defaults to 48 kHz stereo', () => {
    expect(parseAudioFormat(undefined)).toEqual({ sampleRateHz: 48000, channels: 2 });
    expect(parseAudioFormat('audio/pcm')).toEqual({ sampleRateHz: 48000, channels: 2 });
  });

  it('reads rate and channels from the mime type', () => {
    expect(parseAudioFormat('audio/l16;rate=44100;channels=1')).toEqual({ sampleRateHz: 44100, channels: 1 });
  });
});
