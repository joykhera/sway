import type { FeatureId } from '../vocabulary';
import type { FeatureBlend, Target as BaseTarget } from '../types';

export type Purpose = 'focus' | 'relax' | 'energy' | 'explore' | 'crazy';
export type LearnerState = {
  scores: Record<FeatureId, number>;
  votes: number;
  seed: number;
  purpose: Purpose;
  A: number[][];
  b: number[];
  evidence: number;
  positiveEvidence: number;
  /** Discounted share of positive evidence assigned to explicit comparisons. */
  pairwiseEvidence: number;
  negativeEvidence: number;
  lastVote: 'up' | 'down' | null;
  recentRejections: number;
  /** At most three distinct normalized rejected blends since an effective Like. */
  rejectedBlends: number[][];
  unexpectedDislikes: Array<{ x: number[]; weight: number }>;
  recoveryArmed: boolean;
  recoveries: number;
  lastRecoveryVote: number | null;
};
export type Decision = {
  kind: 'initial' | 'hold' | 'redirect' | 'variation' | 'probe';
  styleEscape?: boolean;
  reason: string;
  phase: string;
  step: number;
  prediction: number;
  uncertainty: number;
};
export type Target = BaseTarget & {
  lastDecision?: Decision;
  /** Stable per-session renderer seed, retained when features leave and return. */
  phrasingSalt?: number;
};
export type { FeatureBlend, FeatureId };
