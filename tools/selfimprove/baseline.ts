// pnpm selfimprove:baseline: generation-0 scores on train and validation personas. The sealed test set is NOT scored here.
import { splitPersonas } from './personas.ts';
import { oracleScores, randomPolicy } from './refs.ts';
import { baselinePolicy, evaluate } from './simulator.ts';
import { bootstrapCi } from './stats.ts';

const report = (name: string, split: string, scores: number[]) => {
  const ci = bootstrapCi(scores);
  console.log(`${name.padEnd(22)} ${split.padEnd(5)}: ${(ci.mean * 100).toFixed(1)}% likes after warmup (95% CI ${(ci.lo * 100).toFixed(1)}-${(ci.hi * 100).toFixed(1)})`);
};

const { train, val } = splitPersonas();
for (const [name, set] of [['train', train], ['val', val]] as const) {
  report('random', name, await evaluate(randomPolicy, set));
  report(baselinePolicy.name, name, await evaluate(baselinePolicy, set));
  report('oracle (ceiling)', name, oracleScores(set));
}
