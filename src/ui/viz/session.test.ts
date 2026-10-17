import { describe, expect, it } from 'vitest';
import { describeBlend, normalizeTaste, topTaste } from './describe.ts';
import { MAX_MOMENTS, SessionRecorder } from './session-log.ts';

const target = { features: { jazz: 1 }, prompts: [{ text: 'jazz', weight: 1 }] };

describe('describe', () => {
  it('names the strongest feature in each group, in group order', () => {
    expect(describeBlend({ calm: 0.3, jazz: 0.45, lofi: 0.2, piano: 0.4 })).toBe('jazz · piano · calm');
    expect(describeBlend({})).toBe('');
  });

  it('keeps an absolute scale so repeat likes still show, compressing only beyond ±1', () => {
    expect(normalizeTaste({ jazz: 0.52, piano: -0.3 })).toEqual({ jazz: 0.52, piano: -0.3 });
    expect(normalizeTaste({ jazz: 0.73, piano: -0.3 }).jazz).toBeGreaterThan(normalizeTaste({ jazz: 0.52, piano: -0.3 }).jazz!);
    expect(normalizeTaste({ jazz: 2, piano: -1 })).toEqual({ jazz: 1, piano: -0.5 });
  });

  it('picks the best-liked feature per group and skips groups with nothing liked', () => {
    expect(topTaste({ jazz: 0.5, ambient: 0.2, piano: -0.3, calm: 0.4 })).toEqual(['jazz', 'calm']);
  });
});

describe('SessionRecorder', () => {
  it('records liked moments against session time', () => {
    const r = new SessionRecorder();
    r.start(0);
    expect(r.moment(2000, { label: 'jazz', color: [1, 1, 1], target })).toEqual([{ t: 2, label: 'jazz', color: [1, 1, 1], target }]);
    r.finish();
    expect(r.active).toBe(false);
    expect(r.moment(3000, { label: 'jazz', color: [1, 1, 1], target })).toEqual([]);
  });

  it('keeps one entry for repeated likes of the same sound, and caps the list', () => {
    const r = new SessionRecorder();
    r.start(0);
    r.moment(1000, { label: 'jazz', color: [1, 1, 1], target });
    expect(r.moment(2000, { label: 'jazz', color: [1, 1, 1], target })).toHaveLength(1);
    let list = r.moment(3000, { label: 'ambient', color: [1, 1, 1], target });
    for (let i = 0; i < 20; i++) list = r.moment(4000 + i, { label: `x${i}`, color: [1, 1, 1], target });
    expect(list).toHaveLength(MAX_MOMENTS);
  });
});
