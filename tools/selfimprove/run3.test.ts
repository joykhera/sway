// Run 3 (PREREGISTRATION_RUN3.md): split, advisor model override, wider bounded params, two-stage gate on the run-3
// split, and the 99% sealed-test criterion. No network: every LLM call goes to a fake client.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdvisorMessages, chooseTarget, createAdvisorPolicy, type Bundle } from './advisor.ts';
import { acquireLock, run3Criterion, testSetConfig } from './final.ts';
import { LlmGateway, type ChatClient } from './llm.ts';
import { RUN3_ADVISOR_MODEL, RUN3_MAX_ROUNDS, RUN3_MAX_VARIANTS, loopSplit, runLoopRun2, type LoopDepsRun2 } from './loop.ts';
import { DEFAULT_PARAMS, PARAM_SPEC, describeParams, sanitizeParams } from './params.ts';
import { generatePersonas, splitPersonas, splitPersonasRun2, splitPersonasRun3 } from './personas.ts';
import { buildRewriterMessages } from './rewriter.ts';
import { runEpisode } from './simulator.ts';
import { bootstrapCi } from './stats.ts';
import { resolveAdvisorModel } from './team.ts';

const G = { genre: ['ambient', 'lofi', 'jazz', 'electronic', 'classical'], instrument: ['piano', 'synth', 'guitar', 'strings', 'percussion'], mood: ['calm', 'dreamy', 'hopeful', 'melancholic', 'energetic'], texture: ['sparse', 'layered', 'rhythmic'] };
// Deterministic fake advisor: candidates derived from a hash of the prompt.
const fakeClient: ChatClient = {
  async chat(a) {
    const h = createHash('sha256').update(JSON.stringify(a.messages)).digest();
    const c = [0, 1, 2].map((i) => ({ features: [G.genre[h[4 * i]! % 5], G.instrument[h[4 * i + 1]! % 5], G.mood[h[4 * i + 2]! % 5], G.texture[h[4 * i + 3]! % 3]] }));
    return { text: JSON.stringify({ candidates: c }), latencyMs: 0 };
  },
};

async function traces(extra: Partial<typeof DEFAULT_PARAMS>) {
  const personas = generatePersonas(6, 4242);
  const out: string[] = [];
  for (const [pi, p] of personas.entries()) {
    for (const seed of [11, 12]) {
      const pol = createAdvisorPolicy({ gateway: new LlmGateway(fakeClient, null), model: 'fake', bundle: { advisorPrompt: 'x', playbook: 'y', params: { ...DEFAULT_PARAMS, ...extra } } });
      const ep = await runEpisode(pol, p, seed + pi);
      out.push(ep.votes.map((v) => (v === 'up' ? 'u' : 'd')).join('') + ':' + (ep.trace as { src: string }[]).map((s) => (s.src === 'llm' ? 'M' : 'L')).join('') + ':' + ep.score);
    }
  }
  return out;
}

