// Deterministic keep-or-revert rule. Not an LLM, and not editable by the Rewriter.
import { bootstrapCi, pairedDiff } from './stats.ts';

export type Decision = { accept: boolean; meanDiff: number; lo: number; hi: number; reason: string };

// Keep a change only if it beats the incumbent by at least `margin` AND the paired CI excludes zero.
export function decide(candidate: number[], incumbent: number[], margin = 0.02): Decision {
  if (candidate.length !== incumbent.length) throw new Error('scores must be paired (same personas and seeds)');
  const ci = bootstrapCi(pairedDiff(candidate, incumbent));
  const accept = ci.mean >= margin && ci.lo > 0;
  const reason = accept ? 'improved' : ci.mean < margin ? `gain below margin ${margin}` : 'CI includes zero';
  return { accept, meanDiff: ci.mean, lo: ci.lo, hi: ci.hi, reason };
}
