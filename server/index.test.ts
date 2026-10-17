import { once } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from './index.ts';
import type { Config } from './config.ts';
import { MUSIC_WS_PATH } from '../src/shared/protocol.ts';
import type { ServerMessage } from '../src/shared/protocol.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    musicMode: 'mock',
    maxStreams: 5,
    distDir: path.join(os.tmpdir(), 'sway-test-no-such-dist'),
    ...overrides,
  };
}

async function boot(config: Config) {
  const handle = startServer(config);
  await once(handle.server, 'listening');
  const port = (handle.server.address() as AddressInfo).port;
  return {
    ...handle,
    port,
    wsUrl: `ws://127.0.0.1:${port}${MUSIC_WS_PATH}`,
    httpUrl: `http://127.0.0.1:${port}`,
  };
}

function httpGet(url: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            type: String(res.headers['content-type'] ?? ''),
          }),
        );
      })
      .on('error', reject);
  });
}

function wsCollect(url: string) {
  const ws = new WebSocket(url);
  const messages: ServerMessage[] = [];
  const binary: Buffer[] = [];
  const closed: { code: number }[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) binary.push(data as Buffer);
    else messages.push(JSON.parse(String(data)));
  });
  ws.on('close', (code) => closed.push({ code }));
  return { ws, messages, binary, closed };
}

