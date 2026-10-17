// No network: every LLM call goes to a fake client.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signature } from '../../src/learner/targets.ts';
import { buildAdvisorMessages, createAdvisorPolicy, validateCandidates, type Bundle, type Step } from './advisor.ts';
import type { ChatMessage, ChatResult } from './crusoe.ts';
import { acquireLock } from './final.ts';
import { LlmGateway, type ChatClient } from './llm.ts';
import { runLoop, type LoopDeps } from './loop.ts';
import { DEFAULT_PARAMS, sanitizeParams } from './params.ts';
import { generatePersonas, splitPersonas } from './personas.ts';
import { formatTranscripts, toTranscriptEpisodes } from './reviewer.ts';
import { buildRewriterMessages, validateVariants } from './rewriter.ts';
import { baselinePolicy, evaluate, evaluateEpisodes, runEpisode } from './simulator.ts';

class FakeClient implements ChatClient {
  calls: ChatMessage[][] = [];
  constructor(private readonly reply: (messages: ChatMessage[]) => string | Promise<string>) {}
  async chat(args: { messages: ChatMessage[] }): Promise<ChatResult> {
    this.calls.push(args.messages);
    return { text: await this.reply(args.messages), promptTokens: 10, completionTokens: 5, latencyMs: 1 };
  }
}

const bundle = (over: Partial<Bundle['params']> = {}): Bundle => ({
  advisorPrompt: 'Propose musical directions.',
  playbook: '- (no lessons yet)',
  params: { ...DEFAULT_PARAMS, ...over },
});
const advisor = (client: ChatClient, b = bundle(), timeoutMs?: number) =>
  createAdvisorPolicy({ gateway: new LlmGateway(client, null), model: 'fake', bundle: b, timeoutMs });

const persona = generatePersonas(1, 77)[0]!;

describe('simulator (async)', () => {
  it('keeps paired ordering regardless of concurrency', async () => {
    const ps = generatePersonas(5, 4);
    expect(await evaluate(baselinePolicy, ps, 2, undefined, { concurrency: 8 })).toEqual(await evaluate(baselinePolicy, ps, 2, undefined, { concurrency: 1 }));
  });
});

describe('advisor policy fallback', () => {
  const baselineVotes = async () => (await runEpisode(baselinePolicy, persona, 5)).votes;
  it('falls back to the learner on garbage output (identical episode to the learner)', async () => {
    const ep = await runEpisode(advisor(new FakeClient(() => 'I like jazz! no json here')), persona, 5);
    expect(ep.votes).toEqual(await baselineVotes());
    expect((ep.trace as Step[]).some((s) => s.call === 'fail')).toBe(true);
  });
  it('falls back on thrown errors and on timeouts', async () => {
    const throwing: ChatClient = { chat: async () => { throw new Error('HTTP 500'); } };
    expect((await runEpisode(advisor(throwing), persona, 5)).votes).toEqual(await baselineVotes());
    const hanging: ChatClient = { chat: () => new Promise(() => {}) };
    const ep = await runEpisode(advisor(hanging, bundle({ advisorEveryNVotes: 10 }), 5), persona, 5);
    expect(ep.votes).toEqual(await baselineVotes());
  });
  it('falls back on JSON with only unknown ids', async () => {
    const ep = await runEpisode(advisor(new FakeClient(() => '{"candidates":[{"features":["dubstep","kazoo"]}]}')), persona, 5);
    expect(ep.votes).toEqual(await baselineVotes());
  });
  it('uses advisor candidates when the deterministic chooser prefers them', async () => {
    const client = new FakeClient(() => '```json\n{"candidates":[{"features":["jazz","piano","calm","sparse"]},{"features":["ambient","strings","dreamy","layered"]}]}\n```');
    const ep = await runEpisode(advisor(client, bundle({ llmCandidateBonus: 0.5 })), persona, 5);
    expect((ep.trace as Step[]).some((s) => s.src === 'llm')).toBe(true);
    expect(client.calls.length).toBeGreaterThan(3);
  });
});

describe('leakage guard', () => {
  it('advisor prompts and reviewer transcripts never contain hidden persona taste', async () => {
    const client = new FakeClient(() => '{"candidates":[{"features":["lofi","guitar","hopeful","rhythmic"]}]}');
    const ps = generatePersonas(3, 11);
    const results = await evaluateEpisodes(advisor(client), ps, 1);
    const texts = [...client.calls.flat().map((m) => m.content), formatTranscripts(toTranscriptEpisodes(results))];
    expect(texts.length).toBeGreaterThan(5);
    for (const p of ps) {
      const secrets = [
        ...Object.values(p.weights).flatMap((w) => [String(w), w.toFixed(3)]),
        ...p.pairs.flatMap((x) => [String(x.delta), x.delta.toFixed(3)]),
        String(p.pickiness), p.pickiness.toFixed(3), String(p.fatigue), p.fatigue.toFixed(3), String(p.noise), p.noise.toFixed(3), p.id,
      ];
      for (const t of texts) {
        for (const s of secrets) expect(t).not.toContain(s);
        expect(t).not.toMatch(/pickiness|fatigue|weights|affinit/i);
      }
    }
  });
});

