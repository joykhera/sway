import { describe, expect, it } from 'vitest';
import { MAX_PROMPTS, WEIGHT_MIN } from '../shared/protocol.ts';
import { lerpBlend, lerpPrompts } from './blend.ts';

describe('lerpPrompts', () => {
  const from = [{ text: 'ambient', weight: 1 }, { text: 'piano', weight: 0.5 }];
  const to = [{ text: 'jazz', weight: 1 }, { text: 'piano', weight: 1 }];

  it('interpolates by text, treating missing as 0', () => {
    const mid = Object.fromEntries(lerpPrompts(from, to, 0.5).map((p) => [p.text, p.weight]));
    expect(mid).toEqual({ ambient: 0.5, jazz: 0.5, piano: 0.75 });
  });
  it('returns the target exactly at t=1', () => {
    expect(lerpPrompts(from, to, 1)).toEqual(to);
  });
  it('never emits weights under the minimum, and drops fading prompts instead of sending ~0', () => {
    const out = lerpPrompts(from, to, 0.95);
    expect(out.find((p) => p.text === 'ambient')).toBeUndefined();
    for (const p of out) expect(p.weight).toBeGreaterThanOrEqual(WEIGHT_MIN);
  });
  it('is never empty', () => {
    expect(lerpPrompts([{ text: 'a', weight: 0.2 }], [{ text: 'b', weight: 0.2 }], 0.5).length).toBeGreaterThan(0);
  });
  it('caps mid-ramp unions at MAX_PROMPTS, keeping the heaviest', () => {
    const big = (prefix: string, base: number) =>
      Array.from({ length: 8 }, (_, i) => ({ text: `${prefix}${i}`, weight: base + i * 0.1 }));
    const out = lerpPrompts(big('a', 0.5), big('b', 0.9), 0.5); // disjoint: 16 candidates
    expect(out.length).toBeLessThanOrEqual(MAX_PROMPTS);
    const weights = out.map((p) => p.weight);
    expect(weights).toEqual([...weights].sort((x, y) => y - x)); // already sorted heaviest-first
  });
});

describe('lerpBlend', () => {
  it('interpolates and drops zero entries', () => {
    expect(lerpBlend({ a: 1 }, { b: 1 }, 0.25)).toEqual({ a: 0.75, b: 0.25 });
    expect(lerpBlend({ a: 1 }, { b: 1 }, 1)).toEqual({ b: 1 });
  });
});