// Captured with the pre-run-3 advisor.ts (before the new params existed), same fake client and seeds.
const BEFORE: Record<string, string[]> = {
  "default": [
    "duuddduddduuddddududuuduuddddu:LLLMMMMMLMLLLMMMMMMMMMMLLLLMML:0.4",
    "dddddddduddudddddddddddddddudd:LLLMMMMMMMMMMLMMMMMMMMMLLMMMML:0.12",
    "uddddddddddudddddddddddddddudd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.08",
    "dddddddududduddddddddudduddddu:LLLMMMMMMMMMMMLMMMMMMMMMMMLMMM:0.24",
    "dddddddudddudddddddddudduddudu:LLLMMMMMMMMMMMMMMLMMLMMLMMMMMM:0.24",
    "dduduuddddddddddddduuduuudddud:LLLMMMLMMMMMMMMMMMMMMLMMMMLMLL:0.28",
    "dduduudddddddddddddudddduddddd:LLLMMMLMMMMMMMMMMMMMMMMLMMMMMM:0.12",
    "ddddddddddddddudududdduddddddd:LLLMMMMMMMMMMMLLLLMMMMMMMMMMLL:0.16",
    "ddudddduudddddudududdduudddddd:LLLMMMMMMMMMMMMLLLMMMMMMLMMMMM:0.28",
    "ddddduuddudduduuuuuduuduuuuuuu:LLLMMMMMMMMLMMMMMMLLLLLLLLLLLL:0.72",
    "dddddddddddddddddddddudddddddd:LLLMMMMLLMMLMMMMMMMMLLLMMMMMMM:0.04",
    "dddddddddddddddddddduddddddddu:LLLMMMMMMMMMMLMMMMMLMMMMMMMMMM:0.08"
  ],
  "bonus": [
    "duuddduddduddddddddddududddddd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.16",
    "dddddddduddudddddddddddddddudd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.12",
    "uddddddddddudddddddddddddddudd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.08",
    "ddddddduddddudududdduudduddddd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.28",
    "ddddddduddddududdddddudddddddu:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.2",
    "dduduuddudddddddddduudddududud:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.28",
    "ddududddddddddddddduuddduddddd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.12",
    "ddddddddddddddudududdduddddddd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.16",
    "ddudddduddddddududdddddududddd:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.2",
    "ddddduuddududddududddudduuuuuu:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.52",
    "dddddddddddddddddddddddddudddu:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.08",
    "dddddddddddddddddddddddddddddu:LLLMMMMMMMMMMMMMMMMMMMMMMMMMMM:0.04"
  ],
  "every2": [
    "duuduuudddudddudududuududddudd:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.4",
    "dddduddduddudddddduddduddddudd:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.2",
    "uddduddddddudddddddddddddddudd:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.08",
    "dddddududddudddduddddudduddudd:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.28",
    "dddddddududdddududdudddduddddu:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.28",
    "dduuudddddddddddddduddddddddud:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.08",
    "dduuudddddddddddddddddddddddud:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.04",
    "ddddddddddddddddudddddddddudud:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.12",
    "ddudddduudddddududddddudddddud:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.24",
    "ddddduuddudddduuuuddudddduuduu:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.48",
    "dddddddddddddddddudddddddddddu:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.08",
    "dddddddddddddddddddddddddddddu:LLLLLLLLLLLLLLLLLLLLLLLLLLLLLL:0.04"
  ]
};
const SETTINGS: Record<string, Partial<typeof DEFAULT_PARAMS>> = {
  default: {},
  bonus: { llmCandidateBonus: 0.3, noveltyBonus: 0.1 },
  every2: { advisorEveryNVotes: 2, candidateCount: 5, llmCandidateBonus: -0.1 },
};

describe('run 3 personas', () => {
  it('splitPersonasRun3 is deterministic, sized 8/30/30/40, internally disjoint and disjoint from runs 1 and 2', () => {
    const s = splitPersonasRun3();
    expect(splitPersonasRun3()).toEqual(s);
    expect([s.train.length, s.valA.length, s.valB.length, s.test.length]).toEqual([8, 30, 30, 40]);
    const all3 = [...s.train, ...s.valA, ...s.valB, ...s.test];
    expect(new Set(all3.map((p) => p.id)).size).toBe(all3.length);
    expect(all3.every((p) => p.id.startsWith('p9001-'))).toBe(true);
    const r1 = splitPersonas();
    const r2 = splitPersonasRun2();
    const prev = [...r1.train, ...r1.val, ...r1.test, ...r2.train, ...r2.valA, ...r2.valB, ...r2.test];
    const ids = new Set(prev.map((p) => p.id));
    const weights = new Set(prev.map((p) => JSON.stringify(p.weights)));
    expect(all3.some((p) => ids.has(p.id) || weights.has(JSON.stringify(p.weights)))).toBe(false);
    // Run-1 and run-2 splits are unchanged by the addition.
    expect(splitPersonasRun2().test.map((p) => p.id)).toEqual(r2.test.map((p) => p.id));
  });
});

