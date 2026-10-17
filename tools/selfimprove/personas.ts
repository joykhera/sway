// Simulated listeners with HIDDEN taste, used as the scoring environment. Frozen: the Rewriter may never edit this file.
// Difficulty comes from four things a purely additive learner cannot capture on its own:
//  1. pair effects (a style can be loved with one instrument and disliked with another),
//  2. pickiness (each listener has a different bar for a thumbs-up),
//  3. fatigue (hearing nearly the same thing repeatedly wears on them),
//  4. vote noise.
import { createRng, pick } from '../../src/learner/rng.ts';
import { FEATURE_GROUPS, FEATURE_IDS, GROUP_IDS, type FeatureGroup, type FeatureId } from '../../src/learner/vocabulary.ts';
import type { FeatureBlend } from '../../src/shared/protocol.ts';

export type Pair = { a: FeatureId; b: FeatureId; delta: number };

export type Persona = {
  id: string;
  weights: Record<FeatureId, number>; // -1 (hates) .. +1 (loves); hidden from every agent
  pairs: Pair[]; // extra appeal (+) or distaste (-) when both features play together
  pickiness: number; // affinity needed before a thumbs-up
  fatigue: number; // appeal lost per consecutive near-identical target
  noise: number; // vote randomness
};

const pickFrom = (group: FeatureGroup, rng: ReturnType<typeof createRng>) => pick(FEATURE_GROUPS[group] as readonly FeatureId[], rng);

export function generatePersonas(count: number, seed: number): Persona[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, i) => {
    const weights = Object.fromEntries(FEATURE_IDS.map((id) => [id, (rng.next() * 2 - 1) * 0.35])) as Record<FeatureId, number>;
    for (const group of GROUP_IDS) {
      if (rng.next() < 0.6) weights[pickFrom(group, rng)] = 0.5 + rng.next() * 0.4;
      if (rng.next() < 0.6) weights[pickFrom(group, rng)] = -(0.5 + rng.next() * 0.4);
    }
    const pairs: Pair[] = Array.from({ length: 3 }, () => {
      const [ga, gb] = [pick(GROUP_IDS, rng), pick(GROUP_IDS, rng)];
      return { a: pickFrom(ga, rng), b: pickFrom(gb === ga ? 'mood' : gb, rng), delta: (rng.next() < 0.5 ? -1 : 1) * (0.7 + rng.next() * 0.6) };
    });
    return {
      id: `p${seed}-${i}`,
      weights,
      pairs,
      pickiness: 0.1 + rng.next() * 0.3,
      fatigue: 0.03 + rng.next() * 0.05,
      noise: 0.3 + rng.next() * 0.4,
    };
  });
}

// Intensity-weighted mean of weights over what is playing, plus pair effects (scaled by the weaker of the two).
export function affinity(p: Persona, features: FeatureBlend): number {
  let num = 0;
  let den = 0;
  for (const id of FEATURE_IDS) {
    const x = features[id] ?? 0;
    num += (p.weights[id] ?? 0) * x;
    den += x;
  }
  for (const { a, b, delta } of p.pairs) num += delta * Math.min(features[a] ?? 0, features[b] ?? 0);
  return den > 0 ? num / den : 0;
}

const SAME_SOUND = 0.03; // mean absolute per-feature change below this counts as "the same thing again"

export interface Listener {
  vote(features: FeatureBlend): 'up' | 'down';
}

// Stateful per session: tracks how long the same sound has been playing.
export function createListener(p: Persona, rng: { next(): number }): Listener {
  let previous: FeatureBlend | undefined;
  let streak = 0;
  return {
    vote(features) {
      if (previous) {
        const diff = FEATURE_IDS.reduce((s, id) => s + Math.abs((features[id] ?? 0) - (previous![id] ?? 0)), 0) / FEATURE_IDS.length;
        streak = diff < SAME_SOUND ? streak + 1 : 0;
      }
      previous = features;
      const appeal = affinity(p, features) - p.pickiness - Math.min(0.5, p.fatigue * streak) + (rng.next() * 2 - 1) * p.noise;
      return appeal > 0 ? 'up' : 'down';
    },
  };
}

export type PersonaSplit = { train: Persona[]; val: Persona[]; test: Persona[] };

// The sealed test set is only touched by the final before/after evaluation.
export function splitPersonas(seed = 2026, sizes = { train: 24, val: 12, test: 24 }): PersonaSplit {
  const all = generatePersonas(sizes.train + sizes.val + sizes.test, seed);
  return {
    train: all.slice(0, sizes.train),
    val: all.slice(sizes.train, sizes.train + sizes.val),
    test: all.slice(sizes.train + sizes.val),
  };
}

export type PersonaSplitRun2 = { train: Persona[]; valA: Persona[]; valB: Persona[]; test: Persona[] };

// Run 2 (see PREREGISTRATION.md): fresh listeners from a new seed, disjoint from run 1 (ids embed the seed).
// valA gates candidates, valB replicates the single best stage-A winner, test is sealed (final.ts --test-set run2 only).
export function splitPersonasRun2(seed = 7001, sizes = { train: 12, valA: 40, valB: 40, test: 40 }): PersonaSplitRun2 {
  const all = generatePersonas(sizes.train + sizes.valA + sizes.valB + sizes.test, seed);
  let i = 0;
  const take = (n: number) => all.slice(i, (i += n));
  return { train: take(sizes.train), valA: take(sizes.valA), valB: take(sizes.valB), test: take(sizes.test) };
}
