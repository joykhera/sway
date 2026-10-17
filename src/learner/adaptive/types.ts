import type { FeatureId } from '../vocabulary';
import type { FeatureBlend, Target as BaseTarget } from '../types';

export type Purpose = 'focus' | 'relax' | 'energy' | 'explore';
export type LearnerState = {
  scores: Record<FeatureId, number>;
  votes: number;
  seed: number;
  purpose: Purpose;
  A: number[][];
  b: number[];
  evidence: number;
  positiveEvidence: number;
  negativeEvidence: number;
  lastVote: 'up' | 'down' | null;
  recentRejections: number;
  unexpectedDislikes: Array<{ x: number[]; weight: number }>;
  recoveryArmed: boolean;
  recoveries: number;
  lastRecoveryVote: number | null;
};
export type Decision = {
  kind: 'initial' | 'hold' | 'redirect' | 'variation' | 'probe';
  reason: string;
  phase: string;
  step: number;
  prediction: number;
  uncertainty: number;
};
export type Target = BaseTarget & { lastDecision?: Decision };
export type { FeatureBlend, FeatureId };
