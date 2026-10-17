// The LLM advisor: wraps the deterministic learner. Every few votes the fast Nemotron model proposes candidate feature
// sets from the vote history; a DETERMINISTIC chooser (learner scores + bounded bonuses) picks between them and the
// learner's own target. The LLM never sees hidden listener taste and never picks the final target.
import { INITIAL_INTENSITY } from '../../src/learner/constants.ts';
import * as learner from '../../src/learner/index.ts';
import { createRng } from '../../src/learner/rng.ts';
import { activeIds, signature, toTarget } from '../../src/learner/targets.ts';
import type { FeatureBlend, LearnerState, Target } from '../../src/learner/types.ts';
import { FEATURE_GROUPS, FEATURE_IDS, GROUP_IDS, type FeatureGroup, type FeatureId } from '../../src/learner/vocabulary.ts';
import type { Vote } from '../../src/shared/protocol.ts';
import type { ChatMessage } from './crusoe.ts';
import { parseModelJson, type LlmGateway } from './llm.ts';
import type { TeamParams } from './params.ts';
import { DEFAULT_EPISODE, type Policy } from './simulator.ts';

export type Bundle = { advisorPrompt: string; playbook: string; params: TeamParams };

export type Step = {
  t: number; // 1-based vote index
  ids: FeatureId[]; // what was playing when the listener voted
  src: 'learner' | 'llm'; // who chose it
  vote: Vote;
  call?: 'ok' | 'empty' | 'fail'; // advisor consulted after this vote
  valid?: number; // valid candidates returned by that call
  err?: string; // why a call failed (model/parse error text only)
};

const GROUP_OF = Object.fromEntries(GROUP_IDS.flatMap((g) => FEATURE_GROUPS[g].map((id) => [id, g]))) as Record<FeatureId, FeatureGroup>;
const GROUP_LIMIT: Record<FeatureGroup, number> = { genre: 2, instrument: 2, mood: 1, texture: 1 };

// Turn raw model output into valid Targets: unknown ids dropped, per-group caps, missing groups filled from the
// learner's target (fallback), canonicalized by the learner's own toTarget. Duplicates by sound signature removed.
export function validateCandidates(raw: unknown, fallback: FeatureBlend, max: number): Target[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { candidates?: unknown }).candidates : undefined;
  if (!Array.isArray(list)) return [];
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const ids = Array.isArray(c) ? c : c && typeof c === 'object' ? (c as { features?: unknown }).features : undefined;
    if (!Array.isArray(ids)) continue;
    const counts: Record<FeatureGroup, number> = { genre: 0, instrument: 0, mood: 0, texture: 0 };
    const blend: FeatureBlend = {};
    for (const x of ids) {
      if (typeof x !== 'string') continue;
      const id = x.trim().toLowerCase() as FeatureId;
      if (!FEATURE_IDS.includes(id) || blend[id] !== undefined) continue;
      const g = GROUP_OF[id];
      if (counts[g] >= GROUP_LIMIT[g]) continue;
      counts[g]++;
      blend[id] = INITIAL_INTENSITY[g];
    }
    if (Object.keys(blend).length === 0) continue;
    const target = toTarget(blend, fallback);
    const sig = signature(target.features);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(target);
    if (out.length >= max) break;
  }
  return out;
}

// Deterministic value of an option: the learner's own preference estimate (intensity-weighted mean score).
export function learnerUtility(state: LearnerState, features: FeatureBlend): number {
  let w = 0;
  let total = 0;
  for (const id of activeIds(features)) {
    w += state.scores[id] * features[id]!;
    total += features[id]!;
  }
  return total > 0 ? w / total : 0;
}

export type Option = { target: Target; src: 'learner' | 'llm' };

export function chooseTarget(args: {
  state: LearnerState;
  proposed: Target;
  pool: Target[];
  current: Target;
  lastVote: Vote;
  params: TeamParams;
  recent?: string[]; // signatures of recently played sounds (for repeatPenalty)
  defer?: boolean; // deferToLearnerProbability fired for this vote: use the learner's own proposal
}): Option {
  const { state, proposed, pool, current, lastVote, params } = args;
  const currentSig = signature(current.features);
  const options: Option[] = [{ target: proposed, src: 'learner' }];
  if (args.defer) return options[0]!;
  const recent = args.recent ?? [];
  // Extra terms are only applied when their knob is off its neutral default, so defaults reproduce the old chooser bit for bit.
  const weightOf = (u: number) => (params.learnerScoreWeight === 1 ? u : params.learnerScoreWeight * u);
  const repeatOf = (sig: string) => (params.repeatPenalty === 0 || recent.length === 0 ? 0 : params.repeatPenalty * (recent.filter((r) => r === sig).length / recent.length));
  for (const t of pool) {
    // After a 👎 never replay what was just rejected.
    if (lastVote === 'down' && signature(t.features) === currentSig) continue;
    options.push({ target: t, src: 'llm' });
  }
  let best = options[0]!;
  let bestScore = -Infinity;
  for (const o of options) {
    const sig = signature(o.target.features);
    const rp = repeatOf(sig);
    let s =
      weightOf(learnerUtility(state, o.target.features)) +
      (o.src === 'llm' ? params.llmCandidateBonus : 0) +
      (sig !== currentSig ? params.noveltyBonus : 0);
    if (rp !== 0) s -= rp;
    if (s > bestScore + 1e-12) { best = o; bestScore = s; } // ties keep the earlier option (the learner)
  }
  return best;
}

