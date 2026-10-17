// Run 2 (PREREGISTRATION.md): two-stage gate, deadline, sealed run-2 test set, per-set locks. No network.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bundle } from './advisor.ts';
import { acquireLock, primaryCriterion, testSetConfig } from './final.ts';
import { RUN2_STAGE_A_MARGIN, RUN2_STAGE_B_MARGIN, runLoopRun2, type LoopDepsRun2 } from './loop.ts';
import { DEFAULT_PARAMS } from './params.ts';
import { splitPersonas, splitPersonasRun2 } from './personas.ts';

const gen0: Bundle = { advisorPrompt: 'Propose musical directions.', playbook: '- (no lessons yet)', params: { ...DEFAULT_PARAMS } };
const N = 80; // 40 listeners x 2 sessions
const base = Array.from({ length: N }, (_, i) => 0.3 + (i % 5) * 0.02);
// Fake scorer: tags in the playbook set the gain on each validation set (e.g. "A+0.06 B+0.05").
const gain = (b: Bundle, set: 'A' | 'B') => Number(new RegExp(`${set}([+-][0-9.]+)`).exec(b.playbook)?.[1] ?? 0);
const mk = (cur: Bundle, name: string, tags: string) => ({ name, rationale: name, warnings: [], bundle: { ...cur, playbook: `${cur.playbook}\n- ${name} ${tags}` } });

function setup(variantsPerRound: string[][], opts: { now?: () => number } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'si-run2-'));
  const calls = { A: [] as string[], B: [] as string[], train: 0 };
  let round = 0;
  const deps: LoopDepsRun2 = {
    runTrain: async () => { calls.train++; return { scores: base.slice(0, 12), transcripts: 't' }; },
    // Gains are relative to gen0; the latest tag in the playbook wins so adopted variants carry their gain forward.
    runValA: async (b) => { calls.A.push(b.playbook); return base.map((x) => x + lastGain(b, 'A')); },
    runValB: async (b) => { calls.B.push(b.playbook); return base.map((x) => x + lastGain(b, 'B')); },
    review: async () => 'diagnosis',
    rewrite: async (cur) => {
      const specs = variantsPerRound[round++] ?? [];
      return { variants: specs.map((s, i) => mk(cur, `r${round}v${i + 1}`, s)), rejected: [] };
    },
    now: opts.now,
  };
  return { outDir, deps, calls };
}
const lastGain = (b: Bundle, set: 'A' | 'B') => {
  const lines = b.playbook.split('\n').filter((l) => new RegExp(`${set}[+-]`).test(l));
  return lines.length ? gain({ ...b, playbook: lines.at(-1)! }, set) : 0;
};
const readLog = (dir: string) => readFileSync(join(dir, 'changelog.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('run 2 personas', () => {
  it('splitPersonasRun2 is deterministic, sized 12/40/40/40, internally disjoint and disjoint from run 1', () => {
    const s = splitPersonasRun2();
    expect(splitPersonasRun2()).toEqual(s);
    expect([s.train.length, s.valA.length, s.valB.length, s.test.length]).toEqual([12, 40, 40, 40]);
    const ids2 = [...s.train, ...s.valA, ...s.valB, ...s.test].map((p) => p.id);
    expect(new Set(ids2).size).toBe(ids2.length);
    const r1 = splitPersonas();
    const ids1 = new Set([...r1.train, ...r1.val, ...r1.test].map((p) => p.id));
    expect(ids2.some((id) => ids1.has(id))).toBe(false);
    // Disjoint in content too, not only in id.
    const w1 = new Set([...r1.train, ...r1.val, ...r1.test].map((p) => JSON.stringify(p.weights)));
    expect([...s.train, ...s.valA, ...s.valB, ...s.test].some((p) => w1.has(JSON.stringify(p.weights)))).toBe(false);
  });
});

