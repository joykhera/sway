import { createRng } from '../../src/learner/rng.ts';

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

// Seeded percentile bootstrap CI of the mean (or of paired differences when given a diff array).
export function bootstrapCi(xs: number[], seed = 1, iters = 2000, alpha = 0.05): { mean: number; lo: number; hi: number } {
  const rng = createRng(seed);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rng.next() * xs.length)]!;
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(xs), lo: means[Math.floor((alpha / 2) * iters)]!, hi: means[Math.ceil((1 - alpha / 2) * iters) - 1]! };
}

export const pairedDiff = (candidate: number[], incumbent: number[]) => candidate.map((c, i) => c - incumbent[i]!);