const fmt = (ids: FeatureId[]) => GROUP_IDS.map((g) => `${g}=${ids.filter((id) => GROUP_OF[id] === g).join('+') || '-'}`).join(' ');

// The only things the advisor ever sees: its prompt, its playbook, vote history over feature IDs, and the vocabulary.
export function buildAdvisorMessages(bundle: Bundle, history: { ids: FeatureId[]; vote: Vote }[]): ChatMessage[] {
  const p = bundle.params;
  const window = history.slice(-p.historyWindow);
  const offset = history.length - window.length;
  const lines = window.map((h, i) => `${offset + i + 1}. ${fmt(h.ids)} -> ${h.vote === 'up' ? 'LIKED (thumbs up)' : 'DISLIKED (thumbs down)'}`);
  const vocab = GROUP_IDS.map((g) => `${g}: ${FEATURE_GROUPS[g].join(', ')}`).join('\n');
  const system = `${bundle.advisorPrompt.trim()}\n\n## Playbook (lessons learned)\n${bundle.playbook.trim()}`;
  const user = [
    `Listener vote history (oldest first; ${history.length} votes so far):`,
    ...lines,
    '',
    'Allowed feature IDs by group:',
    vocab,
    '',
    `Each candidate: 1-2 genre, 1-2 instrument, exactly 1 mood, exactly 1 texture, using only the IDs above.`,
    `Return exactly ${p.candidateCount} different candidates as JSON only, no prose:`,
    '{"candidates":[{"features":["id","id","id","id"],"why":"short reason"}]}',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export type AdvisorOptions = {
  gateway: LlmGateway;
  model: string;
  bundle: Bundle;
  name?: string;
  timeoutMs?: number;
  maxTokens?: number;
  thinking?: boolean;
  maxVotes?: number; // no point consulting after the last vote
};

export function createAdvisorPolicy(o: AdvisorOptions): Policy {
  const { bundle, gateway } = o;
  const p = bundle.params;
  const maxVotes = o.maxVotes ?? DEFAULT_EPISODE.votes;
  return {
    name: o.name ?? 'advisor',
    start(seed) {
      let state = learner.createLearner(seed);
      let target = learner.initialTarget(state);
      let src: Step['src'] = 'learner';
      let pool: Target[] = [];
      let poolAt = 0; // vote index at which the current pool was proposed
      const played: string[] = []; // signatures of played sounds (repeatPenalty)
      // Separate stream so the default (probability 0, never drawn) leaves every other random draw unchanged.
      const deferRng = createRng((seed ^ 0x5bd1e995) >>> 0);
      const history: { ids: FeatureId[]; vote: Vote }[] = [];
      const steps: Step[] = [];
      return {
        target: () => target,
        trace: () => steps,
        async vote(v) {
          const step: Step = { t: history.length + 1, ids: activeIds(target.features), src, vote: v };
          steps.push(step);
          history.push({ ids: step.ids, vote: v });
          played.push(signature(target.features));
          const r = learner.processVote({ state, audible: target.features, currentTarget: target, vote: v });
          state = r.state;
          const n = history.length;
          if (n >= p.advisorStartVote && n < maxVotes && (n - p.advisorStartVote) % p.advisorEveryNVotes === 0) {
            try {
              const res = await gateway.chat({
                role: 'advisor',
                model: o.model,
                messages: buildAdvisorMessages(bundle, history),
                temperature: p.temperature,
                maxTokens: o.maxTokens ?? 2000,
                thinking: o.thinking ?? false,
                timeoutMs: o.timeoutMs ?? 60_000,
              });
              pool = res.text.trim() ? validateCandidates(parseModelJson(res.text), r.target.features, p.candidateCount) : [];
              step.call = res.text.trim() ? 'ok' : 'empty';
            } catch (e) {
              pool = []; // garbage, timeout, HTTP failure: fall back to the learner
              step.call = 'fail';
              step.err = String(e).slice(0, 120);
            }
            step.valid = pool.length;
            poolAt = n;
          }
          if (pool.length > 0 && n - poolAt >= p.poolMaxAge) pool = []; // expired candidates
          const defer = p.deferToLearnerProbability > 0 && deferRng.next() < p.deferToLearnerProbability;
          const choice = chooseTarget({ state, proposed: r.target, pool, current: target, lastVote: v, params: p, recent: played.slice(-p.historyWindow), defer });
          target = choice.target;
          src = choice.src;
        },
      };
    },
  };
}
