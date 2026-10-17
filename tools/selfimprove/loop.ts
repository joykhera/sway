// pnpm selfimprove:loop: the self-improvement loop. Uses TRAIN personas for transcripts and VALIDATION personas for
// keep/revert decisions. It never loads or scores the sealed TEST personas (see final.ts).
// Default = run 1 design. `--design run2` = the pre-registered two-stage gate (PREREGISTRATION.md).
// `--design run3` = the same two-stage gate on the run-3 split, new advisor model, wider params (PREREGISTRATION_RUN3.md).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Bundle } from './advisor.ts';
import { decide } from './gatekeeper.ts';
import { diffStats, emptyStats, type Role, type RoleStats } from './llm.ts';
import { splitPersonas, splitPersonasRun2, splitPersonasRun3, type Persona } from './personas.ts';
import { formatTranscripts, review, toTranscriptEpisodes } from './reviewer.ts';
import { rewrite, type HistoryEntry, type Rejected, type Variant } from './rewriter.ts';
import { baselinePolicy, evaluate, evaluateEpisodes, type EpisodeConfig, DEFAULT_EPISODE } from './simulator.ts';
import { mean } from './stats.ts';
import { ARTIFACTS_DIR, RUNS_DIR, bundleHash, createLive, numFlag, flag, pct, pts, readBundle, writeBundle } from './team.ts';

export type LoopDeps = {
  runTrain(bundle: Bundle): Promise<{ scores: number[]; transcripts: string }>;
  runVal(bundle: Bundle): Promise<number[]>;
  review(bundle: Bundle, transcripts: string): Promise<string>;
  rewrite(current: Bundle, diagnosis: string, history: HistoryEntry[]): Promise<{ variants: Variant[]; rejected: Rejected[]; raw?: string[] }>;
  stats?(): Record<Role, RoleStats>;
  log?(msg: string): void;
};

export type LoopResult = { finalBundle: Bundle; finalGen: number; history: HistoryEntry[]; outDir: string; incumbentVal: number[] };

const zeroStats = (): Record<Role, RoleStats> => ({ advisor: emptyStats(), reviewer: emptyStats(), rewriter: emptyStats() });