describe('candidate validation', () => {
  const fallback = { lofi: 0.4, piano: 0.35, calm: 0.3, sparse: 0.2 };
  it('drops unknown ids, caps per group, fills missing groups from the learner target, dedupes', () => {
    const out = validateCandidates(
      { candidates: [
        { features: ['JAZZ', 'ambient', 'electronic', 'kazoo', 'synth', 'dreamy', 'calm'] },
        { features: ['jazz', 'ambient', 'synth', 'dreamy'] },
        { features: [] },
        'nonsense',
        ['strings'],
      ] },
      fallback,
      5,
    );
    expect(out.map((t) => signature(t.features))).toEqual(['ambient|jazz|synth|dreamy|sparse', 'lofi|strings|calm|sparse']);
    expect(out[0]!.prompts.length).toBe(5);
  });
  it('returns nothing for garbage and respects the max', () => {
    expect(validateCandidates(null, fallback, 3)).toEqual([]);
    expect(validateCandidates({ candidates: 'x' }, fallback, 3)).toEqual([]);
    const many = { candidates: ['ambient', 'lofi', 'jazz', 'electronic'].map((g) => ({ features: [g] })) };
    expect(validateCandidates(many, fallback, 2)).toHaveLength(2);
  });
  it('advisor messages carry history, vocabulary and the fixed output format', () => {
    const msgs = buildAdvisorMessages(bundle({ historyWindow: 3 }), Array.from({ length: 5 }, (_, i) => ({ ids: ['jazz', 'piano', 'calm', 'sparse'] as const as never, vote: i % 2 ? 'up' : 'down' })));
    expect(msgs[1]!.content).toContain('3. genre=jazz');
    expect(msgs[1]!.content).not.toContain('2. genre=jazz');
    expect(msgs[1]!.content).toContain('"candidates"');
  });
});

describe('params', () => {
  it('clamps out-of-range values, rounds integers, drops unknown keys, rejects non-numbers', () => {
    const { params, warnings } = sanitizeParams({ advisorEveryNVotes: 99, historyWindow: 4.6, llmCandidateBonus: -3, temperature: 'hot', evil: 1 });
    expect(params.advisorEveryNVotes).toBe(10);
    expect(params.historyWindow).toBe(5);
    expect(params.llmCandidateBonus).toBe(-0.5);
    expect(params.temperature).toBe(DEFAULT_PARAMS.temperature);
    expect(params).not.toHaveProperty('evil');
    expect(warnings).toHaveLength(4);
    expect(sanitizeParams([1, 2]).params).toEqual(DEFAULT_PARAMS);
  });
  it('the shipped params.json is within bounds', () => {
    const raw = JSON.parse(readFileSync(new URL('./artifacts/params.json', import.meta.url), 'utf8'));
    expect(sanitizeParams(raw).warnings).toEqual([]);
  });
});

describe('rewriter validation', () => {
  const current = bundle();
  const good = { name: 'n1', rationale: 'r', advisor_prompt: 'A much better prompt for the advisor model.', playbook: '- lesson', params: { noveltyBonus: 0.9 } };
  it('accepts well-formed variants and clamps params', () => {
    const { variants, rejected } = validateVariants({ variants: [good] }, current, 3);
    expect(rejected).toEqual([]);
    expect(variants[0]!.bundle.params.noveltyBonus).toBe(0.5);
    expect(variants[0]!.warnings.length).toBe(1);
  });
  it('rejects malformed, duplicate and unchanged variants', () => {
    const { variants, rejected } = validateVariants(
      { variants: [good, good, { ...good, advisor_prompt: 'short' }, { ...good, playbook: 7 }, { ...good, params: 'x' }, 'str',
        { advisor_prompt: current.advisorPrompt + '              ', playbook: current.playbook, params: current.params }] },
      current, 10,
    );
    expect(variants).toHaveLength(1);
    expect(rejected.map((r) => r.reason)).toEqual([
      'duplicate of another variant', 'advisor_prompt missing or too short', 'playbook missing', 'params is not an object', 'variant is not an object', 'identical to the incumbent',
    ]);
    expect(validateVariants('nope', current, 3).variants).toEqual([]);
  });
  it('feeds the attempt history back to the rewriter', () => {
    const msgs = buildRewriterMessages({ current, diagnosis: 'd', n: 3, history: [{ round: 1, name: 'try-novelty', hash: 'h', rationale: 'avoid repeats', params: current.params, meanDiff: -0.01, lo: -0.03, hi: 0.01, accept: false, adopted: false, reason: 'gain below margin 0.02' }] });
    expect(msgs[1]!.content).toContain('try-novelty');
    expect(msgs[1]!.content).toContain('REJECTED');
  });
});

