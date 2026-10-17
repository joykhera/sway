// Whitelisted, bounded team parameters. The Rewriter may change these values but never the keys or the bounds.
import { readFileSync } from 'node:fs';

type Spec = { min: number; max: number; int?: boolean; default: number; doc: string };

export const PARAM_SPEC = {
  advisorStartVote: { min: 1, max: 15, int: true, default: 3, doc: 'first vote after which the advisor may be consulted' },
  advisorEveryNVotes: { min: 1, max: 10, int: true, default: 3, doc: 'consult the advisor every N votes (team structure: how often the LLM is in the loop)' },
  historyWindow: { min: 3, max: 30, int: true, default: 12, doc: 'how many recent votes the advisor sees' },
  candidateCount: { min: 1, max: 5, int: true, default: 3, doc: 'candidates requested from the advisor per call' },
  llmCandidateBonus: { min: -0.5, max: 0.5, default: 0.05, doc: 'score bonus for advisor candidates in the deterministic chooser (negative = trust the learner more)' },
  noveltyBonus: { min: 0, max: 0.5, default: 0, doc: 'score bonus for options that sound clearly different from what is playing now' },
  temperature: { min: 0, max: 1, default: 0.4, doc: 'advisor sampling temperature' },
  // Run 3 (PREREGISTRATION_RUN3.md): team-structure knobs for how advisor candidates are mixed with the learner's own
  // proposal. Defaults reproduce the run-1/run-2 chooser exactly (asserted in run3.test.ts).
  learnerScoreWeight: { min: 0, max: 3, default: 1, doc: "team structure: weight on the learner's own preference estimate when scoring every option (0 = ignore the learner's scores; ties then go to the learner)" },
  repeatPenalty: { min: 0, max: 0.5, default: 0, doc: 'team structure: penalty times the share of the last historyWindow played sounds that match an option (discourages replaying the same sound)' },
  deferToLearnerProbability: { min: 0, max: 1, default: 0, doc: "team structure: per vote, probability of ignoring advisor candidates and playing the learner's own proposal (seeded, reproducible)" },
  poolMaxAge: { min: 1, max: 30, int: true, default: 30, doc: 'team structure: advisor candidates expire this many votes after they were proposed (30 = never within an episode)' },
} as const satisfies Record<string, Spec>;

export type ParamName = keyof typeof PARAM_SPEC;
export type TeamParams = Record<ParamName, number>;
export const PARAM_NAMES = Object.keys(PARAM_SPEC) as ParamName[];
export const DEFAULT_PARAMS: TeamParams = Object.fromEntries(PARAM_NAMES.map((k) => [k, PARAM_SPEC[k].default])) as TeamParams;

// Unknown keys are dropped, non-numbers fall back to `base`, out-of-range values are clamped. Every adjustment is reported.
export function sanitizeParams(raw: unknown, base: TeamParams = DEFAULT_PARAMS): { params: TeamParams; warnings: string[] } {
  const warnings: string[] = [];
  const params = { ...base };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { params, warnings: ['params is not an object; kept previous values'] };
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in PARAM_SPEC)) { warnings.push(`unknown param ${k} dropped`); continue; }
    const spec: Spec = PARAM_SPEC[k as ParamName];
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) { warnings.push(`${k}=${JSON.stringify(v)} is not a number; kept ${params[k as ParamName]}`); continue; }
    let x = spec.int ? Math.round(n) : n;
    if (x < spec.min || x > spec.max) {
      const c = Math.min(spec.max, Math.max(spec.min, x));
      warnings.push(`${k}=${x} out of [${spec.min}, ${spec.max}]; clamped to ${c}`);
      x = c;
    }
    params[k as ParamName] = x;
  }
  return { params, warnings };
}

export function loadParams(path: string): TeamParams {
  return sanitizeParams(JSON.parse(readFileSync(path, 'utf8'))).params;
}

export function describeParams(): string {
  return PARAM_NAMES.map((k) => {
    const s: Spec = PARAM_SPEC[k];
    return `- ${k} (${s.int ? 'integer' : 'number'} in [${s.min}, ${s.max}], default ${s.default}): ${s.doc}`;
  }).join('\n');
}