describe('run 2 two-stage gate', () => {
  it('uses the pre-registered margins', () => {
    expect([RUN2_STAGE_A_MARGIN, RUN2_STAGE_B_MARGIN]).toEqual([0.03, 0.02]);
  });

  it('adopts only when both stages pass, and replicates only the best stage-A passer', async () => {
    const { outDir, deps, calls } = setup([['A+0.04 B+0.03', 'A+0.06 B+0.05', 'A+0.01 B+0.10']]);
    const res = await runLoopRun2({ gen0, deps, rounds: 1, outDir });
    expect(res.finalGen).toBe(1);
    expect(res.finalBundle.playbook).toContain('r1v2');
    // valB: incumbent + one replication only (the best stage-A passer), never the others.
    expect(calls.B).toHaveLength(2);
    expect(calls.B[1]).toContain('r1v2');
    const log = readLog(outDir);
    const stageA = log.filter((l) => l.type === 'stage' && l.stage === 'A');
    expect(stageA.map((l) => [l.name, l.pass])).toEqual([['r1v1', true], ['r1v2', true], ['r1v3', false]]);
    const stageB = log.filter((l) => l.type === 'stage' && l.stage === 'B');
    expect(stageB).toHaveLength(1);
    expect(stageB[0]).toMatchObject({ name: 'r1v2', pass: true, set: 'valB' });
    expect(stageB[0].meanDiff).toBeCloseTo(0.05);
    const attempts = log.filter((l) => l.type === 'attempt');
    expect(attempts.map((a) => [a.name, a.decision])).toEqual([['r1v1', 'passed-stageA-not-best'], ['r1v2', 'adopted'], ['r1v3', 'reverted-failed-stageA']]);
    expect(readdirSync(outDir).sort()).toEqual(['changelog.jsonl', 'gen0', 'gen1', 'round1', 'summary.json']);
    expect(JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'))).toMatchObject({ design: 'run2', finalGen: 1, cutoff: null, roundsCompleted: 1 });
  });

  it('reverts a variant that passes stage A but fails replication on valB', async () => {
    const { outDir, deps } = setup([['A+0.08 B+0.01'], ['A+0.05 B-0.02']]);
    const res = await runLoopRun2({ gen0, deps, rounds: 2, outDir });
    expect(res.finalGen).toBe(0);
    expect(res.finalBundle).toEqual(gen0);
    const log = readLog(outDir);
    expect(log.filter((l) => l.type === 'stage').map((l) => [l.round, l.stage, l.pass])).toEqual([[1, 'A', true], [1, 'B', false], [2, 'A', true], [2, 'B', false]]);
    expect(log.filter((l) => l.type === 'attempt').map((a) => a.decision)).toEqual(['reverted-failed-stageB', 'reverted-failed-stageB']);
    expect(log.find((l) => l.type === 'stage' && l.stage === 'B').reason).toMatch(/margin 0.02/);
    // The Rewriter sees it as rejected, with the replication failure spelled out.
    expect(res.history[0]).toMatchObject({ accept: false, adopted: false });
    expect(res.history[0]!.reason).toMatch(/FAILED replication/);
    expect(readdirSync(outDir).filter((d) => d.startsWith('gen'))).toEqual(['gen0']);
  });

  it('rejects at stage A when the CI includes zero even if the mean clears the margin', async () => {
    const { outDir, deps, calls } = setup([['A+0.05 B+0.05']]);
    deps.runValA = async (b) => (b.playbook.includes('r1v') ? base.map((x, i) => x + (i % 2 ? 0.5 : -0.4)) : base);
    const res = await runLoopRun2({ gen0, deps, rounds: 1, outDir });
    expect(res.finalGen).toBe(0);
    expect(calls.B).toHaveLength(0);
    expect(readLog(outDir).find((l) => l.type === 'stage').reason).toBe('CI includes zero');
  });

  it('chains generations: round 2 is gated against the adopted gen1', async () => {
    const { outDir, deps } = setup([['A+0.05 B+0.05'], ['A+0.07 B+0.06']]);
    const res = await runLoopRun2({ gen0, deps, rounds: 2, outDir });
    // Round 2 gain vs gen1 is only +0.02 on A: below the 0.03 margin.
    expect(res.finalGen).toBe(1);
    const a2 = readLog(outDir).find((l) => l.type === 'stage' && l.round === 2);
    expect(a2.meanDiff).toBeCloseTo(0.02);
    expect(a2.incumbentGen).toBe(1);
  });
});

describe('run 2 deadline', () => {
  it('stops cleanly before starting a new round, keeps the latest adopted generation, writes summary.json', async () => {
    let t = 0;
    const { outDir, deps, calls } = setup([['A+0.05 B+0.05'], ['A+0.20 B+0.20'], ['A+0.30 B+0.30']], { now: () => t });
    const train = deps.runTrain;
    deps.runTrain = async (b) => { const r = await train(b); t += 6 * 60_000; return r; }; // each round costs 6 simulated minutes
    const res = await runLoopRun2({ gen0, deps, rounds: 3, outDir, deadlineMinutes: 10 });
    expect(res.finalGen).toBe(1);
    expect(res.roundsCompleted).toBe(1);
    expect(res.cutoff).toMatchObject({ round: 2 });
    expect(calls.train).toBe(2);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ design: 'run2', finalGen: 1, roundsCompleted: 1 });
    expect(summary.cutoff.round).toBe(2);
    expect(readLog(outDir).filter((l) => l.type === 'cutoff')).toHaveLength(1);
  });

  it('does not adopt a stage-A winner when the deadline passes before replication', async () => {
    let t = 0;
    const { outDir, deps, calls } = setup([['A+0.05 B+0.05']], { now: () => t });
    const a = deps.runValA;
    deps.runValA = async (b) => { const r = await a(b); if (b.playbook.includes('r1v1')) t = 60 * 60_000; return r; };
    const res = await runLoopRun2({ gen0, deps, rounds: 1, outDir, deadlineMinutes: 30 });
    expect(res.finalGen).toBe(0);
    expect(calls.B).toHaveLength(0);
    expect(res.cutoff).toMatchObject({ round: 1, before: 'stage B' });
    expect(readLog(outDir).find((l) => l.type === 'attempt').decision).toBe('not-adopted-cutoff-before-stageB');
    expect(existsSync(join(outDir, 'summary.json'))).toBe(true);
  });

  it('a deadline of 0 starts nothing and final = gen0', async () => {
    const { outDir, deps, calls } = setup([['A+0.05 B+0.05']]);
    const res = await runLoopRun2({ gen0, deps, rounds: 3, outDir, deadlineMinutes: 0 });
    expect([res.finalGen, calls.train, calls.A.length]).toEqual([0, 0, 0]);
    expect(JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')).finalGen).toBe(0);
  });

  it('writes summary.json even when a stage throws', async () => {
    const { outDir, deps } = setup([['A+0.05 B+0.05']]);
    deps.runValB = async () => { throw new Error('HTTP 500'); };
    await expect(runLoopRun2({ gen0, deps, rounds: 1, outDir })).rejects.toThrow('HTTP 500');
    expect(JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'))).toMatchObject({ finalGen: 0, error: 'Error: HTTP 500' });
  });
});

describe('run 2 sealed test set', () => {
  it('the loop never touches the run-2 test personas (fakes see only train/valA/valB; source never references the test split)', async () => {
    const src = readFileSync(new URL('./loop.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.test\b|\btest\s*[:=]|\['test'\]|\btest\b\s*}/);
    expect(src).toMatch(/const \{ train, valA, valB \} = splitPersonasRun2\(\)/);
    expect(testSetConfig('run2').personas().map((p) => p.id)).toEqual(splitPersonasRun2().test.map((p) => p.id));
    expect(testSetConfig('run1').personas().map((p) => p.id)).toEqual(splitPersonas().test.map((p) => p.id));
  });

  it('per-set locks are independent: run2 lives in results/run2 and does not see the run-1 lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'si-locks-'));
    const info = { runDir: 'r', gen0Hash: 'a', finalHash: 'b' };
    acquireLock(root, info, false); // run-1 style lock at the root
    const run2Dir = join(root, 'run2');
    expect(acquireLock(run2Dir, info, false).lock.forced).toBe(false);
    expect(() => acquireLock(run2Dir, info, false)).toThrow(/already scored/);
    expect(() => acquireLock(root, info, false)).toThrow(/already scored/);
    expect(testSetConfig('run2').resultsDir).not.toBe(testSetConfig('run1').resultsDir);
    expect(testSetConfig('run2').resultsDir).toMatch(/results\/run2$/);
  });

  it('prints the primary criterion as PASS only when the CI lower bound is above zero', () => {
    expect(primaryCriterion({ meanDiff: 0.03, lo: 0.001, hi: 0.06 }).line).toMatch(/-> PASS/);
    expect(primaryCriterion({ meanDiff: 0.03, lo: 0, hi: 0.06 }).line).toMatch(/-> FAIL/);
    expect(primaryCriterion({ meanDiff: -0.01, lo: -0.03, hi: 0.01 }).pass).toBe(false);
  });
});