describe('loop', () => {
  it('adopts an improving variant and reverts a non-improving one, logging both', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'si-loop-'));
    const base = Array.from({ length: 24 }, (_, i) => 0.3 + (i % 4) * 0.02);
    const histories: number[] = [];
    let round = 0;
    const deps: LoopDeps = {
      runTrain: async () => ({ scores: base, transcripts: 'train transcript' }),
      // Fake scorer: the playbook text decides the score.
      runVal: async (b) => base.map((x) => x + (b.playbook.includes('GOOD') ? 0.1 : b.playbook.includes('WORSE') ? -0.05 : 0)),
      review: async () => 'diagnosis',
      rewrite: async (cur, _d, history) => {
        histories.push(history.length);
        round++;
        const mk = (name: string, playbook: string) => ({ name, rationale: name, warnings: [], bundle: { ...cur, playbook } });
        return round === 1
          ? { variants: [mk('good', '- GOOD idea'), mk('same', '- different words')], rejected: [{ index: 2, reason: 'bad json' }] }
          : { variants: [mk('worse', '- GOOD idea\n- WORSE')], rejected: [] };
      },
    };
    const res = await runLoop({ gen0: bundle(), deps, rounds: 2, outDir });
    expect(res.finalGen).toBe(1);
    expect(res.finalBundle.playbook).toContain('GOOD');
    expect(histories).toEqual([0, 2]);
    const log = readFileSync(join(outDir, 'changelog.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const attempts = log.filter((l) => l.type === 'attempt');
    expect(attempts.map((a) => [a.name, a.decision])).toEqual([['good', 'adopted'], ['same', 'reverted'], ['worse', 'reverted']]);
    expect(attempts[0].meanDiff).toBeCloseTo(0.1);
    expect(log.filter((l) => l.type === 'malformed')).toHaveLength(1);
    expect(readdirSync(outDir).sort()).toEqual(['changelog.jsonl', 'gen0', 'gen1', 'round1', 'round2']);
  });
  it('the loop CLI never references the sealed test personas', () => {
    const src = readFileSync(new URL('./loop.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.test\b|\btest\s*[:=]|\['test'\]/);
    expect(splitPersonas().test.length).toBe(24);
  });
});

describe('final lock', () => {
  it('refuses a second scoring unless forced, and records the force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'si-final-'));
    const info = { runDir: 'r', gen0Hash: 'a', finalHash: 'b' };
    expect(acquireLock(dir, info, false).lock.forced).toBe(false);
    expect(() => acquireLock(dir, info, false)).toThrow(/already scored/);
    const forced = acquireLock(dir, info, true);
    expect(forced.lock.forced).toBe(true);
    expect(forced.previous?.runDir).toBe('r');
  });
});

describe('response cache', () => {
  it('serves identical requests from disk without calling the model, and counts tokens per role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'si-cache-'));
    const client = new FakeClient(() => 'hello');
    const req = { role: 'advisor' as const, model: 'm', messages: [{ role: 'user' as const, content: 'x' }], temperature: 0.4, maxTokens: 100 };
    const g1 = new LlmGateway(client, dir);
    expect((await g1.chat(req)).cached).toBe(false);
    expect((await g1.chat(req)).cached).toBe(true);
    const g2 = new LlmGateway(client, dir);
    expect((await g2.chat({ ...req, maxTokens: 999 })).text).toBe('hello');
    await g2.chat({ ...req, temperature: 0.5 });
    expect(client.calls).toHaveLength(2);
    expect(g1.stats.advisor).toMatchObject({ calls: 1, cacheHits: 1, promptTokens: 10, completionTokens: 5 });
  });
  it('dedupes identical in-flight requests', async () => {
    const client = new FakeClient(async () => { await new Promise((r) => setTimeout(r, 5)); return 'x'; });
    const g = new LlmGateway(client, null);
    const req = { role: 'reviewer' as const, model: 'm', messages: [], temperature: 0, maxTokens: 1 };
    await Promise.all([g.chat(req), g.chat(req), g.chat(req)]);
    expect(client.calls).toHaveLength(1);
  });
});
