// pnpm selfimprove:final -- --run <runs/dir> [--test-set run1|run2]: scores ONCE on the sealed TEST personas.
// run1 (default): results/final.{json,md,lock}. run2: results/run2/final.{json,md,lock} (separate lock).
// (a) deterministic learner, (b) advisor gen0, (c) advisor final generation. A lock file prevents silent re-scoring.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Bundle } from './advisor.ts';
import { splitPersonas, splitPersonasRun2, type Persona } from './personas.ts';
import { oracleScores, randomPolicy } from './refs.ts';
import { baselinePolicy, evaluate, type Policy } from './simulator.ts';
import { bootstrapCi, mean, pairedDiff } from './stats.ts';
import { RESULTS_DIR, RUNS_DIR, bundleHash, createLive, flag, numFlag, pct, pts, readBundle } from './team.ts';

export type LockInfo = { runDir: string; gen0Hash: string; finalHash: string; at: string; forced: boolean };

export function acquireLock(resultsDir: string, info: Omit<LockInfo, 'at' | 'forced'>, force: boolean): { lock: LockInfo; previous: LockInfo | null } {
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, 'final.lock');
  let previous: LockInfo | null = null;
  if (existsSync(file)) {
    previous = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
    if (!force) {
      throw new Error(`sealed test set was already scored at ${previous.at} for ${previous.runDir}. Re-scoring requires --force (it will be recorded as forced).`);
    }
  }
  const lock: LockInfo = { ...info, at: new Date().toISOString(), forced: previous !== null };
  writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
  return { lock, previous };
}

const perPersona = (scores: number[], reps: number) => Array.from({ length: scores.length / reps }, (_, i) => mean(scores.slice(i * reps, (i + 1) * reps)));

function compare(x: number[], y: number[], reps: number) {
  const ci = bootstrapCi(pairedDiff(x, y));
  const px = perPersona(x, reps);
  const py = perPersona(y, reps);
  return {
    meanDiff: ci.mean, lo: ci.lo, hi: ci.hi,
    wins: px.filter((v, i) => v > py[i]!).length,
    ties: px.filter((v, i) => v === py[i]!).length,
    losses: px.filter((v, i) => v < py[i]!).length,
  };
}

export async function scoreFinal(args: {
  test: Persona[];
  reps: number;
  policies: { learner: Policy; gen0: Policy; final: Policy };
  concurrency?: number;
}) {
  const { test, reps } = args;
  const opts = { concurrency: args.concurrency ?? 6 };
  const learner = await evaluate(args.policies.learner, test, reps, undefined, opts);
  const gen0 = await evaluate(args.policies.gen0, test, reps, undefined, opts);
  const final = await evaluate(args.policies.final, test, reps, undefined, opts);
  const random = await evaluate(randomPolicy, test, reps);
  const oracle = oracleScores(test, reps);
  const ci = (xs: number[]) => bootstrapCi(xs);
  return {
    personas: test.length, reps, episodes: test.length * reps,
    scores: { random: ci(random), learner: ci(learner), gen0: ci(gen0), final: ci(final), oracle: ci(oracle) },
    comparisons: {
      gen0_vs_learner: compare(gen0, learner, reps),
      final_vs_gen0: compare(final, gen0, reps),
      final_vs_learner: compare(final, learner, reps),
    },
    raw: { learner, gen0, final },
  };
}

// Primary success criterion (PREREGISTRATION.md, run 2): final minus gen0 must have a paired 95% CI lower bound above 0.
export function primaryCriterion(c: { meanDiff: number; lo: number; hi: number }): { pass: boolean; line: string } {
  const pass = c.lo > 0;
  return {
    pass,
    line: `**Primary success criterion (pre-registered): final minus gen0, paired 95% CI lower bound > 0. Result: ${pts(c.meanDiff)} pts, CI ${pts(c.lo)} .. ${pts(c.hi)} -> ${pass ? 'PASS' : 'FAIL'}.**`,
  };
}

