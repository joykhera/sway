// Runs one simulated listening session. Frozen scorer: the Rewriter may never edit this file.
import { createRng } from '../../src/learner/rng.ts';
import * as learner from '../../src/learner/index.ts';
import type { Target, Vote } from '../../src/shared/protocol.ts';
import { affinity, createListener, type Persona } from './personas.ts';

// A policy decides what plays next. Gen 0 is C's deterministic learner; later generations add the LLM advisor.
// vote() may be async (LLM-backed policies); the simulator awaits it before asking for the next target.
export interface PolicyRun {
  target(): Target;
  vote(v: Vote): void | Promise<void>;
  // Optional per-step notes (which agent chose each target). Never contains listener taste.
  trace?(): unknown[];
}
export interface Policy {
  name: string;
  start(seed: number): PolicyRun;
}

export const baselinePolicy: Policy = {
  name: 'deterministic-learner',
  start(seed) {
    let state = learner.createLearner(seed);
    let target = learner.initialTarget(state);
    return {
      target: () => target,
      vote(v) {
        // The simulated listener hears the current target immediately (no buffer or ramp delay).
        const r = learner.processVote({ state, audible: target.features, currentTarget: target, vote: v });
        state = r.state;
        target = r.target;
      },
    };
  },
};

export type EpisodeConfig = { votes: number; warmup: number };
export const DEFAULT_EPISODE: EpisodeConfig = { votes: 30, warmup: 5 };

export type Episode = { votes: Vote[]; affinities: number[]; score: number; trace?: unknown[] };

// Score = share of 👍 after the first few warmup votes (how well the music fits once it has had a chance to learn).
export async function runEpisode(policy: Policy, persona: Persona, seed: number, cfg: EpisodeConfig = DEFAULT_EPISODE): Promise<Episode> {
  const rng = createRng(seed ^ 0x9e3779b9);
  const run = policy.start(seed);
  const listener = createListener(persona, rng);
  const votes: Vote[] = [];
  const affinities: number[] = [];
  for (let i = 0; i < cfg.votes; i++) {
    const features = run.target().features;
    const v = listener.vote(features);
    votes.push(v);
    affinities.push(affinity(persona, features));
    await run.vote(v);
  }
  const scored = votes.slice(cfg.warmup);
  const episode: Episode = { votes, affinities, score: scored.filter((v) => v === 'up').length / scored.length };
  if (run.trace) episode.trace = run.trace();
  return episode;
}

// Ordered map with at most `limit` tasks in flight. Results keep input order regardless of completion order.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export type EvalOptions = { concurrency?: number };
export type EpisodeResult = { personaIndex: number; rep: number; seed: number; episode: Episode };

// One episode per (persona, repetition), in a fixed order so two policies can be compared pairwise.
export async function evaluateEpisodes(
  policy: Policy,
  personas: Persona[],
  reps = 3,
  cfg: EpisodeConfig = DEFAULT_EPISODE,
  opts: EvalOptions = {},
): Promise<EpisodeResult[]> {
  const jobs = personas.flatMap((p, i) => Array.from({ length: reps }, (_, r) => ({ p, i, r, seed: 1000 * (i + 1) + r })));
  return mapLimit(jobs, opts.concurrency ?? 6, async ({ p, i, r, seed }) => ({
    personaIndex: i,
    rep: r,
    seed,
    episode: await runEpisode(policy, p, seed, cfg),
  }));
}

export async function evaluate(
  policy: Policy,
  personas: Persona[],
  reps = 3,
  cfg: EpisodeConfig = DEFAULT_EPISODE,
  opts: EvalOptions = {},
): Promise<number[]> {
  return (await evaluateEpisodes(policy, personas, reps, cfg, opts)).map((e) => e.episode.score);
}
