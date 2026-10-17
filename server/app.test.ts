import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MUSIC_WS_PATH } from '../src/shared/protocol.ts';
import type { ServerMessage } from '../src/shared/protocol.ts';
import { createRelay } from './app.ts';
import type { Relay } from './app.ts';
import { createStreamSlots } from './limits.ts';
import { createMockFactory } from './upstream/mock.ts';

let relay: Relay;
let port: number;
const slots = createStreamSlots(5);

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  relay = createRelay({ createUpstream: createMockFactory(), slots });
  port = await relay.listen(0);
});

afterEach(async () => {
  await relay.close();
  vi.restoreAllMocks();
});

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('relay (mock mode)', () => {
  it('serves /healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await res.text()).toBe('ok');
  });

  it('routes same-origin intent requests without allocating a music stream', async () => {
    await relay.close();
    const interpretIntent = vi.fn().mockResolvedValue({ status: 'clarify', message: 'Which musical qualities?' });
    relay = createRelay({ createUpstream: createMockFactory(), slots, interpretIntent });
    port = await relay.listen(0);
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/intent`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Warm sound', purpose: 'focus', currentFeatures: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'clarify', message: 'Which musical qualities?' });
    expect(interpretIntent).toHaveBeenCalledOnce();
    expect(slots.inUse).toBe(0);
    expect(relay.sessions.size).toBe(0);
  });

  it('refuses upgrades on other paths', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    await expect(new Promise((resolve, reject) => ws.on('open', resolve).on('error', reject))).rejects.toThrow();
  });

  it('streams status, ready and binary PCM, then cleans up on close', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MUSIC_WS_PATH}`);
    const json: ServerMessage[] = [];
    const binary: Buffer[] = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) binary.push(data as Buffer);
      else json.push(JSON.parse(data.toString()) as ServerMessage);
    });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'start', prompts: [{ text: 'lofi', weight: 1 }] }));
    await until(() => binary.length >= 3);
    expect(json.slice(0, 3)).toEqual([
      { type: 'status', state: 'connecting' },
      { type: 'ready', audio: { format: 'pcm_s16le', sampleRateHz: 48000, channels: 2 }, prefetch: true },
      { type: 'status', state: 'playing' },
    ]);
    expect(binary.every((b) => b.length % 4 === 0)).toBe(true);
    expect(slots.inUse).toBe(1);

    ws.send(JSON.stringify({ type: 'steer', revision: 1, prompts: [{ text: 'jazz', weight: 0 }] }));
    ws.send(Buffer.from([1, 2, 3]));
    await until(() => json.filter((m) => m.type === 'error').length >= 2);
    expect(json.filter((m) => m.type === 'error').map((m) => m.type === 'error' && m.code)).toEqual([
      'bad_message',
      'bad_message',
    ]);

    const [session] = relay.sessions;
    ws.close();
    await until(() => relay.sessions.size === 0);
    expect(session?.state).toBe('closed');
    expect(slots.inUse).toBe(0);
  });

  it('prefetches and resumes through the existing WebSocket without replacing its upstream', async () => {
    await relay.close();
    const starts = vi.fn();
    const pauses = vi.fn();
    const resumes = vi.fn();
    const closes = vi.fn();
    relay = createRelay({ slots, createUpstream: events => ({
      async start() {
        starts();
        events.onAudio(Buffer.alloc(48000 * 4 * 3, 1), { sampleRateHz: 48000, channels: 2 });
      },
      async steer() {},
      pause: pauses,
      resume() {
        resumes();
        events.onAudio(Buffer.alloc(4800 * 4, 2), { sampleRateHz: 48000, channels: 2 });
      },
      close: closes,
    }) });
    port = await relay.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MUSIC_WS_PATH}`);
    const messages: ServerMessage[] = [];
    const audio: Buffer[] = [];
    ws.on('message', (data, binary) => {
      if (binary) audio.push(data as Buffer);
      else messages.push(JSON.parse(data.toString()) as ServerMessage);
    });
    await new Promise(resolve => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'start', prompts: [{ text: 'piano', weight: 1 }], prefetchMs: 3000 }));
    await until(() => messages.some(message => message.type === 'status' && message.state === 'paused'));
    expect(audio.map(chunk => chunk[0])).toEqual([1]);
    expect(pauses).toHaveBeenCalledOnce();
    expect(slots.inUse).toBe(1);
    ws.send(JSON.stringify({ type: 'resume' }));
    await until(() => audio.length === 2);
    expect(audio.map(chunk => chunk[0])).toEqual([1, 2]);
    expect(starts).toHaveBeenCalledOnce();
    expect(resumes).toHaveBeenCalledOnce();
    expect(messages.filter(message => message.type === 'ready')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'error')).toHaveLength(0);
    ws.send(JSON.stringify({ type: 'stop' }));
    await until(() => slots.inUse === 0);
    expect(closes).toHaveBeenCalledOnce();
    ws.close();
    await until(() => relay.sessions.size === 0);
  });
});
