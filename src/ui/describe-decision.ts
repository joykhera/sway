import type { MusicSignature, VoteDecision } from './contracts.ts';

const PHRASES: Record<VoteDecision['kind'], string> = {
  initial: 'finding a starting point',
  hold: 'keeping this direction',
  redirect: 'moving away from that, trying something new',
  variation: 'exploring a nearby variation',
  probe: 'trying something new to learn',
};

/** Learner reasons longer than this (first clause) are left out — one humble line. */
const MAX_REASON_CHARS = 48;
/** Words that would overclaim (scores aren't "favorites", uncertainty isn't a probability). */
const OVERCLAIM = /favou?rit|probab|percent|%|\d/i;

const contentWords = (text: string) =>
  new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5));

/**
 * One humble line explaining how the learner responded to the latest vote.
 * Maps `kind` to a plain phrase and appends the learner's own reason (first
 * clause only) when it is short, adds something new, and doesn't overclaim.
 */
export function describeDecision(decision: Pick<VoteDecision, 'kind' | 'reason'>): string {
  const phrase = PHRASES[decision.kind] ?? 'adjusting';
  const clause = (decision.reason ?? '').split(/[.;:]/)[0]?.trim() ?? '';
  if (!clause || clause.length > MAX_REASON_CHARS || OVERCLAIM.test(clause)) return phrase;
  const phraseWords = contentWords(phrase);
  for (const w of contentWords(clause)) if (phraseWords.has(w)) return phrase;
  return `${phrase} — ${clause.charAt(0).toLowerCase()}${clause.slice(1)}`;
}

const FIELDS = ['genre', 'instrument', 'mood', 'texture', 'focus'] as const;

const norm = (v: string | undefined) => v?.trim().toLowerCase() ?? '';

/** True when two signatures name the same blend (trimmed, case-insensitive). */
export function sameSignature(a: MusicSignature | undefined, b: MusicSignature | undefined): boolean {
  return FIELDS.every((f) => norm(a?.[f]) === norm(b?.[f]));
}

/** True when a signature has at least one non-blank field. */
export function hasSignature(s: MusicSignature | undefined): s is MusicSignature {
  return FIELDS.some((f) => norm(s?.[f]) !== '');
}

/** `ambient · drone — "soft keys"`; blank fields drop out. Null when empty. */
export function signatureLine(signature: MusicSignature | undefined): string | null {
  if (!signature) return null;
  const head = [signature.genre, signature.instrument, signature.mood, signature.texture]
    .map((f) => f?.trim())
    .filter((f): f is string => Boolean(f))
    .join(' · ');
  const focus = signature.focus?.trim();
  const line = focus ? (head ? `${head} — "${focus}"` : `"${focus}"`) : head;
  return line.length > 0 ? line : null;
}
