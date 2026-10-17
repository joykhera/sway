import { WEIGHT_MAX, WEIGHT_MIN, type FeatureBlend, type WeightedPrompt } from '../shared/protocol.ts';

export function lerpBlend(from: FeatureBlend, to: FeatureBlend, t: number): FeatureBlend {
  const out: FeatureBlend = {};
  for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const v = (from[id] ?? 0) + ((to[id] ?? 0) - (from[id] ?? 0)) * t;
    if (v > 0) out[id] = v;
  }
  return out;
}

// Interpolates by prompt text. A prompt absent on one side counts as weight 0 there.
// Results below WEIGHT_MIN are dropped (the relay forbids 0 and would clamp small values up,
// which would stall a fade-out), and the set is never empty.
export function lerpPrompts(from: WeightedPrompt[], to: WeightedPrompt[], t: number): WeightedPrompt[] {
  if (t >= 1) return to.map((p) => ({ ...p }));
  const a = new Map(from.map((p) => [p.text, p.weight]));
  const b = new Map(to.map((p) => [p.text, p.weight]));
  const out: WeightedPrompt[] = [];
  for (const text of new Set([...a.keys(), ...b.keys()])) {
    const w0 = a.get(text) ?? 0;
    const w1 = b.get(text) ?? 0;
    const weight = Math.min(WEIGHT_MAX, w0 + (w1 - w0) * t);
    if (weight >= WEIGHT_MIN) out.push({ text, weight });
  }
  return out.length > 0 ? out : from.map((p) => ({ ...p }));
}
