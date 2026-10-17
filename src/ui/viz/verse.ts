// Layout for the taste verse: the 18 feature words set around a circle like
// the lettering on a seal, and the short poem of what's audible now. Pure
// math so it can be tested without a canvas; TasteVerse.tsx does the drawing.

/** Where the words meet the smoke. TasteVerse writes it; the flow piece reads it. */
export type TasteField = {
  /** One entry per feature word, in ring order. */
  words: FieldWord[];
  /** Radius of the lettering in ring space (1 = half the viewport height); 0 = unknown. */
  rim: number;
};

export type FieldWord = {
  /** Canvas angle of the word's centre (radians, clockwise from +x, y down). */
  angle: number;
  /** Share of what's audible now, 0..1. */
  audible: number;
  /** Normalized learner score, -1..1. */
  taste: number;
};

export const MAX_FIELD_WORDS = 18;
/** The smoke ring never grows past this fraction of the lettering radius (narrow screens). */
export const RING_IN_RIM = 0.6;

export function createTasteField(): TasteField {
  return { words: [], rim: 0 };
}

/**
 * Packs the field for a `vec4[MAX_FIELD_WORDS]` uniform: xy = the word's
 * direction in GL space (y up), z = audible share, w = taste. Returns the count.
 */
export function packField(field: TasteField, out: Float32Array): number {
  const n = Math.min(field.words.length, MAX_FIELD_WORDS, out.length >> 2);
  for (let i = 0; i < n; i++) {
    const w = field.words[i]!;
    out[i * 4] = Math.cos(w.angle);
    out[i * 4 + 1] = -Math.sin(w.angle);
    out[i * 4 + 2] = w.audible;
    out[i * 4 + 3] = w.taste;
  }
  return n;
}

export type RimItem = { id: string; group: string; width: number };
export type RimPlace = { id: string; angle: number; flip: boolean };

export type RimOptions = {
  /** Open arc at the bottom, left free for the thumbs. */
  gap: number;
  /** Minimum space between words of one group, and between groups (px). */
  wordSpace: number;
  groupSpace: number;
};

/**
 * Justifies the words around the circle, in order, clockwise from the bottom
 * left to the bottom right. Spare arc is shared out between the spaces, so a
 * word that grows nudges its neighbours along; when the words outgrow the arc
 * everything shrinks by `scale`. Words below the middle are flipped so they
 * still read left to right, like the bottom of a coin.
 */
export function layoutRim(items: readonly RimItem[], radius: number, opts: RimOptions): { places: RimPlace[]; scale: number } {
  if (!items.length || radius <= 0) return { places: [], scale: 1 };
  const spaces: number[] = items.slice(1).map((item, i) => (item.group === items[i]!.group ? opts.wordSpace : opts.groupSpace));
  const words = items.reduce((sum, item) => sum + item.width, 0);
  const minSpace = spaces.reduce((sum, s) => sum + s, 0);
  const arc = radius * (Math.PI * 2 - opts.gap);
  const scale = Math.min(1, arc / Math.max(words + minSpace, 1e-6));
  // Leftover arc goes into the spaces in proportion to their size, so group breaks stay wider.
  const spare = Math.max(0, arc - (words + minSpace) * scale);
  const stretch = minSpace > 0 ? spare / (minSpace * scale) : 0;
  let cursor = minSpace > 0 ? 0 : spare / 2;
  const start = Math.PI / 2 + opts.gap / 2;
  const places = items.map((item, i) => {
    if (i > 0) cursor += spaces[i - 1]! * scale * (1 + stretch);
    const width = item.width * scale;
    const angle = start + (cursor + width / 2) / radius;
    cursor += width;
    return { id: item.id, angle, flip: Math.sin(angle) > 0.25 };
  });
  return { places, scale };
}

/** The audible blend as a few words, loudest first; slivers under `minShare` are left out. */
export function poemWords(audible: Record<string, number>, max = 4, minShare = 0.1): { id: string; share: number }[] {
  const entries = Object.entries(audible).filter(([, w]) => Number.isFinite(w) && w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return [];
  return entries
    .map(([id, w]) => ({ id, share: w / total }))
    .filter((e) => e.share >= minShare)
    .sort((a, b) => b.share - a.share || a.id.localeCompare(b.id))
    .slice(0, max);
}

/**
 * The rim word a pointer at (x, y) picks: the nearest by angle, anywhere within
 * `band` px of the lettering, so each word owns a generous slice of the ring.
 * A word reaches halfway to its neighbours, so the opening at the bottom stays
 * empty. Null when off the band.
 */
export function pickRimWord(places: readonly RimPlace[], ring: { x: number; y: number; r: number }, x: number, y: number, band: number): string | null {
  if (!places.length) return null;
  const dx = x - ring.x;
  const dy = y - ring.y;
  if (Math.abs(Math.hypot(dx, dy) - ring.r) > band) return null;
  const pointer = Math.atan2(dy, dx);
  const apart = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  let best = 0;
  places.forEach((place, i) => { if (apart(pointer, place.angle) < apart(pointer, places[best]!.angle)) best = i; });
  const prev = places[best - 1];
  const next = places[best + 1];
  const reach = Math.max(prev ? apart(prev.angle, places[best]!.angle) : 0, next ? apart(next.angle, places[best]!.angle) : 0) / 2;
  return places.length === 1 || apart(pointer, places[best]!.angle) <= reach ? places[best]!.id : null;
}

/**
 * The poem while a change is on its way, so the wait reads as the next verse
 * being written. Words in both blends ease toward their new share; arriving
 * words join as ghosts whose ink is the change's progress; leaving words give
 * back most of their ink. Once it has arrived (progress 1) the poem is the
 * destination, fully inked, so it doesn't flicker while the audible estimate
 * catches up. With nothing pending it's just `poemWords(audible)`.
 */
export function steeredPoem(
  audible: Record<string, number>,
  steer: { progress: number; to: Record<string, number> } | null,
): { lines: { id: string; share: number }[]; ink: Map<string, number> } {
  const lines = poemWords(audible);
  const ink = new Map<string, number>();
  if (!steer) return { lines, ink };
  if (!(steer.progress < 1)) return { lines: poemWords(steer.to), ink };
  const p = Math.max(0, steer.progress);
  const coming = poemWords(steer.to);
  const comingShare = new Map(coming.map((l) => [l.id, l.share]));
  const out = lines.map((l) => {
    const next = comingShare.get(l.id);
    if (next === undefined) {
      ink.set(l.id, 1 - 0.7 * p);
      return l;
    }
    return { id: l.id, share: l.share + (next - l.share) * p };
  });
  const here = new Set(lines.map((l) => l.id));
  for (const c of coming) {
    if (here.has(c.id)) continue;
    out.push({ id: c.id, share: c.share * (0.5 + 0.5 * p) });
    ink.set(c.id, p);
  }
  return { lines: out, ink };
}

/** Whether two blends read as the same poem. */
export function samePoem(a: Record<string, number>, b: Record<string, number>): boolean {
  const ids = (blend: Record<string, number>) => poemWords(blend).map((l) => l.id).sort().join('|');
  return ids(a) === ids(b);
}
