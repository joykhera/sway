import { describe, expect, it } from 'vitest';
import { CrusoeClient, extractJson, loadCrusoeConfig } from './crusoe.ts';
import { decide } from './gatekeeper.ts';
import { generatePersonas, splitPersonas } from './personas.ts';
import { baselinePolicy, evaluate, runEpisode } from './simulator.ts';

describe('personas and split', () => {
  it('is deterministic and the three sets are disjoint', () => {
    expect(generatePersonas(5, 1)).toEqual(generatePersonas(5, 1));
    const s = splitPersonas();
    const ids = [...s.train, ...s.val, ...s.test].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([s.train.length, s.val.length, s.test.length]).toEqual([24, 12, 24]);
  });
});

describe('simulator', () => {
  it('is reproducible and scores within 0..1', async () => {
    const p = generatePersonas(1, 3)[0]!;
    const a = await runEpisode(baselinePolicy, p, 11);
    expect(await runEpisode(baselinePolicy, p, 11)).toEqual(a);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(a.votes).toHaveLength(30);
  });
  it('evaluate returns one paired score per persona and rep', async () => {
    expect(await evaluate(baselinePolicy, generatePersonas(4, 9), 2)).toHaveLength(8);
  });
});

describe('gatekeeper', () => {
  const base = Array.from({ length: 40 }, (_, i) => 0.5 + (i % 5) * 0.01);
  it('rejects no change', () => expect(decide(base, base).accept).toBe(false));
  it('accepts a clear, consistent gain', () => expect(decide(base.map((x) => x + 0.1), base).accept).toBe(true));
  it('rejects a gain below the margin', () => expect(decide(base.map((x) => x + 0.005), base).accept).toBe(false));
  it('rejects a noisy gain whose CI includes zero', () => {
    const noisy = base.map((x, i) => x + (i % 2 ? 0.4 : -0.3));
    expect(decide(noisy, base).accept).toBe(false);
  });
  it('requires paired scores', () => expect(() => decide([1], [1, 2])).toThrow());
});

describe('crusoe client', () => {
  const cfg = { apiKey: 'secret-key', baseUrl: 'https://x/v1', fastModel: 'f', strongModel: 's' };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('retries 429 then succeeds, and never leaks the key in errors', async () => {
    let calls = 0;
    const client = new CrusoeClient(cfg, {
      sleep: async () => {},
      fetch: async (_u, init) => {
        expect((init!.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
        return ++calls < 3 ? new Response('slow down', { status: 429 }) : ok({ choices: [{ message: { content: 'hi' } }] });
      },
    });
    expect((await client.chat({ model: 'f', messages: [] })).text).toBe('hi');
    expect(calls).toBe(3);

    const failing = new CrusoeClient(cfg, { sleep: async () => {}, maxRetries: 1, fetch: async () => new Response('nope', { status: 401 }) });
    await expect(failing.listModels()).rejects.toThrow(/HTTP 401/);
    await failing.listModels().catch((e) => expect(String(e)).not.toContain('secret-key'));
  });

  it('requires a key and has sane defaults', () => {
    expect(() => loadCrusoeConfig({})).toThrow(/CRUSOE_API_KEY/);
    expect(loadCrusoeConfig({ CRUSOE_API_KEY: 'k' }).baseUrl).toBe('https://api.inference.crusoecloud.com/v1');
  });

  it('extracts JSON from fenced model output', () => {
    expect(extractJson('sure!\n```json\n{"a":{"b":1}}\n```')).toEqual({ a: { b: 1 } });
    expect(() => extractJson('no json')).toThrow();
  });
});