describe('run 3 wider params', () => {
  it('defaults reproduce the pre-run-3 chooser exactly (byte-identical votes, sources and scores)', async () => {
    for (const [name, extra] of Object.entries(SETTINGS)) expect(await traces(extra)).toEqual(BEFORE[name]);
  });

  it('new knobs have documented bounds, neutral defaults, and are clamped', () => {
    expect(PARAM_SPEC.learnerScoreWeight).toMatchObject({ min: 0, max: 3, default: 1 });
    expect(PARAM_SPEC.repeatPenalty).toMatchObject({ min: 0, max: 0.5, default: 0 });
    expect(PARAM_SPEC.deferToLearnerProbability).toMatchObject({ min: 0, max: 1, default: 0 });
    expect(PARAM_SPEC.poolMaxAge).toMatchObject({ min: 1, max: 30, default: 30, int: true });
    const { params, warnings } = sanitizeParams({ learnerScoreWeight: 9, repeatPenalty: -1, deferToLearnerProbability: 2, poolMaxAge: 0.2 });
    expect([params.learnerScoreWeight, params.repeatPenalty, params.deferToLearnerProbability, params.poolMaxAge]).toEqual([3, 0, 1, 1]);
    expect(warnings).toHaveLength(4);
    // An old params.json (no run-3 keys) loads with the neutral defaults.
    expect(sanitizeParams({ advisorStartVote: 3 }).params).toEqual(DEFAULT_PARAMS);
  });

  it('non-default knobs change behaviour: defer=1 always plays the learner; a big repeat penalty moves away from replays', async () => {
    const all = await traces({ deferToLearnerProbability: 1 });
    expect(all.every((t) => !t.split(':')[1]!.includes('M'))).toBe(true);
    const repeat = await traces({ repeatPenalty: 0.5, llmCandidateBonus: 0 });
    expect(repeat).not.toEqual(await traces({ llmCandidateBonus: 0 }));
  });

  it('chooseTarget with defer returns the learner proposal', () => {
    const state = { scores: {} } as never;
    const proposed = { features: {} } as never;
    expect(chooseTarget({ state, proposed, pool: [], current: proposed, lastVote: 'up', params: DEFAULT_PARAMS, defer: true }).src).toBe('learner');
  });

  it('the rewriter is told about the new knobs and their bounds; neither prompt carries hidden taste', () => {
    const b: Bundle = { advisorPrompt: 'Propose musical directions.', playbook: '- none', params: { ...DEFAULT_PARAMS } };
    const msgs = buildRewriterMessages({ current: b, diagnosis: 'd', history: [], n: 3 });
    const text = msgs.map((m) => m.content).join('\n');
    for (const k of ['learnerScoreWeight', 'repeatPenalty', 'deferToLearnerProbability', 'poolMaxAge', 'candidateCount', 'noveltyBonus']) expect(text).toContain(k);
    expect(describeParams()).toContain('learnerScoreWeight (number in [0, 3], default 1)');
    expect(describeParams()).toContain('poolMaxAge (integer in [1, 30], default 30)');
    const persona = splitPersonasRun3().valA[0]!;
    const adv = buildAdvisorMessages(b, [{ ids: ['jazz', 'piano', 'calm', 'sparse'], vote: 'up' }]).map((m) => m.content).join('\n');
    for (const t of [text, adv]) {
      expect(t).not.toContain(persona.id);
      expect(t).not.toMatch(/pickiness|fatigue|weights/i);
    }
  });
});

describe('run 3 advisor model', () => {
  it('defaults to the fast model, can be set by env or explicitly (explicit wins)', () => {
    const cfg = { fastModel: 'nano' };
    expect(resolveAdvisorModel(cfg, undefined, {})).toBe('nano');
    expect(resolveAdvisorModel(cfg, undefined, { CRUSOE_MODEL_ADVISOR: 'light' })).toBe('light');
    expect(resolveAdvisorModel(cfg, 'x', { CRUSOE_MODEL_ADVISOR: 'light' })).toBe('x');
    expect(RUN3_ADVISOR_MODEL).toBe('nvidia/Nemotron-3.5-Lightning-30B-A3B');
  });
});