export async function runLoop(args: { gen0: Bundle; deps: LoopDeps; rounds: number; outDir: string; margin?: number }): Promise<LoopResult> {
  const { deps, outDir } = args;
  const margin = args.margin ?? 0.02;
  const log = deps.log ?? (() => {});
  const stats = deps.stats ?? zeroStats;
  mkdirSync(outDir, { recursive: true });
  const changelog = join(outDir, 'changelog.jsonl');
  const record = (o: object) => appendFileSync(changelog, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

  const valMemo = new Map<string, number[]>();
  const val = async (b: Bundle) => {
    const h = bundleHash(b);
    if (!valMemo.has(h)) valMemo.set(h, await deps.runVal(b));
    return valMemo.get(h)!;
  };

  let incumbent = args.gen0;
  let gen = 0;
  writeBundle(join(outDir, 'gen0'), incumbent);
  const history: HistoryEntry[] = [];

  for (let round = 1; round <= args.rounds; round++) {
    const roundDir = join(outDir, `round${round}`);
    mkdirSync(roundDir, { recursive: true });
    const s0 = stats();
    const genBefore = gen;

    log(`round ${round}: train run of gen${gen}`);
    const train = await deps.runTrain(incumbent);
    writeFileSync(join(roundDir, 'transcripts.txt'), train.transcripts);
    const diagnosis = await deps.review(incumbent, train.transcripts);
    writeFileSync(join(roundDir, 'diagnosis.md'), diagnosis + '\n');
    log(`round ${round}: diagnosis written (${diagnosis.length} chars); rewriting`);
    const rw = await deps.rewrite(incumbent, diagnosis, history);
    writeFileSync(join(roundDir, 'variants.json'), JSON.stringify({ variants: rw.variants, rejected: rw.rejected }, null, 2));
    if (rw.raw) writeFileSync(join(roundDir, 'rewriter_raw.txt'), rw.raw.join('\n\n=====\n\n'));
    for (const r of rw.rejected) record({ type: 'malformed', round, gen, ...r });

    const incVal = await val(incumbent);
    log(`round ${round}: incumbent gen${gen} val ${pct(mean(incVal))}`);
    const evaluated: { v: Variant; entry: HistoryEntry }[] = [];
    for (const [i, v] of rw.variants.entries()) {
      const scores = await val(v.bundle);
      const d = decide(scores, incVal, margin);
      const entry: HistoryEntry = {
        round, name: v.name, hash: bundleHash(v.bundle), rationale: v.rationale, params: v.bundle.params,
        meanDiff: d.meanDiff, lo: d.lo, hi: d.hi, accept: d.accept, adopted: false, reason: d.reason,
      };
      writeBundle(join(roundDir, `variant${i + 1}`), v.bundle);
      evaluated.push({ v, entry });
      log(`round ${round}: variant "${v.name}" val ${pct(mean(scores))} gain ${pts(d.meanDiff)} CI [${pts(d.lo)}, ${pts(d.hi)}] -> ${d.accept ? 'accept' : 'reject'} (${d.reason})`);
    }
    const accepted = evaluated.filter((e) => e.entry.accept).sort((a, b) => b.entry.meanDiff - a.entry.meanDiff);
    const winner = accepted[0];
    if (winner) {
      winner.entry.adopted = true;
      incumbent = winner.v.bundle;
      gen++;
      writeBundle(join(outDir, `gen${gen}`), incumbent);
    }
    const roundStats = diffStats(stats(), s0);
    for (const [i, { v, entry }] of evaluated.entries()) {
      record({ type: 'attempt', incumbentGen: genBefore, adoptedAsGen: entry.adopted ? gen : null, variantDir: `round${round}/variant${i + 1}`, valScore: mean(valMemo.get(entry.hash)!), incumbentValScore: mean(incVal), paramWarnings: v.warnings, ...entry, decision: entry.adopted ? 'adopted' : entry.accept ? 'accepted-not-best' : 'reverted' });
    }
    record({ type: 'round', round, incumbentGenAfter: gen, adopted: winner?.v.name ?? null, trainScore: mean(train.scores), incumbentValScore: mean(incVal), variants: rw.variants.length, malformed: rw.rejected.length, llm: roundStats });
    history.push(...evaluated.map((e) => e.entry));
    log(`round ${round}: ${winner ? `ADOPTED "${winner.v.name}" as gen${gen}` : `no variant cleared the gate; kept gen${gen}`}`);
  }
  return { finalBundle: incumbent, finalGen: gen, history, outDir, incumbentVal: await val(incumbent) };
}

// ---------------------------------------------------------------- Run 2: two-stage gate (PREREGISTRATION.md)
// Stage A: every variant vs the incumbent on validation-A (paired). Pass = mean gain >= 3 pts AND paired 95% CI lower bound > 0.
// Stage B: only the single best stage-A passer is replicated vs the incumbent on the untouched validation-B (paired).
//          Adopt = mean gain >= 2 pts AND CI lower bound > 0. Otherwise revert.
// Hard wall-clock cutoff: no new round or stage starts after the deadline; the latest adopted generation is final.
export const RUN2_STAGE_A_MARGIN = 0.03;
export const RUN2_STAGE_B_MARGIN = 0.02;

export type LoopDepsRun2 = Omit<LoopDeps, 'runVal'> & {
  runValA(bundle: Bundle): Promise<number[]>;
  runValB(bundle: Bundle): Promise<number[]>;
  now?(): number;
};

export type Run2Result = {
  finalBundle: Bundle;
  finalGen: number;
  history: HistoryEntry[];
  outDir: string;
  cutoff: { round: number; before: string; elapsedMinutes: number } | null;
  roundsCompleted: number;
  gen0ValA: number | null;
  finalValA: number | null;
  finalValB: number | null;
};

export async function runLoopRun2(args: {
  gen0: Bundle;
  deps: LoopDepsRun2;
  rounds: number;
  outDir: string;
  deadlineMinutes?: number;
  summaryExtra?: () => object;
  design?: 'run2' | 'run3';
  meta?: object; // recorded once at the start of the changelog (e.g. models, settings)
}): Promise<Run2Result> {
  const { deps, outDir } = args;
  const design = args.design ?? 'run2';
  const log = deps.log ?? (() => {});
  const stats = deps.stats ?? zeroStats;
  const now = deps.now ?? Date.now;
  const tStart = now();
  const deadlineAt = args.deadlineMinutes !== undefined && Number.isFinite(args.deadlineMinutes) ? tStart + args.deadlineMinutes * 60_000 : Infinity;
  mkdirSync(outDir, { recursive: true });
  const changelog = join(outDir, 'changelog.jsonl');
  const record = (o: object) => appendFileSync(changelog, JSON.stringify({ ts: new Date().toISOString(), design, ...o }) + '\n');

  const memo = (run: (b: Bundle) => Promise<number[]>) => {
    const m = new Map<string, number[]>();
    return {
      get: async (b: Bundle) => {
        const h = bundleHash(b);
        if (!m.has(h)) m.set(h, await run(b));
        return m.get(h)!;
      },
      peek: (b: Bundle) => m.get(bundleHash(b)) ?? null,
    };
  };
  const valA = memo((b) => deps.runValA(b));
  const valB = memo((b) => deps.runValB(b));

  let incumbent = args.gen0;
  let gen = 0;
  let roundsCompleted = 0;
  let cutoff: Run2Result['cutoff'] = null;
  writeBundle(join(outDir, 'gen0'), incumbent);
  const history: HistoryEntry[] = [];
  if (args.meta) record({ type: 'start', gen0Hash: bundleHash(incumbent), ...args.meta });

  // True (and recorded once) if the deadline has passed, so the caller must not start `before`.
  const cutNow = (round: number, before: string) => {
    if (cutoff) return true;
    if (now() < deadlineAt) return false;
    cutoff = { round, before, elapsedMinutes: (now() - tStart) / 60_000 };
    record({ type: 'cutoff', ...cutoff, incumbentGen: gen });
    log(`deadline reached after ${cutoff.elapsedMinutes.toFixed(1)} min: not starting ${before} of round ${round}; final = gen${gen}`);
    return true;
  };

  const writeSummary = (error?: unknown) => {
    const summary = {
      design,
      outDir,
      finalGen: gen,
      finalHash: bundleHash(incumbent),
      roundsCompleted,
      cutoff,
      gates: { stageA: { margin: RUN2_STAGE_A_MARGIN, ciLoAbove: 0 }, stageB: { margin: RUN2_STAGE_B_MARGIN, ciLoAbove: 0 } },
      gen0ValA: valA.peek(args.gen0) ? mean(valA.peek(args.gen0)!) : null,
      finalValA: valA.peek(incumbent) ? mean(valA.peek(incumbent)!) : null,
      finalValB: valB.peek(incumbent) ? mean(valB.peek(incumbent)!) : null,
      wallSeconds: Math.round((now() - tStart) / 1000),
      ...(error !== undefined ? { error: String(error) } : {}),
      ...(args.summaryExtra?.() ?? {}),
      attempts: history,
    };
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  };

  try {
    for (let round = 1; round <= args.rounds; round++) {
      if (cutNow(round, 'round')) break;
      const roundDir = join(outDir, `round${round}`);
      mkdirSync(roundDir, { recursive: true });
      const s0 = stats();
      const genBefore = gen;

      log(`round ${round}: train run of gen${gen}`);
      const train = await deps.runTrain(incumbent);
      writeFileSync(join(roundDir, 'transcripts.txt'), train.transcripts);
      const diagnosis = await deps.review(incumbent, train.transcripts);
      writeFileSync(join(roundDir, 'diagnosis.md'), diagnosis + '\n');
      log(`round ${round}: diagnosis written (${diagnosis.length} chars); rewriting`);
      const rw = await deps.rewrite(incumbent, diagnosis, history);
      writeFileSync(join(roundDir, 'variants.json'), JSON.stringify({ variants: rw.variants, rejected: rw.rejected }, null, 2));
      if (rw.raw) writeFileSync(join(roundDir, 'rewriter_raw.txt'), rw.raw.join('\n\n=====\n\n'));
      for (const r of rw.rejected) record({ type: 'malformed', round, gen, ...r });
      rw.variants.forEach((v, i) => writeBundle(join(roundDir, `variant${i + 1}`), v.bundle));

      // ---- Stage A (validation-A)
      if (cutNow(round, 'stage A')) break;
      const incA = await valA.get(incumbent);
      log(`round ${round}: incumbent gen${gen} valA ${pct(mean(incA))}`);
      type Ev = { v: Variant; i: number; entry: HistoryEntry; scoreA: number; decision?: string };
      const evaluated: Ev[] = [];
      for (const [i, v] of rw.variants.entries()) {
        if (cutNow(round, `stage A (variant ${i + 1})`)) break;
        const scores = await valA.get(v.bundle);
        const d = decide(scores, incA, RUN2_STAGE_A_MARGIN);
        const entry: HistoryEntry = {
          round, name: v.name, hash: bundleHash(v.bundle), rationale: v.rationale, params: v.bundle.params,
          meanDiff: d.meanDiff, lo: d.lo, hi: d.hi, accept: d.accept, adopted: false, reason: `stage A (valA): ${d.reason}`,
        };
        evaluated.push({ v, i, entry, scoreA: mean(scores) });
        record({
          type: 'stage', stage: 'A', set: 'valA', round, name: v.name, hash: entry.hash, variantDir: `round${round}/variant${i + 1}`, incumbentGen: genBefore,
          episodes: scores.length, valAScore: mean(scores), incumbentValAScore: mean(incA), margin: RUN2_STAGE_A_MARGIN,
          meanDiff: d.meanDiff, lo: d.lo, hi: d.hi, pass: d.accept, reason: d.reason, paramWarnings: v.warnings,
        });
        log(`round ${round}: stage A "${v.name}" valA ${pct(mean(scores))} gain ${pts(d.meanDiff)} CI [${pts(d.lo)}, ${pts(d.hi)}] -> ${d.accept ? 'PASS' : 'fail'} (${d.reason})`);
      }

      // ---- Stage B (validation-B): replicate only the best stage-A passer
      const passers = evaluated.filter((e) => e.entry.accept).sort((a, b) => b.entry.meanDiff - a.entry.meanDiff);
      const best = passers[0];
      let stageB: { name: string; meanDiff: number; lo: number; hi: number; pass: boolean; reason: string } | null = null;
      for (const e of evaluated) e.decision = e.entry.accept ? 'passed-stageA-not-best' : 'reverted-failed-stageA';
      for (const e of passers.slice(1)) e.entry.reason += '; not the best stage-A passer, so not replicated';
      if (best) {
        if (cutNow(round, 'stage B')) {
          best.decision = 'not-adopted-cutoff-before-stageB';
          best.entry.accept = false;
          best.entry.reason += '; deadline reached before replication, not adopted';
        } else {
          const incB = await valB.get(incumbent);
          const scoresB = await valB.get(best.v.bundle);
          const d = decide(scoresB, incB, RUN2_STAGE_B_MARGIN);
          stageB = { name: best.v.name, meanDiff: d.meanDiff, lo: d.lo, hi: d.hi, pass: d.accept, reason: d.reason };
          record({
            type: 'stage', stage: 'B', set: 'valB', round, name: best.v.name, hash: best.entry.hash, variantDir: `round${round}/variant${best.i + 1}`, incumbentGen: genBefore,
            episodes: scoresB.length, valBScore: mean(scoresB), incumbentValBScore: mean(incB), margin: RUN2_STAGE_B_MARGIN,
            meanDiff: d.meanDiff, lo: d.lo, hi: d.hi, pass: d.accept, reason: d.reason,
          });
          log(`round ${round}: stage B "${best.v.name}" valB ${pct(mean(scoresB))} vs incumbent ${pct(mean(incB))} gain ${pts(d.meanDiff)} CI [${pts(d.lo)}, ${pts(d.hi)}] -> ${d.accept ? 'PASS' : 'fail'} (${d.reason})`);
          const bText = `stage B (valB) gain ${pts(d.meanDiff)} pts CI ${pts(d.lo)}..${pts(d.hi)}: ${d.reason}`;
          if (d.accept) {
            best.entry.adopted = true;
            best.entry.reason += `; replicated, ${bText}`;
            best.decision = 'adopted';
            incumbent = best.v.bundle;
            gen++;
            writeBundle(join(outDir, `gen${gen}`), incumbent);
          } else {
            best.entry.accept = false; // shown to the Rewriter as REJECTED: it did not replicate
            best.entry.reason += `; FAILED replication, ${bText}`;
            best.decision = 'reverted-failed-stageB';
          }
        }
      }
      const roundStats = diffStats(stats(), s0);
      for (const e of evaluated) {
        record({ type: 'attempt', round, name: e.v.name, hash: e.entry.hash, variantDir: `round${round}/variant${e.i + 1}`, incumbentGen: genBefore, adoptedAsGen: e.entry.adopted ? gen : null, valAScore: e.scoreA, meanDiffA: e.entry.meanDiff, loA: e.entry.lo, hiA: e.entry.hi, stageB: e === best ? stageB : null, decision: e.decision, reason: e.entry.reason });
      }
      record({
        type: 'round', round, incumbentGenBefore: genBefore, incumbentGenAfter: gen, adopted: best?.entry.adopted ? best.v.name : null,
        stageAPassers: passers.map((p) => p.v.name), replicated: best && stageB ? best.v.name : null, stageB,
        trainScore: mean(train.scores), incumbentValAScore: mean(incA), variants: rw.variants.length, evaluated: evaluated.length, malformed: rw.rejected.length,
        complete: !cutoff, llm: roundStats,
      });
      history.push(...evaluated.map((e) => e.entry));
      if (!cutoff) roundsCompleted = round;
      log(`round ${round}: ${best?.entry.adopted ? `ADOPTED "${best.v.name}" as gen${gen}` : best ? `"${best.v.name}" passed stage A but was not adopted; kept gen${gen}` : `no variant passed stage A; kept gen${gen}`}`);
      if (cutoff) break;
    }
    writeSummary();
  } catch (e) {
    writeSummary(e);
    throw e;
  }
  return {
    finalBundle: incumbent, finalGen: gen, history, outDir, cutoff, roundsCompleted,
    gen0ValA: valA.peek(args.gen0) ? mean(valA.peek(args.gen0)!) : null,
    finalValA: valA.peek(incumbent) ? mean(valA.peek(incumbent)!) : null,
    finalValB: valB.peek(incumbent) ? mean(valB.peek(incumbent)!) : null,
  };
}

// ---------------------------------------------------------------- CLI
async function main() {
  const argv = process.argv.slice(2);
  if (flag(argv, 'design') === 'run2') return mainRun2(argv);
  if (flag(argv, 'design') === 'run3') return mainRun2(argv, 'run3');
  if (flag(argv, 'design') !== undefined) throw new Error(`unknown --design ${flag(argv, 'design')} (expected run2, run3, or omit for run 1)`);
  const rounds = numFlag(argv, 'rounds', 'SELFIMPROVE_ROUNDS', 4);
  const nVariants = numFlag(argv, 'variants', 'SELFIMPROVE_VARIANTS', 3);
  const trainPersonas = numFlag(argv, 'train-personas', 'SELFIMPROVE_TRAIN_PERSONAS', 8);
  const trainReps = numFlag(argv, 'train-reps', 'SELFIMPROVE_TRAIN_REPS', 1);
  const valPersonas = numFlag(argv, 'val-personas', 'SELFIMPROVE_VAL_PERSONAS', 12);
  const valReps = numFlag(argv, 'val-reps', 'SELFIMPROVE_VAL_REPS', 2);
  const concurrency = numFlag(argv, 'concurrency', 'SELFIMPROVE_CONCURRENCY', 6);
  const margin = numFlag(argv, 'margin', 'SELFIMPROVE_MARGIN', 0.02);
  const noCache = argv.includes('--no-cache');
  const startDir = flag(argv, 'from') ?? ARTIFACTS_DIR;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = flag(argv, 'out') ?? join(RUNS_DIR, stamp);
  const cfgEp: EpisodeConfig = DEFAULT_EPISODE;

  // Only train and validation are taken from the split. The sealed test set stays untouched.
  const split = splitPersonas();
  const train: Persona[] = split.train.slice(0, trainPersonas);
  const valSet: Persona[] = split.val.slice(0, valPersonas);

  const live = createLive({ noCache });
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
  let k = 0;
  const deps: LoopDeps = {
    async runTrain(b) {
      const res = await evaluateEpisodes(live.advisor(b, `train-${k++}`), train, trainReps, cfgEp, { concurrency });
      return { scores: res.map((r) => r.episode.score), transcripts: formatTranscripts(toTranscriptEpisodes(res)) };
    },
    runVal: (b) => evaluate(live.advisor(b, `val-${bundleHash(b)}`), valSet, valReps, cfgEp, { concurrency }),
    review: (b, transcripts) => review({ gateway: live.gateway, model: live.cfg.strongModel, bundle: b, transcripts }),
    rewrite: (current, diagnosis, history) => rewrite({ gateway: live.gateway, model: live.cfg.strongModel, current, diagnosis, history, n: nVariants }),
    stats: () => live.gateway.snapshot(),
    log,
  };

  log(`run dir ${outDir}; rounds=${rounds} variants=${nVariants} train=${train.length}x${trainReps} val=${valSet.length}x${valReps} concurrency=${concurrency} margin=${margin}`);
  const learnerVal = await evaluate(baselinePolicy, valSet, valReps, cfgEp);
  log(`reference: deterministic learner val ${pct(mean(learnerVal))}`);
  const result = await runLoop({ gen0: readBundle(startDir), deps, rounds, outDir, margin });
  const summary = {
    outDir,
    finalGen: result.finalGen,
    finalHash: bundleHash(result.finalBundle),
    learnerVal: mean(learnerVal),
    gen0Val: mean(await deps.runVal(readBundle(join(outDir, 'gen0')))),
    finalVal: mean(result.incumbentVal),
    settings: { rounds, nVariants, trainPersonas, trainReps, valPersonas, valReps, concurrency, margin, fastModel: live.cfg.fastModel, strongModel: live.cfg.strongModel },
    llm: live.gateway.snapshot(),
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    attempts: result.history,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`done: final gen${result.finalGen}; val learner ${pct(summary.learnerVal)}, gen0 ${pct(summary.gen0Val)}, final ${pct(summary.finalVal)}`);
  for (const [role, s] of Object.entries(summary.llm)) log(`llm ${role}: ${s.calls} calls (+${s.cacheHits} cache hits, ${s.errors} errors), ${s.promptTokens}+${s.completionTokens} tokens`);
  log(`next: npx tsx --env-file-if-exists=.env tools/selfimprove/final.ts --run ${outDir}`);
}

// Run 3 fixed design (PREREGISTRATION_RUN3.md).
export const RUN3_ADVISOR_MODEL = 'nvidia/Nemotron-3.5-Lightning-30B-A3B';
export const RUN3_MAX_ROUNDS = 2;
export const RUN3_MAX_VARIANTS = 3;
export const RUN3_PERSONA_SEED = 9001;

// Only train, validation-A and validation-B are taken from each split. The sealed sets stay untouched.
export function loopSplit(design: 'run2' | 'run3'): { train: Persona[]; valA: Persona[]; valB: Persona[] } {
  if (design === 'run3') {
    const { train, valA, valB } = splitPersonasRun3();
    return { train, valA, valB };
  }
  const { train, valA, valB } = splitPersonasRun2();
  return { train, valA, valB };
}

// Run 2/3 CLI. Set sizes and gate margins are fixed by the pre-registrations and are deliberately not flags.
async function mainRun2(argv: string[], design: 'run2' | 'run3' = 'run2') {
  const run3 = design === 'run3';
  const rounds = numFlag(argv, 'rounds', 'SELFIMPROVE_ROUNDS', run3 ? RUN3_MAX_ROUNDS : 3);
  const nVariants = numFlag(argv, 'variants', 'SELFIMPROVE_VARIANTS', 3);
  const trainReps = numFlag(argv, 'train-reps', 'SELFIMPROVE_TRAIN_REPS', 1);
  const valReps = numFlag(argv, 'val-reps', 'SELFIMPROVE_VAL_REPS', 2);
  const concurrency = numFlag(argv, 'concurrency', 'SELFIMPROVE_CONCURRENCY', run3 ? 24 : 6);
  const deadlineMinutes = numFlag(argv, 'deadline-minutes', 'SELFIMPROVE_DEADLINE_MINUTES', run3 ? 25 : Infinity);
  const noCache = argv.includes('--no-cache');
  const startDir = flag(argv, 'from') ?? ARTIFACTS_DIR;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = flag(argv, 'out') ?? join(RUNS_DIR, `${design}-${stamp}`);
  const cfgEp: EpisodeConfig = DEFAULT_EPISODE;
  const advisorModelArg = flag(argv, 'advisor-model') ?? (run3 ? RUN3_ADVISOR_MODEL : undefined);
  if (run3) {
    // Guard the pre-registered design against accidental deviations.
    if (rounds > RUN3_MAX_ROUNDS) throw new Error(`run3 allows at most ${RUN3_MAX_ROUNDS} rounds`);
    if (nVariants > RUN3_MAX_VARIANTS) throw new Error(`run3 allows at most ${RUN3_MAX_VARIANTS} variants`);
    if (trainReps !== 1 || valReps !== 2) throw new Error('run3 fixes train reps 1 and validation reps 2');
    if (!Number.isFinite(deadlineMinutes) || deadlineMinutes > 25) throw new Error('run3 requires a deadline of at most 25 minutes');
  }

  const { train, valA, valB } = loopSplit(design);

  const live = createLive({ noCache, advisorModel: advisorModelArg });
  if (run3 && live.advisorModel !== RUN3_ADVISOR_MODEL) throw new Error(`run3 advisor model is pre-registered as ${RUN3_ADVISOR_MODEL}, got ${live.advisorModel}`);
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
  let k = 0;
  const deps: LoopDepsRun2 = {
    async runTrain(b) {
      const res = await evaluateEpisodes(live.advisor(b, `train-${k++}`), train, trainReps, cfgEp, { concurrency });
      return { scores: res.map((r) => r.episode.score), transcripts: formatTranscripts(toTranscriptEpisodes(res)) };
    },
    runValA: (b) => evaluate(live.advisor(b, `valA-${bundleHash(b)}`), valA, valReps, cfgEp, { concurrency }),
    runValB: (b) => evaluate(live.advisor(b, `valB-${bundleHash(b)}`), valB, valReps, cfgEp, { concurrency }),
    review: (b, transcripts) => review({ gateway: live.gateway, model: live.cfg.strongModel, bundle: b, transcripts }),
    rewrite: (current, diagnosis, history) => rewrite({ gateway: live.gateway, model: live.cfg.strongModel, current, diagnosis, history, n: nVariants }),
    stats: () => live.gateway.snapshot(),
    log,
  };

  log(`${design} dir ${outDir}; advisor=${live.advisorModel} rounds=${rounds} variants=${nVariants} train=${train.length}x${trainReps} valA=${valA.length}x${valReps} valB=${valB.length}x${valReps} concurrency=${concurrency} gate A>=${RUN2_STAGE_A_MARGIN} B>=${RUN2_STAGE_B_MARGIN} deadline=${deadlineMinutes} min`);
  const learnerValA = mean(await evaluate(baselinePolicy, valA, valReps, cfgEp));
  const learnerValB = mean(await evaluate(baselinePolicy, valB, valReps, cfgEp));
  log(`reference: deterministic learner valA ${pct(learnerValA)}, valB ${pct(learnerValB)}`);
  const settings = { rounds, nVariants, trainPersonas: train.length, trainReps, valAPersonas: valA.length, valBPersonas: valB.length, valReps, concurrency, deadlineMinutes, personaSeed: run3 ? RUN3_PERSONA_SEED : 7001, startDir, advisorModel: live.advisorModel, fastModel: live.cfg.fastModel, strongModel: live.cfg.strongModel };
  const result = await runLoopRun2({
    gen0: readBundle(startDir), deps, rounds, outDir, deadlineMinutes, design,
    meta: { advisorModel: live.advisorModel, reviewerModel: live.cfg.strongModel, rewriterModel: live.cfg.strongModel, settings, learnerValA, learnerValB },
    summaryExtra: () => ({ learnerValA, learnerValB, settings, llm: live.gateway.snapshot(), processWallSeconds: Math.round((Date.now() - t0) / 1000) }),
  });
  log(`done: final gen${result.finalGen} (${result.roundsCompleted} complete rounds${result.cutoff ? `, cut off before ${result.cutoff.before} of round ${result.cutoff.round}` : ''}); valA learner ${pct(learnerValA)}, gen0 ${result.gen0ValA === null ? 'n/a' : pct(result.gen0ValA)}, final ${result.finalValA === null ? 'n/a' : pct(result.finalValA)}`);
  for (const [role, s] of Object.entries(live.gateway.snapshot())) log(`llm ${role}: ${s.calls} calls (+${s.cacheHits} cache hits, ${s.errors} errors), ${s.promptTokens}+${s.completionTokens} tokens`);
  log(`next (lead only, once): npx tsx --env-file-if-exists=.env tools/selfimprove/final.ts --test-set ${design} --run ${outDir}${run3 ? ' --concurrency 24' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e)); process.exit(1); });
}
