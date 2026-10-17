// pnpm selfimprove:final -- --run <runs/dir> [--test-set run1|run2]: scores ONCE on the sealed TEST personas.
// run1 (default): results/final.{json,md,lock}. run2: results/run2/final.{json,md,lock} (separate lock).
// run3: results/run3/final.{json,md,lock} (separate lock; 99% criterion from PREREGISTRATION_RUN3.md).
// (a) deterministic learner, (b) advisor gen0, (c) advisor final generation. A lock file prevents silent re-scoring.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Bundle } from './advisor.ts';
import { splitPersonas, splitPersonasRun2, splitPersonasRun3, type Persona } from './personas.ts';
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

// Run 3 criterion (PREREGISTRATION_RUN3.md): CLAIMED if the paired 99% CI lower bound of final minus gen0 is above 0;
// SUGGESTIVE if only the 95% lower bound is; NEGATIVE otherwise. final == gen0 fails by construction.
export type Run3Verdict = 'CLAIMED' | 'SUGGESTIVE' | 'NEGATIVE';
export function run3Criterion(diffs: number[], sameBundle: boolean): { verdict: Run3Verdict; mean: number; ci95: { lo: number; hi: number }; ci99: { lo: number; hi: number }; byConstruction: boolean; line: string } {
  const c95 = bootstrapCi(diffs);
  const c99 = bootstrapCi(diffs, 1, 2000, 0.01);
  const verdict: Run3Verdict = sameBundle ? 'NEGATIVE' : c99.lo > 0 ? 'CLAIMED' : c95.lo > 0 ? 'SUGGESTIVE' : 'NEGATIVE';
  const head = `**Run 3 success criterion (pre-registered): final minus gen0, paired 99% CI lower bound > 0 (95% only = suggestive). Result: ${pts(c95.mean)} pts, 95% CI ${pts(c95.lo)} .. ${pts(c95.hi)}, 99% CI ${pts(c99.lo)} .. ${pts(c99.hi)} -> ${verdict}.**`;
  const line = sameBundle ? `${head}\n\nNothing was adopted (final = gen0): the criterion fails by construction and run 3 is negative.` : head;
  return { verdict, mean: c95.mean, ci95: { lo: c95.lo, hi: c95.hi }, ci99: { lo: c99.lo, hi: c99.hi }, byConstruction: sameBundle, line };
}

export function toMarkdown(r: Awaited<ReturnType<typeof scoreFinal>>, meta: { runDir: string; finalGen: number; forced: boolean; models: string; title?: string; criterion?: boolean; extra?: string[] }): string {
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
    ...(meta.extra ?? []),
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

export type TestSet = 'run1' | 'run2' | 'run3';

// Each sealed set has its own results directory and its own lock, so scoring one never touches the other.
export function testSetConfig(set: TestSet): { personas: () => Persona[]; resultsDir: string; title: string; criterion: boolean } {
  if (set === 'run3') {
    return {
      personas: () => splitPersonasRun3().test,
      resultsDir: join(RESULTS_DIR, 'run3'),
      title: '# Run 3 sealed test: before vs after self-improvement (new advisor model, wider surface; see PREREGISTRATION_RUN3.md)',
      criterion: false, // run 3 uses the stricter 99% criterion (run3Criterion), not the run-2 95% line
    };
  }
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
  if (testSet !== 'run1' && testSet !== 'run2' && testSet !== 'run3') throw new Error(`unknown --test-set ${testSet} (run1, run2 or run3)`);
  const set = testSetConfig(testSet);
  const runArg = flag(argv, 'run');
  let runAdvisorModel: string | undefined;
  if (testSet === 'run2' || testSet === 'run3') {
    if (!runArg) throw new Error(`--test-set ${testSet} requires --run <${testSet} loop output dir>`);
    const summaryFile = join(runArg, 'summary.json');
    const summary = existsSync(summaryFile) ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as { design?: string; settings?: { advisorModel?: string } }) : undefined;
    const design = summary?.design;
    if (design !== testSet) throw new Error(`${runArg} is not a ${testSet} loop output (summary.json design=${design ?? 'missing'})`);
    runAdvisorModel = summary?.settings?.advisorModel;
  }
  // The sealed test uses the same advisor model the loop used (recorded in summary.json); an explicit flag must agree.
  const advisorModelArg = flag(argv, 'advisor-model');
  if (testSet === 'run3' && advisorModelArg && runAdvisorModel && advisorModelArg !== runAdvisorModel) {
    throw new Error(`--advisor-model ${advisorModelArg} differs from the run's advisor model ${runAdvisorModel}`);
  }
  const runDir = runArg ?? latestRun();
  const reps = numFlag(argv, 'reps', 'SELFIMPROVE_TEST_REPS', 3);
  const concurrency = numFlag(argv, 'concurrency', 'SELFIMPROVE_CONCURRENCY', 6);
  const force = argv.includes('--force');
  const finalGen = finalGenOf(runDir);
  const gen0: Bundle = readBundle(join(runDir, 'gen0'));
  const fin: Bundle = readBundle(join(runDir, `gen${finalGen}`));
  const live = createLive({ advisorModel: testSet === 'run3' ? (advisorModelArg ?? runAdvisorModel) : advisorModelArg });
  if (testSet === 'run3' && !runAdvisorModel) throw new Error('run3 summary.json does not record settings.advisorModel');
  const { lock, previous } = acquireLock(set.resultsDir, { runDir, gen0Hash: bundleHash(gen0), finalHash: bundleHash(fin) }, force);
  const t0 = Date.now();
  const r = await scoreFinal({
    test: set.personas(),
    reps,
    concurrency,
    policies: { learner: baselinePolicy, gen0: live.advisor(gen0, 'gen0'), final: live.advisor(fin, `gen${finalGen}`) },
  });
  const meta = { runDir, finalGen, forced: lock.forced, advisorModel: live.advisorModel, models: `advisor ${live.advisorModel}; reviewer/rewriter ${live.cfg.strongModel}` };
  const criterion = set.criterion ? primaryCriterion(r.comparisons.final_vs_gen0) : undefined;
  const c3 = testSet === 'run3' ? run3Criterion(pairedDiff(r.raw.final, r.raw.gen0), bundleHash(gen0) === bundleHash(fin)) : undefined;
  const vsLearner = (name: string, c: { meanDiff: number; lo: number; hi: number }) => `- ${name}: ${pts(c.meanDiff)} pts (95% CI ${pts(c.lo)} .. ${pts(c.hi)})`;
  const extra = c3 ? [c3.line, '', 'Versus the plain learner (reported regardless of outcome):', vsLearner('gen0 vs learner', r.comparisons.gen0_vs_learner), vsLearner(`final (gen${finalGen}) vs learner`, r.comparisons.final_vs_learner), ''] : [];
  writeFileSync(join(set.resultsDir, 'final.json'), JSON.stringify({ testSet, ...meta, ...(criterion ? { primaryCriterion: criterion } : {}), ...(c3 ? { run3Criterion: c3 } : {}), lock, previousLock: previous, wallSeconds: Math.round((Date.now() - t0) / 1000), llm: live.gateway.snapshot(), ...r }, null, 2));
  const md = toMarkdown(r, { ...meta, title: set.title, criterion: set.criterion, extra });
  writeFileSync(join(set.resultsDir, 'final.md'), md);
  console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e)); process.exit(1); });
}
