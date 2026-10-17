import { describe, expect, it } from 'vitest';
import { describeBlend, normalizeTaste, topTaste } from './describe.ts';
import { portraitCaption, ringsOf } from './portrait.ts';
import { MAX_MOMENTS, SessionRecorder, type SessionSample } from './session-log.ts';

const sample = { colorA: [1, 0, 0] as const, colorB: [0, 0, 1] as const, energy: 0.5, label: 'jazz · piano' };
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
  it('records samples, votes and moments against session time', () => {
    const r = new SessionRecorder();
    r.start(0);
    r.sample(1000, sample);
    r.vote(2000, 'up');
    const moments = r.moment(2000, { label: 'jazz', color: [1, 1, 1], target });
    expect(moments).toEqual([{ t: 2, label: 'jazz', color: [1, 1, 1], target }]);
    const log = r.finish(30_000, { jazz: 1 })!;
    expect(log.duration).toBe(30);
    expect(log.votes).toEqual([{ t: 2, v: 'up' }]);
    expect(log.taste).toEqual({ jazz: 1 });
    expect(r.active).toBe(false);
  });

  it('keeps one recall entry for repeated likes of the same sound, and caps the list', () => {
    const r = new SessionRecorder();
    r.start(0);
    r.moment(1000, { label: 'jazz', color: [1, 1, 1], target });
    expect(r.moment(2000, { label: 'jazz', color: [1, 1, 1], target })).toHaveLength(1);
    let list = r.moment(3000, { label: 'ambient', color: [1, 1, 1], target });
    for (let i = 0; i < 20; i++) list = r.moment(4000 + i, { label: `x${i}`, color: [1, 1, 1], target });
    expect(list).toHaveLength(MAX_MOMENTS);
    // The portrait still sees every like.
    r.sample(30_000, sample);
    expect(r.finish(30_000, {})!.moments).toHaveLength(23);
  });

  it('gives no portrait for a session too short to mean anything', () => {
    const r = new SessionRecorder();
    r.start(0);
    r.sample(1000, sample);
    expect(r.finish(5000, {})).toBeNull();
  });
});

describe('portrait', () => {
  it('merges long sessions down to a drawable number of rings', () => {
    const samples: SessionSample[] = Array.from({ length: 1000 }, (_, t) => ({ ...sample, t, energy: t % 2 }));
    const rings = ringsOf(samples, 100);
    expect(rings).toHaveLength(100);
    expect(rings[0]!.energy).toBeCloseTo(0.5);
    expect(ringsOf(samples.slice(0, 50), 100)).toHaveLength(50);
  });

  it('captions with stats and what you leaned toward', () => {
    const caption = portraitCaption({
      startedAt: Date.UTC(2026, 9, 17, 12),
      duration: 23 * 60,
      samples: [{ ...sample, t: 0 }],
      votes: [{ t: 1, v: 'up' }, { t: 2, v: 'down' }, { t: 3, v: 'up' }],
      moments: [],
      taste: { jazz: 0.6, piano: 0.3 },
    }, 'en-US');
    expect(caption.stats).toBe('23 min · 2 likes · 1 dislike');
    expect(caption.leaning).toBe('leaned toward  jazz · piano');
    expect(caption.date).toBe('Oct 17, 2026');
  });

  it('falls back to what was heard when nothing has been learned', () => {
    const caption = portraitCaption({ startedAt: 0, duration: 60, samples: [{ ...sample, t: 0 }], votes: [], moments: [], taste: {} });
    expect(caption.leaning).toBe('wandered through  jazz · piano');
  });
});
