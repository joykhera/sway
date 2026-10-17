// Reference lines (not agents): a random floor and an oracle ceiling that cheats by reading hidden taste.
import { createRng } from '../../src/learner/rng.ts';
import * as learner from '../../src/learner/index.ts';
import { affinity, createListener, type Persona } from './personas.ts';
import { DEFAULT_EPISODE, type Policy } from './simulator.ts';

// Chance reference: a fresh random combination on every vote.
export const randomPolicy: Policy = {
  name: 'random',
  start(seed) {
    let n = seed * 7919;
    let target = learner.initialTarget(learner.createLearner(n));
    return { target: () => target, vote: () => { target = learner.initialTarget(learner.createLearner(++n)); } };
  },
};

// Ceiling reference. It KNOWS each listener's hidden taste, so no agent can reach it; it shows the headroom.
const POOL = Array.from({ length: 400 }, (_, i) => learner.initialTarget(learner.createLearner(i + 1)));
export function oracleScores(personas: Persona[], reps = 3): number[] {
  const { votes, warmup } = DEFAULT_EPISODE;
  return personas.flatMap((p, pi) => {
    const best = [...POOL].sort((a, b) => affinity(p, b.features) - affinity(p, a.features)).slice(0, 6);
    return Array.from({ length: reps }, (_, r) => {
      const listener = createListener(p, createRng(1000 * (pi + 1) + r));
      const after = Array.from({ length: votes }, (_, i) => listener.vote(best[i % best.length]!.features)).slice(warmup);
      return after.filter((v) => v === 'up').length / after.length;
    });
  });
}