export function toMarkdown(r: Awaited<ReturnType<typeof scoreFinal>>, meta: { runDir: string; finalGen: number; forced: boolean; models: string; title?: string; criterion?: boolean }): string {
  const row = (name: string, s: { mean: number; lo: number; hi: number }) => `| ${name} | ${pct(s.mean)} | ${pct(s.lo)} - ${pct(s.hi)} |`;
  const cmp = (name: string, c: ReturnType<typeof compare>) =>
    `| ${name} | ${pts(c.meanDiff)} pts | ${pts(c.lo)} .. ${pts(c.hi)} | ${c.wins} / ${c.ties} / ${c.losses} |`;
  return [
    meta.title ?? '# Sealed test: before vs after self-improvement',
    '',
    `${r.personas} unseen simulated listeners x ${r.reps} sessions (${r.episodes} paired episodes). Score = share of thumbs-up after 5 warmup votes of 30.`,
    `Run: \`${meta.runDir}\`, final generation: gen${meta.finalGen}. Models: ${meta.models}.${meta.forced ? ' **FORCED re-score: the test set had been scored before.**' : ''}`,
    '',
    '| Policy | Like rate | 95% CI |',
    '| --- | --- | --- |',
    row('Random (floor)', r.scores.random),
    row('(a) Deterministic learner', r.scores.learner),
    row('(b) Advisor gen0 (original prompt/playbook/params)', r.scores.gen0),
    row(`(c) Advisor gen${meta.finalGen} (after self-improvement)`, r.scores.final),
    row('Oracle (ceiling; reads hidden taste)', r.scores.oracle),
    '',
    '| Comparison (paired) | Mean gain | 95% bootstrap CI | Per-listener wins / ties / losses |',
    '| --- | --- | --- | --- |',
    cmp('(b) gen0 vs (a) learner', r.comparisons.gen0_vs_learner),
    cmp('(c) final vs (b) gen0', r.comparisons.final_vs_gen0),
    cmp('(c) final vs (a) learner', r.comparisons.final_vs_learner),
    '',
    ...(meta.criterion ? [primaryCriterion(r.comparisons.final_vs_gen0).line, ''] : []),
  ].join('\n');
}

function latestRun(): string {
  const dirs = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((d) => existsSync(join(RUNS_DIR, d, 'gen0'))).sort() : [];
  if (!dirs.length) throw new Error('no runs found; run selfimprove:loop first or pass --run <dir>');
  return join(RUNS_DIR, dirs.at(-1)!);
}

function finalGenOf(runDir: string): number {
  const gens = readdirSync(runDir).map((d) => /^gen(\d+)$/.exec(d)?.[1]).filter((x): x is string => x !== undefined).map(Number);
  return Math.max(...gens);
}

export type TestSet = 'run1' | 'run2';

// Each sealed set has its own results directory and its own lock, so scoring one never touches the other.
export function testSetConfig(set: TestSet): { personas: () => Persona[]; resultsDir: string; title: string; criterion: boolean } {
  if (set === 'run2') {
    return {
      personas: () => splitPersonasRun2().test,
      resultsDir: join(RESULTS_DIR, 'run2'),
      title: '# Run 2 sealed test: before vs after self-improvement (two-stage gate, see PREREGISTRATION.md)',
      criterion: true,
    };
  }
  return { personas: () => splitPersonas().test, resultsDir: RESULTS_DIR, title: '# Sealed test: before vs after self-improvement', criterion: false };
}

async function main() {
  const argv = process.argv.slice(2);
  const testSet = (flag(argv, 'test-set') ?? 'run1') as TestSet;
  if (testSet !== 'run1' && testSet !== 'run2') throw new Error(`unknown --test-set ${testSet} (run1 or run2)`);
  const set = testSetConfig(testSet);
  const runArg = flag(argv, 'run');
  if (testSet === 'run2') {
    if (!runArg) throw new Error('--test-set run2 requires --run <run-2 loop output dir>');
    const summaryFile = join(runArg, 'summary.json');
    const design = existsSync(summaryFile) ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as { design?: string }).design : undefined;
    if (design !== 'run2') throw new Error(`${runArg} is not a run-2 loop output (summary.json design=${design ?? 'missing'})`);
  }
  const runDir = runArg ?? latestRun();
  const reps = numFlag(argv, 'reps', 'SELFIMPROVE_TEST_REPS', 3);
  const concurrency = numFlag(argv, 'concurrency', 'SELFIMPROVE_CONCURRENCY', 6);
  const force = argv.includes('--force');
  const finalGen = finalGenOf(runDir);
  const gen0: Bundle = readBundle(join(runDir, 'gen0'));
  const fin: Bundle = readBundle(join(runDir, `gen${finalGen}`));
  const live = createLive({});
  const { lock, previous } = acquireLock(set.resultsDir, { runDir, gen0Hash: bundleHash(gen0), finalHash: bundleHash(fin) }, force);
  const t0 = Date.now();
  const r = await scoreFinal({
    test: set.personas(),
    reps,
    concurrency,
    policies: { learner: baselinePolicy, gen0: live.advisor(gen0, 'gen0'), final: live.advisor(fin, `gen${finalGen}`) },
  });
  const meta = { runDir, finalGen, forced: lock.forced, models: `advisor ${live.cfg.fastModel}; reviewer/rewriter ${live.cfg.strongModel}` };
  const criterion = set.criterion ? primaryCriterion(r.comparisons.final_vs_gen0) : undefined;
  writeFileSync(join(set.resultsDir, 'final.json'), JSON.stringify({ testSet, ...meta, ...(criterion ? { primaryCriterion: criterion } : {}), lock, previousLock: previous, wallSeconds: Math.round((Date.now() - t0) / 1000), llm: live.gateway.snapshot(), ...r }, null, 2));
  const md = toMarkdown(r, { ...meta, title: set.title, criterion: set.criterion });
  writeFileSync(join(set.resultsDir, 'final.md'), md);
  console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e)); process.exit(1); });
}
