/** A local Mulberry32 stream. No global state; seed 0 is a valid stream. */
export function normalizeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

export function createRng(seed: number) {
  let cursor = normalizeSeed(seed);
  return {
    next(): number {
      cursor = (cursor + 0x6d2b79f5) >>> 0;
      let value = cursor;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    },
    get seed() { return cursor; },
  };
}

export type Rng = ReturnType<typeof createRng>;

export function pick<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) throw new Error('Cannot choose from an empty vocabulary');
  return items[Math.floor(rng.next() * items.length)]!;
}

/** Explicit content-derived entropy for the frozen no-vote API. */
export function hashText(text: string, seed: number): number {
  let hash = normalizeSeed(seed) ^ 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0;
}