describe('run 3 loop', () => {
  it('fixed design constants and split: at most 2 rounds x 3 variants; loop split never includes the sealed run-3 set', () => {
    expect([RUN3_MAX_ROUNDS, RUN3_MAX_VARIANTS]).toEqual([2, 3]);
    const s = splitPersonasRun3();
    const l = loopSplit('run3');
    expect(Object.keys(l).sort()).toEqual(['train', 'valA', 'valB']);
    expect([l.train, l.valA, l.valB].map((x) => x.map((p) => p.id))).toEqual([s.train, s.valA, s.valB].map((x) => x.map((p) => p.id)));
    const sealed = new Set(s.test.map((p) => p.id));
    expect([...l.train, ...l.valA, ...l.valB].some((p) => sealed.has(p.id))).toBe(false);
    const src = readFileSync(new URL('./loop.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const \{ train, valA, valB \} = splitPersonasRun3\(\)/);
  });

  it('runs the two-stage gate under design run3, records the advisor model, writes summary.json', async () => {
    const gen0: Bundle = { advisorPrompt: 'Propose musical directions.', playbook: '- (no lessons yet)', params: { ...DEFAULT_PARAMS } };
    const base = Array.from({ length: 60 }, (_, i) => 0.3 + (i % 5) * 0.02);
    const tag = (b: Bundle) => (b.playbook.includes('win') ? 0.05 : 0);
    const deps: LoopDepsRun2 = {
      runTrain: async () => ({ scores: base.slice(0, 8), transcripts: 't' }),
      runValA: async (b) => base.map((x) => x + tag(b)),
      runValB: async (b) => base.map((x) => x + tag(b)),
      review: async () => 'diagnosis',
      rewrite: async (cur) => ({ variants: [{ name: 'win', rationale: 'r', warnings: [], bundle: { ...cur, playbook: cur.playbook + '\n- win', params: { ...cur.params, repeatPenalty: 0.1 } } }], rejected: [] }),
    };
    const outDir = mkdtempSync(join(tmpdir(), 'si-run3-'));
    const res = await runLoopRun2({ gen0, deps, rounds: 1, outDir, design: 'run3', deadlineMinutes: 25, meta: { advisorModel: RUN3_ADVISOR_MODEL } });
    expect(res.finalGen).toBe(1);
    const log = readFileSync(join(outDir, 'changelog.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ type: 'start', design: 'run3', advisorModel: RUN3_ADVISOR_MODEL });
    expect(log.every((l) => l.design === 'run3')).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'))).toMatchObject({ design: 'run3', finalGen: 1 });
  });
});

describe('run 3 sealed test', () => {
  it('has its own set and lock directory, independent of runs 1 and 2', () => {
    expect(testSetConfig('run3').personas().map((p) => p.id)).toEqual(splitPersonasRun3().test.map((p) => p.id));
    expect(testSetConfig('run3').resultsDir).toMatch(/results\/run3$/);
    const root = mkdtempSync(join(tmpdir(), 'si-locks3-'));
    const info = { runDir: 'r', gen0Hash: 'a', finalHash: 'b' };
    acquireLock(join(root, 'run2'), info, false);
    expect(acquireLock(join(root, 'run3'), info, false).lock.forced).toBe(false);
    expect(() => acquireLock(join(root, 'run3'), info, false)).toThrow(/already scored/);
  });

  it('99% CI option: wider than the 95% default, which is unchanged', () => {
    const xs = Array.from({ length: 120 }, (_, i) => ((i * 37) % 11) / 100 - 0.03);
    const c95 = bootstrapCi(xs);
    expect(bootstrapCi(xs, 1, 2000, 0.05)).toEqual(c95);
    const c99 = bootstrapCi(xs, 1, 2000, 0.01);
    expect(c99.lo).toBeLessThan(c95.lo);
    expect(c99.hi).toBeGreaterThan(c95.hi);
  });

  it('verdicts: CLAIMED (99% lo > 0), SUGGESTIVE (only 95%), NEGATIVE, and fails by construction when final = gen0', () => {
    const strong = Array.from({ length: 120 }, (_, i) => 0.08 + ((i % 7) - 3) * 0.02);
    expect(run3Criterion(strong, false).verdict).toBe('CLAIMED');
    expect(run3Criterion(strong, true)).toMatchObject({ verdict: 'NEGATIVE', byConstruction: true });
    expect(run3Criterion(strong, true).line).toMatch(/fails by construction/);
    const zero = Array.from({ length: 120 }, (_, i) => ((i % 7) - 3) * 0.05);
    expect(run3Criterion(zero, false).verdict).toBe('NEGATIVE');
    // Search a shift where the 95% lower bound is above 0 but the 99% is not.
    const noisy = Array.from({ length: 120 }, (_, i) => (((i * 53) % 17) - 8) * 0.05);
    const verdicts = Array.from({ length: 60 }, (_, k) => run3Criterion(noisy.map((x) => x + k * 0.002), false));
    const sug = verdicts.find((v) => v.verdict === 'SUGGESTIVE');
    expect(sug).toBeDefined();
    expect(sug!.ci95.lo).toBeGreaterThan(0);
    expect(sug!.ci99.lo).toBeLessThanOrEqual(0);
  });
});