async function wsReady(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.OPEN) return;
  await once(ws, 'open');
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(5);
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('relay server', () => {
  it('GET /healthz → 200 {"ok":true}', async () => {
    const srv = await boot(testConfig());
    cleanups.push(srv.close);
    const res = await httpGet(`${srv.httpUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('ws connect → start → ready → playing → binary audio frames', async () => {
    const srv = await boot(testConfig());
    cleanups.push(srv.close);
    const { ws, messages, binary } = wsCollect(srv.wsUrl);
    await wsReady(ws);
    ws.send(
      JSON.stringify({ type: 'start', prompts: [{ text: 'pad', weight: 1 }] }),
    );
    await until(() => messages.some((m) => m.type === 'ready'));
    await until(() => binary.length > 0);
    const types = messages.map((m) => m.type);
    expect(types.indexOf('status')).toBeLessThan(types.indexOf('ready'));
    expect(messages.find((m) => m.type === 'ready')).toMatchObject({
      audio: { format: 'pcm_s16le', sampleRateHz: 48000, channels: 2 },
    });
    expect(messages.map((m) => (m as { state?: string }).state)).toContain(
      'playing',
    );
    for (const b of binary) expect(b.length % 4).toBe(0);
    ws.close();
    await once(ws, 'close');
  });

  it('rejects the (maxStreams+1)th connection with capacity then close', async () => {
    const srv = await boot(testConfig({ maxStreams: 5 }));
    cleanups.push(srv.close);
    const clients = Array.from({ length: 5 }, () => new WebSocket(srv.wsUrl));
    await Promise.all(clients.map((c) => once(c, 'open')));
    await until(() => srv.sessions.size === 5);

    const sixth = wsCollect(srv.wsUrl);
    await until(() => sixth.messages.length > 0 || sixth.closed.length > 0);
    expect(sixth.messages[0]).toMatchObject({
      type: 'error',
      code: 'capacity',
      retryable: true,
    });
    await until(() => sixth.closed.length > 0);
    for (const c of clients) c.close();
  });

  it('disconnect frees the slot — a new client can connect', async () => {
    const srv = await boot(testConfig({ maxStreams: 2 }));
    cleanups.push(srv.close);
    const a = new WebSocket(srv.wsUrl);
    const b = new WebSocket(srv.wsUrl);
    await Promise.all([once(a, 'open'), once(b, 'open')]);
    await until(() => srv.sessions.size === 2);
    a.close();
    await until(() => srv.sessions.size === 1);
    const c = wsCollect(srv.wsUrl);
    await wsReady(c.ws);
    await until(() => srv.sessions.size === 2);
    // connected client is functional: start → ready
    c.ws.send(
      JSON.stringify({ type: 'start', prompts: [{ text: 'x', weight: 1 }] }),
    );
    await until(() => c.messages.some((m) => m.type === 'ready'));
    b.close();
    c.ws.close();
  });

  it('stop releases the slot while the socket stays open', async () => {
    const srv = await boot(testConfig({ maxStreams: 1 }));
    cleanups.push(srv.close);
    const client = wsCollect(srv.wsUrl);
    await wsReady(client.ws);
    client.ws.send(
      JSON.stringify({ type: 'start', prompts: [{ text: 'x', weight: 1 }] }),
    );
    await until(() => client.messages.some((m) => m.type === 'ready'));
    client.ws.send(JSON.stringify({ type: 'stop' }));
    await until(() => client.messages.some((m) => (m as { state?: string }).state === 'stopped'));
    await until(() => srv.sessions.size === 0);
    const next = wsCollect(srv.wsUrl);
    await wsReady(next.ws); // must not be capacity-rejected
    await sleep(50);
    expect(next.messages.find((m) => (m as { code?: string }).code === 'capacity')).toBeUndefined();
    next.ws.close();
    client.ws.close();
  });

  it('ws upgrade on the wrong path destroys the socket', async () => {
    const srv = await boot(testConfig());
    cleanups.push(srv.close);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/nope`);
    const [err] = await once(ws, 'error');
    expect(err).toBeDefined();
  });

  it('binary frames from client are ignored (no error emitted)', async () => {
    const srv = await boot(testConfig());
    cleanups.push(srv.close);
    const c = wsCollect(srv.wsUrl);
    await wsReady(c.ws);
    c.ws.send(Buffer.from([1, 2, 3, 4]));
    await sleep(60);
    expect(c.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    c.ws.close();
  });

  it('steer over the wire applies after the 200 ms coalesce window', async () => {
    const srv = await boot(testConfig());
    cleanups.push(srv.close);
    const c = wsCollect(srv.wsUrl);
    await wsReady(c.ws);
    c.ws.send(
      JSON.stringify({ type: 'start', prompts: [{ text: 'a', weight: 1 }] }),
    );
    await until(() => c.messages.some((m) => (m as { state?: string }).state === 'playing'));
    c.ws.send(
      JSON.stringify({
        type: 'steer',
        revision: 1,
        prompts: [{ text: 'b', weight: 1.5 }],
      }),
    );
    await sleep(300); // mock upstream keeps streaming; no errors expected
    expect(c.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    expect(c.binary.length).toBeGreaterThan(0);
    c.ws.close();
  });
});

describe('static file serving', () => {
  it('serves dist/, falls back to index.html, blocks traversal', async () => {
    const dist = mkdtempSync(path.join(os.tmpdir(), 'sway-dist-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<html>sway</html>');
    writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    const srv = await boot(testConfig({ distDir: dist }));
    cleanups.push(srv.close);

    const root = await httpGet(`${srv.httpUrl}/`);
    expect(root.status).toBe(200);
    expect(root.body).toContain('sway');
    expect(root.type).toContain('text/html');

    const js = await httpGet(`${srv.httpUrl}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.type).toContain('javascript');

    const spa = await httpGet(`${srv.httpUrl}/some/deep/route`);
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('sway');

    const api = await httpGet(`${srv.httpUrl}/api/nope`);
    expect(api.status).toBe(404);

    const trav = await httpGet(`${srv.httpUrl}/%2e%2e%2fpackage.json`);
    expect([403, 404]).toContain(trav.status);
  });

  it('no dist in dev mode → 404 json note', async () => {
    const srv = await boot(testConfig());
    cleanups.push(srv.close);
    const res = await httpGet(`${srv.httpUrl}/`);
    expect(res.status).toBe(404);
    expect(res.type).toContain('json');
  });
});
