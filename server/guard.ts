// Pure validation/sanitization of inbound browser frames.
// Anything malformed throws ProtocolError{code:'bad_message'} — the session
// translates that into a protocol `error` message, never a crash.

import { WEIGHT_MAX, WEIGHT_MIN } from '../src/shared/protocol.ts';
import type {
  ClientMessage,
  ErrorCode,
  StreamConfig,
  WeightedPrompt,
} from '../src/shared/protocol.ts';

export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function bad(message: string): never {
  throw new ProtocolError('bad_message', message);
}

/**
 * JSON.parse + shape-check a raw client frame. Returns a fully sanitized
 * ClientMessage — downstream code can trust the shape.
 */
export function parseClientMessage(data: Buffer | string): ClientMessage {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad('message is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    bad('message must be a JSON object');
  }
  const type = (raw as { type?: unknown }).type;
  switch (type) {
    case 'start': {
      const m = raw as { prompts?: unknown; config?: unknown };
      const prompts = sanitizePrompts(m.prompts);
      const config = sanitizeConfig(m.config);
      return config === undefined
        ? { type: 'start', prompts }
        : { type: 'start', prompts, config };
    }
    case 'steer': {
      const m = raw as { revision?: unknown; prompts?: unknown; config?: unknown };
      if (typeof m.revision !== 'number' || !Number.isFinite(m.revision)) {
        bad('steer requires a finite numeric revision');
      }
      const prompts = sanitizePrompts(m.prompts);
      const config = sanitizeConfig(m.config);
      return config === undefined
        ? { type: 'steer', revision: m.revision, prompts }
        : { type: 'steer', revision: m.revision, prompts, config };
    }
    case 'stop':
      return { type: 'stop' };
    default:
      bad(`unknown message type: ${JSON.stringify(type) ?? 'undefined'}`);
  }
}

/**
 * Keep prompts with nonempty trimmed text and finite weight > 0; clamp weight
 * into [WEIGHT_MIN, WEIGHT_MAX]. R5: Lyria normalizes weights to sum 1 — only
 * ratios matter, so we pass through and never rescale. Empty result → throw.
 */
export function sanitizePrompts(input: unknown): WeightedPrompt[] {
  if (!Array.isArray(input)) bad('prompts must be an array');
  const out: WeightedPrompt[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { text, weight } = entry as { text?: unknown; weight?: unknown };
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue;
    out.push({
      text: trimmed,
      weight: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight)),
    });
  }
  if (out.length === 0) bad('no usable prompts');
  return out;
}

/**
 * Keep known numeric StreamConfig fields (density/brightness clamped to [0,1],
 * temperature any finite number); drop unknown keys and non-numeric values.
 * A config object with no usable fields becomes `undefined`.
 */
export function sanitizeConfig(input: unknown): StreamConfig | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    bad('config must be an object');
  }
  const src = input as Record<string, unknown>;
  const out: StreamConfig = {};
  for (const key of ['density', 'brightness'] as const) {
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = Math.min(1, Math.max(0, v));
    }
  }
  const temperature = src.temperature;
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    out.temperature = temperature;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
