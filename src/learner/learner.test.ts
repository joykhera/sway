import { describe, expect, it } from 'vitest';
import {
  createLearner,
  evolveNoVote,
  initialTarget,
  processVote,
  type FeatureBlend,
  type FeatureId,
  type LearnerState,
  type Target,
} from './index';

const groups: FeatureId[][] = [
  ['ambient', 'lofi', 'jazz', 'electronic', 'classical'],
  ['piano', 'synth', 'guitar', 'strings', 'percussion'],
  ['calm', 'dreamy', 'hopeful', 'melancholic', 'energetic'],
  ['sparse', 'layered', 'rhythmic'],
];
const ids = groups.flat();

function active(blend: FeatureBlend): FeatureId[] {
  return ids.filter((id) => (blend[id] ?? 0) > 0);
}

function groupChoices(blend: FeatureBlend): string[] {
  return groups.map((group) => group.filter((id) => (blend[id] ?? 0) > 0).join(','));
}

function share(blend: FeatureBlend, id: FeatureId): number {
  return (blend[id] ?? 0) / Object.values(blend).reduce((sum, value) => sum + value, 0);
}

function expectValidTarget(target: Target): void {
  const selected = active(target.features);
  expect(Object.keys(target.features).every((id) => ids.includes(id as FeatureId))).toBe(true);
  for (const intensity of Object.values(target.features)) {
    expect(Number.isFinite(intensity)).toBe(true);
    expect(intensity).toBeGreaterThanOrEqual(0.1);
    expect(intensity).toBeLessThanOrEqual(1);
  }
  for (const [index, group] of groups.entries()) {
    const count = selected.filter((id) => group.includes(id)).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(index < 2 ? 2 : 1);
  }
  expect(target.prompts).toHaveLength(selected.length);
  expect(new Set(target.prompts.map(({ text }) => text)).size).toBe(target.prompts.length);
  for (const prompt of target.prompts) {
    expect(prompt.text.trim()).not.toBe('');
    expect(Number.isFinite(prompt.weight)).toBe(true);
    expect(prompt.weight).toBeGreaterThanOrEqual(0.1);
    expect(prompt.weight).toBeLessThanOrEqual(2);
  }
  // This is the C/D intensity contract, independent of snippet wording/order.
  const featureWeights = Object.values(target.features).map((value) => 2 * value).sort((a, b) => a - b);
  const promptWeights = target.prompts.map(({ weight }) => weight).sort((a, b) => a - b);
  expect(promptWeights).toEqual(featureWeights);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function differentTarget(reference: Target): Target {
  for (let seed = 0; seed < 1000; seed += 1) {
    const target = initialTarget(createLearner(seed));
    if (groupChoices(target.features).every((choice, i) => choice !== groupChoices(reference.features)[i])) {
      return target;
    }
  }
  throw new Error('Seeded initialization failed to explore the fixed vocabulary');
}

function mix(first: FeatureBlend, second: FeatureBlend, firstFraction: number): FeatureBlend {
  return Object.fromEntries(ids.map((id) => [id,
    firstFraction * (first[id] ?? 0) + (1 - firstFraction) * (second[id] ?? 0),
  ]));
}

describe('learner initialization and target contract', () => {
  it('starts with exactly the 18 known features, zero evidence, and no votes', () => {
    const state = createLearner(42);
    expect(Object.keys(state.scores).sort()).toEqual([...ids].sort());
    expect(Object.values(state.scores)).toEqual(ids.map(() => 0));
    expect(state.votes).toBe(0);
    expect(createLearner(42)).toEqual(state);
  });

  it('generates reproducible valid initial targets with one choice per group', () => {
    const combinations = new Set<string>();
    for (let seed = 0; seed < 64; seed += 1) {
      const state = createLearner(seed);
      const before = structuredClone(state);
      const target = initialTarget(state);
      expect(initialTarget(state)).toEqual(target);
      expect(state).toEqual(before);
      expectValidTarget(target);
      expect(active(target.features)).toHaveLength(4);
      combinations.add(groupChoices(target.features).join('|'));
    }
    expect(combinations.size).toBeGreaterThan(1);
  });

  it('does not share mutable score maps between independent sessions', () => {
    const first = createLearner(1);
    const second = createLearner(1);
    first.scores.piano = 2;
    expect(second.scores.piano).toBe(0);
  });
});

describe('explicit feedback evidence', () => {
  it.each(['up', 'down'] as const)('applies the exact audible intensity rule for %s', (vote) => {
    const state = createLearner(10);
    const currentTarget = initialTarget(state);
    const audible: FeatureBlend = { piano: 0.8, ambient: 0.25, dreamy: 0.4 };
    const result = processVote({ state, currentTarget, audible, vote });
    const sign = vote === 'up' ? 1 : -1;
    for (const id of ids) {
      expect(result.state.scores[id]).toBeCloseTo(sign * 0.15 * (audible[id] ?? 0), 12);
    }
    expect(result.state.votes).toBe(1);
    expectValidTarget(result.target);
  });

  it('learns from the audible blend even when a different target is pending', () => {
    const state = createLearner(123);
    const audibleTarget = initialTarget(state);
    const pending = differentTarget(audibleTarget);
    const result = processVote({ state, audible: audibleTarget.features, currentTarget: pending, vote: 'up' });
    for (const id of active(audibleTarget.features)) {
      expect(result.state.scores[id]).toBeCloseTo(0.15 * audibleTarget.features[id]!, 12);
    }
    for (const id of active(pending.features)) expect(result.state.scores[id]).toBe(0);
    expect(groupChoices(result.target.features)).toEqual(groupChoices(audibleTarget.features));
    expectValidTarget(result.target);
  });

  it('credits both sides of a mid-transition blend proportionally', () => {
    const state = createLearner(123);
    const origin = initialTarget(state);
    const pending = differentTarget(origin);
    const audible = mix(origin.features, pending.features, 0.7);
    const result = processVote({ state, audible, currentTarget: pending, vote: 'down' });
    for (const id of ids) expect(result.state.scores[id]).toBeCloseTo(-0.15 * (audible[id] ?? 0), 12);
    expectValidTarget(result.target);
  });

  it('sanitizes malformed numerical evidence and ignores unknown feature IDs', () => {
    const state = createLearner(9);
    const audible = {
      ambient: Number.NaN,
      lofi: Number.POSITIVE_INFINITY,
      jazz: Number.NEGATIVE_INFINITY,
      piano: -0.7,
      synth: 3,
      calm: 0.5,
      sparse: 0,
      arbitrary_user_text: 1,
    } as FeatureBlend;
    const result = processVote({ state, audible, currentTarget: initialTarget(state), vote: 'up' });
    for (const id of ids) {
      expect(result.state.scores[id]).toBeCloseTo(id === 'synth' ? 0.15 : id === 'calm' ? 0.075 : 0, 12);
    }
    expect(Object.keys(result.state.scores).sort()).toEqual([...ids].sort());
    expectValidTarget(result.target);
  });

  it.each(['up', 'down'] as const)('counts %s without inventing evidence when audio is unknown', (vote) => {
    const state = createLearner(4);
    state.scores.piano = 0.4;
    const currentTarget = initialTarget(state);
    const result = processVote({ state, audible: {}, currentTarget, vote });
    expect(result.state.scores).toEqual(state.scores);
    expect(result.state.votes).toBe(1);
    expectValidTarget(result.target);
    if (vote === 'up') expect(result.target).toEqual(currentTarget);
  });

  it('bounds positive and negative evidence after hundreds of explicit votes', () => {
    let state = createLearner(5);
    let currentTarget = initialTarget(state);
    for (let index = 0; index < 600; index += 1) {
      const result = processVote({ state, currentTarget, audible: { piano: 1 }, vote: index < 300 ? 'up' : 'down' });
      state = result.state;
      currentTarget = result.target;
      for (const score of Object.values(state.scores)) {
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(-2);
        expect(score).toBeLessThanOrEqual(2);
      }
      expectValidTarget(currentTarget);
      if (index === 299) expect(state.scores.piano).toBe(2);
    }
    expect(state.scores.piano).toBe(-2);
    expect(state.votes).toBe(600);
  });
});

describe('target selection', () => {
  it('upvotes increase the relative influence of the strongest learned audible quality', () => {
    const state = createLearner(33);
    const target = initialTarget(state);
    const favored = active(target.features)[0]!;
    state.scores[favored] = 1;
    const result = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' });
    expect(groupChoices(result.target.features)).toEqual(groupChoices(target.features));
    expect(share(result.target.features, favored)).toBeGreaterThan(share(target.features, favored));
    expect(result.target.features[favored]! - target.features[favored]!).toBeLessThanOrEqual(0.1);
    expectValidTarget(result.target);
  });

  it('repeated likes remain within feature and prompt caps', () => {
    let state = createLearner(7);
    let target = initialTarget(state);
    const style = groupChoices(target.features);
    for (let i = 0; i < 150; i += 1) {
      const result = processVote({ state, audible: target.features, currentTarget: target, vote: 'up' });
      state = result.state;
      target = result.target;
      expect(groupChoices(target.features)).toEqual(style);
      expectValidTarget(target);
    }
  });

  it('downvotes produce distinct local moves and occasional broad exploration', () => {
    let local = 0;
    let broad = 0;
    for (let seed = 0; seed < 128; seed += 1) {
      const state = createLearner(seed);
      const target = initialTarget(state);
      const result = processVote({ state, audible: target.features, currentTarget: target, vote: 'down' });
      const before = groupChoices(target.features);
      const changed = groupChoices(result.target.features).filter((choice, index) => choice !== before[index]).length;
      expect([1, 2, 4]).toContain(changed);
      if (changed === 4) broad += 1;
      else local += 1;
      expectValidTarget(result.target);
    }
    expect(broad).toBeGreaterThan(0);
    expect(local).toBeGreaterThan(broad);
  });

  it('downvotes supersede a pending target rather than returning either old direction', () => {
    const state = createLearner(55);
    const audible = initialTarget(state);
    const pending = differentTarget(audible);
    const result = processVote({ state, audible: audible.features, currentTarget: pending, vote: 'down' });
    expect(groupChoices(result.target.features)).not.toEqual(groupChoices(audible.features));
    expect(groupChoices(result.target.features)).not.toEqual(groupChoices(pending.features));
    expectValidTarget(result.target);
  });

  it('learned preferences influence selection among the same seeded candidates', () => {
    let improved = 0;
    for (let seed = 0; seed < 64; seed += 1) {
      const state = createLearner(seed);
      const target = initialTarget(state);
      const favored = groups[0]!.find((id) => !target.features[id])!;
      const liked = { ...state, scores: { ...state.scores, [favored]: 2 } };
      const disliked = { ...state, scores: { ...state.scores, [favored]: -2 } };
      const first = processVote({ state: liked, audible: target.features, currentTarget: target, vote: 'down' });
      const second = processVote({ state: disliked, audible: target.features, currentTarget: target, vote: 'down' });
      const difference = share(first.target.features, favored) - share(second.target.features, favored);
      expect(difference).toBeGreaterThanOrEqual(0);
      if (difference > 0) improved += 1;
    }
    expect(improved).toBeGreaterThan(0);
  });
});

describe('passive evolution', () => {
  it('varies only weights within the same style without changing any learner state', () => {
    const state = freezeDeep(createLearner(99));
    const originalState = structuredClone(state);
    let target = initialTarget(state);
    const style = groupChoices(target.features);
    let observedChange = false;
    for (let i = 0; i < 100; i += 1) {
      const previous = freezeDeep(target);
      target = evolveNoVote({ state, target: previous });
      expect(groupChoices(target.features)).toEqual(style);
      for (const id of active(previous.features)) {
        expect(Math.abs(target.features[id]! - previous.features[id]!)).toBeLessThanOrEqual(0.1);
      }
      observedChange ||= JSON.stringify(target) !== JSON.stringify(previous);
      expectValidTarget(target);
    }
    expect(observedChange).toBe(true);
    expect(state).toEqual(originalState);
  });

  it('uses canonical input values, not object insertion order or hidden random state', () => {
    const state = createLearner(11);
    const target = initialTarget(state);
    const reordered = {
      features: Object.fromEntries(Object.entries(target.features).reverse()),
      prompts: [...target.prompts].reverse(),
    };
    const expected = evolveNoVote({ state, target });
    expect(evolveNoVote({ state, target })).toEqual(expected);
    expect(evolveNoVote({ state, target: reordered })).toEqual(expected);
  });

  it('does not become trapped in a short repeated-target cycle during passive listening', () => {
    for (const seed of [...Array.from({ length: 32 }, (_, i) => i), 56]) {
      const state = createLearner(seed);
      let target = initialTarget(state);
      const seen = new Set<string>();
      for (let tick = 0; tick < 1000; tick += 1) {
        target = evolveNoVote({ state, target });
        seen.add(JSON.stringify(target.features));
      }
      expect(seen.size).toBeGreaterThan(950);
    }
  });
});

describe('determinism, immutability, and rapid events', () => {
  function runTrace(seed: number) {
    let state = createLearner(seed);
    let target = initialTarget(state);
    const trace: { state: LearnerState; target: Target }[] = [];
    for (let index = 0; index < 30; index += 1) {
      const audible = mix(target.features, initialTarget(createLearner(index)).features, 0.8);
      ({ state, target } = processVote({ state, currentTarget: target, audible,
        vote: index % 3 === 0 ? 'up' : 'down' }));
      target = evolveNoVote({ state, target });
      trace.push({ state, target });
    }
    return trace;
  }

  it('replays a mixed vote/evolution trace exactly with the same seed', () => {
    expect(runTrace(567)).toEqual(runTrace(567));
    expect(runTrace(567)).not.toEqual(runTrace(568));
  });

  it('accepts deeply frozen state, audible features, and pending targets without mutation', () => {
    const state = freezeDeep(createLearner(17));
    const target = freezeDeep(initialTarget(state));
    const audible = freezeDeep({ ...target.features });
    const snapshot = structuredClone({ state, target, audible });
    const first = processVote({ state, audible, currentTarget: target, vote: 'down' });
    expect(processVote({ state, audible, currentTarget: target, vote: 'down' })).toEqual(first);
    evolveNoVote({ state, target });
    expect({ state, target, audible }).toEqual(snapshot);
    expect(first.state).not.toBe(state);
    expect(first.state.scores).not.toBe(state.scores);
  });

  it('applies each rapid vote synchronously and immediately from the newest state', () => {
    let state = createLearner(88);
    let currentTarget = initialTarget(state);
    const audible = { ...currentTarget.features };
    const votes = ['down', 'down', 'up', 'down'] as const;
    for (const [index, vote] of votes.entries()) {
      const result = processVote({ state, audible, currentTarget, vote });
      expect(result).not.toBeInstanceOf(Promise);
      state = result.state;
      currentTarget = result.target;
      expect(state.votes).toBe(index + 1);
      expectValidTarget(currentTarget);
    }
    for (const id of ids) expect(state.scores[id]).toBeCloseTo(-0.3 * (audible[id] ?? 0), 12);
  });
});
