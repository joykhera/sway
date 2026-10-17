import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntentHttpHandler, type HttpOptions } from './http.ts';
import type { IntentInterpreter } from './service.ts';
const input = { text: 'Warm background', purpose: 'focus', currentFeatures: {} };
const reply = { status: 'clarify', message: 'Which qualities?' } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
async function serve(interpret?: IntentInterpreter, options?: HttpOptions) {
  const handler = createIntentHttpHandler(interpret, options);
  const server = http.createServer((req, res) => void handler.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise<void>((resolve) => { handler.close(); server.closeAllConnections(); server.close(() => resolve()); }));
  const post = (headers: Record<string, string> = {}, body = JSON.stringify(input), signal?: AbortSignal) => fetch(url, { method: 'POST', headers: { origin: url, 'content-type': 'application/json', ...headers }, body, signal });
  return { url, post, handler };
}
describe('intent HTTP boundary', () => {
  it('accepts same-origin JSON and blocks cross-origin/missing origin and non-JSON', async () => {
    const interpret = vi.fn<IntentInterpreter>().mockResolvedValue(reply);
    const { post, url } = await serve(interpret);
    const response = await post(); expect(response.status).toBe(200); expect(await response.json()).toEqual(reply);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await post({ origin: 'https://unrelated.test' })).status).toBe(403);
    expect((await post({ origin: '' })).status).toBe(403);
    expect((await post({ origin: `${url}/path` })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(415);
    expect(interpret).toHaveBeenCalledTimes(1);
  });
  it('validates schema, rejects unknown injection fields, and bounds body before interpretation', async () => {
    const interpret = vi.fn<IntentInterpreter>().mockResolvedValue(reply);
    const { post, url } = await serve(interpret);
    expect((await post({}, '{broken')).status).toBe(400);
    expect((await post({}, JSON.stringify({ ...input, apiKey: 'attack', endpoint: 'https://attack.test' }))).status).toBe(400);
    expect((await post({}, JSON.stringify({ ...input, text: 'x'.repeat(17_000) }))).status).toBe(413);
    expect((await fetch(url)).status).toBe(405);
    expect(interpret).not.toHaveBeenCalled();
  });
  it('applies global concurrency and rate bounds without calling provider', async () => {
    let release!: () => void;
    const interpret = vi.fn<IntentInterpreter>().mockImplementation(async () => { await new Promise<void>((resolve) => { release = resolve; }); return reply; });
    const { post } = await serve(interpret, { maxConcurrent: 1, requestsPerMinute: 1 });
    const first = post();
    await vi.waitFor(() => expect(interpret).toHaveBeenCalledTimes(1));
    expect((await post()).status).toBe(429);
    release(); expect((await first).status).toBe(200);
    expect((await post()).status).toBe(429);
    expect(interpret).toHaveBeenCalledTimes(1);
  });
  it('aborts outstanding provider work when the browser disconnects', async () => {
    let observed: AbortSignal | undefined;
    const interpret = vi.fn<IntentInterpreter>().mockImplementation(async (_input, signal) => {
      observed = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return reply;
    });
    const { post } = await serve(interpret);
    const controller = new AbortController();
    const request = post({}, undefined, controller.signal).catch(() => null);
    await vi.waitFor(() => expect(observed).toBeDefined());
    controller.abort(); await request;
    await vi.waitFor(() => expect(observed!.aborted).toBe(true));
  });
  it('aborts and ends pending responses on server shutdown', async () => {
    let observed: AbortSignal | undefined;
    const interpret: IntentInterpreter = async (_input, signal) => {
      observed = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return reply;
    };
    const { post, handler } = await serve(interpret);
    const pending = post();
    await vi.waitFor(() => expect(observed).toBeDefined());
    handler.close();
    expect((await pending).status).toBe(503);
    expect(observed!.aborted).toBe(true);
  });
  it('fails unavailable without an interpreter', async () => {
    const { post } = await serve();
    expect((await post()).status).toBe(503);
  });
});
