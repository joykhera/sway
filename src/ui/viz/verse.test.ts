import { describe, expect, it } from 'vitest';
import { createTasteField, layoutRim, MAX_FIELD_WORDS, packField, pickRimWord, poemWords, steeredPoem } from './verse.ts';

const GAP = Math.PI / 2;
const opts = { gap: GAP, wordSpace: 10, groupSpace: 30 };
const items = [
  { id: 'jazz', group: 'genre', width: 40 },
  { id: 'lofi', group: 'genre', width: 40 },
  { id: 'piano', group: 'instrument', width: 50 },
  { id: 'calm', group: 'mood', width: 40 },
];

describe('layoutRim', () => {
  it('sets the words in order, clockwise from the bottom left, inside the open arc', () => {
    const { places, scale } = layoutRim(items, 200, opts);
    expect(scale).toBe(1);
    expect(places.map((p) => p.id)).toEqual(['jazz', 'lofi', 'piano', 'calm']);
    for (let i = 1; i < places.length; i++) expect(places[i]!.angle).toBeGreaterThan(places[i - 1]!.angle);
    expect(places[0]!.angle).toBeGreaterThan(Math.PI / 2 + GAP / 2);
    expect(places.at(-1)!.angle).toBeLessThan(Math.PI / 2 + Math.PI * 2 - GAP / 2);
  });

  it('justifies the words across the whole arc, with wider breaks between groups', () => {
    const r = 200;
    const { places } = layoutRim(items, r, opts);
    const gapAfter = (i: number) =>
      (places[i + 1]!.angle - places[i]!.angle) * r - (items[i]!.width + items[i + 1]!.width) / 2;
    expect(gapAfter(1)).toBeCloseTo(gapAfter(0) * 3); // groupSpace = 3 × wordSpace
    const first = places[0]!.angle * r - items[0]!.width / 2;
    const last = places.at(-1)!.angle * r + items.at(-1)!.width / 2;
    expect(last - first).toBeCloseTo(r * (Math.PI * 2 - GAP));
  });

  it('shrinks everything when the words outgrow the arc', () => {
    const crowded = items.map((item) => ({ ...item, width: 400 }));
    const { scale } = layoutRim(crowded, 100, opts);
    expect(scale).toBeLessThan(1);
    expect((4 * 400 + 10 + 30 + 30) * scale).toBeCloseTo(100 * (Math.PI * 2 - GAP));
  });

  it('flips words below the middle so they still read left to right', () => {
    const { places } = layoutRim(items, 200, opts);
    expect(places[0]!.flip).toBe(true); // bottom left
    expect(places[2]!.flip).toBe(false); // over the top
  });
});

describe('poemWords', () => {
  it('lists the audible words loudest first, dropping slivers', () => {
    expect(poemWords({ jazz: 0.5, calm: 0.3, piano: 0.15, lofi: 0.05 })).toEqual([
      { id: 'jazz', share: 0.5 },
      { id: 'calm', share: 0.3 },
      { id: 'piano', share: 0.15 },
    ]);
    expect(poemWords({})).toEqual([]);
    expect(poemWords({ a: 1, b: 1, c: 1, d: 1, e: 1 }, 4, 0)).toHaveLength(4);
  });
});

describe('packField', () => {
  it('packs direction (GL space, y up), audible share and taste per word', () => {
    const field = createTasteField();
    field.words = [{ angle: -Math.PI / 2, audible: 0.4, taste: -0.5 }]; // straight up on the canvas
    const out = new Float32Array(MAX_FIELD_WORDS * 4);
    expect(packField(field, out)).toBe(1);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0.4);
    expect(out[3]).toBeCloseTo(-0.5);
  });
});

describe('pickRimWord', () => {
  // Three words spread over the top of a ring of radius 100 centred at (0, 0).
  const places = [
    { id: 'jazz', angle: Math.PI, flip: false },
    { id: 'piano', angle: (3 * Math.PI) / 2, flip: false },
    { id: 'calm', angle: 0, flip: false },
  ];
  const ring = { x: 0, y: 0, r: 100 };
  const at = (angle: number, r = 100) => [Math.cos(angle) * r, Math.sin(angle) * r] as const;

  it('picks the nearest word by angle anywhere in the band', () => {
    expect(pickRimWord(places, ring, ...at((3 * Math.PI) / 2 + 0.3, 120), 30)).toBe('piano');
    expect(pickRimWord(places, ring, ...at(Math.PI - 0.2, 85), 30)).toBe('jazz');
  });

  it('ignores the centre and the far outside', () => {
    expect(pickRimWord(places, ring, 0, 0, 30)).toBeNull();
    expect(pickRimWord(places, ring, ...at(Math.PI, 200), 30)).toBeNull();
  });

  it('leaves the opening at the bottom empty', () => {
    expect(pickRimWord(places, ring, ...at(Math.PI / 2), 30)).toBeNull();
  });
});

describe('steeredPoem', () => {
  const audible = { jazz: 0.45, piano: 0.4, calm: 0.3 };
  const to = { electronic: 0.45, piano: 0.4, calm: 0.3 };

  it('is the plain poem when nothing is on its way', () => {
    expect(steeredPoem(audible, null)).toEqual({ lines: poemWords(audible), ink: new Map() });
    // Arrived: the destination, fully inked, while the audible estimate catches up.
    const arrived = steeredPoem(audible, { progress: 1, to });
    expect(arrived.ink.size).toBe(0);
    expect(arrived.lines.map((l) => l.id)).toEqual(poemWords(to).map((l) => l.id));
  });

  it('adds arriving words as ghosts inked to the progress, and lets leaving words fade', () => {
    const { lines, ink } = steeredPoem(audible, { progress: 0.4, to });
    expect(lines.map((l) => l.id)).toContain('electronic');
    expect(ink.get('electronic')).toBeCloseTo(0.4);
    expect(ink.get('jazz')).toBeCloseTo(1 - 0.7 * 0.4);
    expect(ink.has('piano')).toBe(false); // staying words keep their ink
  });

  it('eases staying words toward their new share', () => {
    const half = steeredPoem({ jazz: 0.5, piano: 0.5 }, { progress: 0.5, to: { jazz: 0.2, piano: 0.8 } });
    expect(half.lines.find((l) => l.id === 'piano')!.share).toBeCloseTo(0.65);
  });
});
