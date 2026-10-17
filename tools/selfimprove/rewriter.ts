// Rewriter (strong model): turns the diagnosis and the history of past attempts into N candidate bundles.
// Output is validated strictly; malformed variants are rejected (with a reason), params are clamped to the whitelist.
import type { Bundle } from './advisor.ts';
import { parseModelJson, type LlmGateway } from './llm.ts';
import { describeParams, sanitizeParams } from './params.ts';

export const MAX_TEXT = 4000;

export type Variant = { name: string; rationale: string; bundle: Bundle; warnings: string[] };
export type Rejected = { index: number; reason: string };

export type HistoryEntry = {
  round: number;
  name: string;
  hash: string;
  rationale: string;
  params: Bundle['params'];
  meanDiff: number;
  lo: number;
  hi: number;
  accept: boolean;
  adopted: boolean;
  reason: string;
};

export function validateVariants(raw: unknown, current: Bundle, max: number): { variants: Variant[]; rejected: Rejected[] } {
  const variants: Variant[] = [];
  const rejected: Rejected[] = [];
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { variants?: unknown }).variants : raw;
  if (!Array.isArray(list)) return { variants, rejected: [{ index: -1, reason: 'no "variants" array' }] };
  list.forEach((v, index) => {
    if (variants.length >= max) return;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return rejected.push({ index, reason: 'variant is not an object' });
    const o = v as Record<string, unknown>;
    const prompt = o.advisor_prompt;
    const playbook = o.playbook;
    if (typeof prompt !== 'string' || prompt.trim().length < 20) return rejected.push({ index, reason: 'advisor_prompt missing or too short' });
    if (prompt.length > MAX_TEXT) return rejected.push({ index, reason: `advisor_prompt longer than ${MAX_TEXT} chars` });
    if (typeof playbook !== 'string') return rejected.push({ index, reason: 'playbook missing' });
    if (playbook.length > MAX_TEXT) return rejected.push({ index, reason: `playbook longer than ${MAX_TEXT} chars` });
    if (o.params !== undefined && (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params))) {
      return rejected.push({ index, reason: 'params is not an object' });
    }
    const { params, warnings } = sanitizeParams(o.params ?? {}, current.params);
    const bundle: Bundle = { advisorPrompt: prompt.trim() + '\n', playbook: playbook.trim() + '\n', params };
    if (sameBundle(bundle, current)) return rejected.push({ index, reason: 'identical to the incumbent' });
    if (variants.some((x) => sameBundle(x.bundle, bundle))) return rejected.push({ index, reason: 'duplicate of another variant' });
    variants.push({
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : `variant${index + 1}`,
      rationale: typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 600) : '',
      bundle,
      warnings,
    });
  });
  return { variants, rejected };
}

const sameBundle = (a: Bundle, b: Bundle) =>
  a.advisorPrompt.trim() === b.advisorPrompt.trim() && a.playbook.trim() === b.playbook.trim() && JSON.stringify(a.params) === JSON.stringify(b.params);

export function formatHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return '(no previous attempts)';
  return history
    .map((h) => `- round ${h.round} "${h.name}" [${h.adopted ? 'ADOPTED' : h.accept ? 'accepted, not best' : 'REJECTED'}] val gain ${(h.meanDiff * 100).toFixed(1)} pts (95% CI ${(h.lo * 100).toFixed(1)}..${(h.hi * 100).toFixed(1)}): ${h.reason}. params=${JSON.stringify(h.params)}. idea: ${h.rationale}`)
    .join('\n');
}

export function buildRewriterMessages(args: { current: Bundle; diagnosis: string; history: HistoryEntry[]; n: number }) {
  const { current, n } = args;
  return [
    {
      role: 'system' as const,
      content:
        'You are the Rewriter on a self-improving music recommendation team. You edit the team\'s own artifacts: the advisor prompt (instructions for a small, fast LLM that proposes feature combinations from vote history), ' +
        'the playbook (lessons learned that are shown to the advisor), and bounded numeric params (how the deterministic chooser weighs advisor candidates and how often the advisor runs). ' +
        'The params include team-structure knobs that decide how advisor candidates are mixed with the learner\'s own proposal: learnerScoreWeight (weight on the learner\'s preference estimate), llmCandidateBonus, noveltyBonus, repeatPenalty (penalize replaying recently played sounds), candidateCount, poolMaxAge (how long advisor candidates stay usable) and deferToLearnerProbability (chance per vote of ignoring the advisor). Their bounds are listed below and enforced in code. ' +
        'A change is kept only if it measurably raises the like-rate on held-out listeners, so propose distinct, testable hypotheses rather than cosmetic rewording. Learn from the attempt history: do not repeat rejected ideas unchanged.',
    },
    {
      role: 'user' as const,
      content: [
        '# Current advisor prompt', current.advisorPrompt, '',
        '# Current playbook', current.playbook, '',
        '# Current params', JSON.stringify(current.params), '',
        '# Tunable params (values outside bounds are clamped; other keys are ignored)', describeParams(), '',
        '# Reviewer diagnosis of the latest train run', args.diagnosis, '',
        '# History of past attempts (validation results)', formatHistory(args.history), '',
        `Return JSON only: {"variants":[{"name":"short-id","rationale":"hypothesis in one or two sentences","advisor_prompt":"full new prompt","playbook":"full new playbook (markdown bullets)","params":{...all params...}}]} with exactly ${n} variants that differ from each other. ` +
          `Keep each text under ${MAX_TEXT} characters. The output format for the advisor's reply is appended automatically, so the prompt need not specify JSON syntax.`,
      ].join('\n'),
    },
  ];
}

export async function rewrite(args: {
  gateway: LlmGateway;
  model: string;
  current: Bundle;
  diagnosis: string;
  history: HistoryEntry[];
  n?: number;
  maxTokens?: number;
}): Promise<{ variants: Variant[]; rejected: Rejected[]; raw: string[] }> {
  const n = args.n ?? 3;
  const messages = buildRewriterMessages({ current: args.current, diagnosis: args.diagnosis, history: args.history, n });
  const raw: string[] = [];
  let rejected: Rejected[] = [];
  // One retry at a different temperature (a different cache key) if the first answer is unusable.
  for (const temperature of [0.7, 0.9]) {
    try {
      const r = await args.gateway.chat({ role: 'rewriter', model: args.model, messages, temperature, maxTokens: args.maxTokens ?? 10000, timeoutMs: 400_000 });
      raw.push(r.text);
      const out = validateVariants(parseModelJson(r.text), args.current, n);
      rejected = rejected.concat(out.rejected);
      if (out.variants.length > 0) return { variants: out.variants, rejected, raw };
    } catch (e) {
      rejected.push({ index: -1, reason: `rewriter output unusable: ${String(e).slice(0, 200)}` });
    }
  }
  return { variants: [], rejected, raw };
}
