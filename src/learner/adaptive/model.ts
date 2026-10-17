import { FEATURE_IDS } from '../vocabulary';
import { sanitizeFeatures } from '../targets';
import type { FeatureBlend } from './types';

export const dot = (a: number[], b: number[]) => a.reduce((total, value, i) => total + value * b[i]!, 0);

/** Normalize the complete heard mixture BEFORE target projection. */
export function vector(features: FeatureBlend): number[] {
  const clean = sanitizeFeatures(features);
  const values = FEATURE_IDS.map((id) => clean[id] ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((value) => total > 0 ? value / total : 0);
}

/** Cholesky decomposition of the positive-definite regularized information matrix. */
export function factor(A: number[][]): number[][] {
  const L = A.map((row) => row.map(() => 0));
  for (let i = 0; i < A.length; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let value = A[i]![j]!;
      for (let k = 0; k < j; k += 1) value -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (!(value > 0) || !Number.isFinite(value)) throw new Error('Learner information matrix is not positive definite');
        L[i]![j] = Math.sqrt(value);
      } else {
        L[i]![j] = value / L[j]![j]!;
      }
    }
  }
  return L;
}

function forward(L: number[][], b: number[]): number[] {
  const y = b.map(() => 0);
  for (let i = 0; i < b.length; i += 1) {
    let value = b[i]!;
    for (let j = 0; j < i; j += 1) value -= L[i]![j]! * y[j]!;
    y[i] = value / L[i]![i]!;
  }
  return y;
}

export function solve(L: number[][], b: number[]): number[] {
  const y = forward(L, b);
  const result = b.map(() => 0);
  for (let i = b.length - 1; i >= 0; i -= 1) {
    let value = y[i]!;
    for (let j = i + 1; j < b.length; j += 1) value -= L[j]![i]! * result[j]!;
    result[i] = value / L[i]![i]!;
  }
  return result;
}

/** sqrt(xᵀ A⁻¹ x), computed by triangular solve, never a matrix inverse. */
export function uncertainty(L: number[][], x: number[]): number {
  const y = forward(L, x);
  return Math.sqrt(Math.max(0, dot(y, y)));
}
