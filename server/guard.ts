import { WEIGHT_MAX, WEIGHT_MIN } from '../src/shared/protocol.ts';
import type { ClientMessage, StreamConfig, WeightedPrompt } from '../src/shared/protocol.ts';
import { validPrefetchMs } from './prefetch.ts';

import { MAX_PROMPTS } from '../src/shared/protocol.ts';
export { MAX_PROMPTS };
export const MAX_PROMPT_CHARS = 200;

export type GuardResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseClientMessage(raw: string): GuardResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('invalid JSON');
  }
  return validateClientMessage(data);
}

export function validateClientMessage(data: unknown): GuardResult {
  if (!isObj(data)) return fail('message must be an object');
  switch (data.type) {
    case 'stop':
      return { ok: true, msg: { type: 'stop' } };
    case 'resume':
      return { ok: true, msg: { type: 'resume' } };
    case 'start': {
      const prompts = sanitizePrompts(data.prompts);
      if (typeof prompts === 'string') return fail(prompts);
      const config = sanitizeConfig(data.config);
      if (typeof config === 'string') return fail(config);
      if (data.prefetchMs !== undefined && !validPrefetchMs(data.prefetchMs)) {
        return fail('prefetchMs must be an integer in [3000, 8000]');
      }
      return { ok: true, msg: { type: 'start', prompts, ...(config ? { config } : {}),
        ...(data.prefetchMs !== undefined ? { prefetchMs: data.prefetchMs as number } : {}) } };
    }
    case 'steer': {
      const rev = data.revision;
      if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
        return fail('revision must be a nonnegative integer');
      }
      const prompts = sanitizePrompts(data.prompts);
      if (typeof prompts === 'string') return fail(prompts);
      const config = sanitizeConfig(data.config);
      if (typeof config === 'string') return fail(config);
      return {
        ok: true,
        msg: config ? { type: 'steer', revision: rev, prompts, config } : { type: 'steer', revision: rev, prompts },
      };
    }
    default:
      return fail('unknown message type');
  }
}

// Returns sanitized prompts or an error string. Zero/negative/non-finite weights are dropped, the rest clamped.
export function sanitizePrompts(value: unknown): WeightedPrompt[] | string {
  if (!Array.isArray(value)) return 'prompts must be an array';
  if (value.length === 0) return 'prompts must not be empty';
  if (value.length > MAX_PROMPTS) return `at most ${MAX_PROMPTS} prompts`;
  const out: WeightedPrompt[] = [];
  for (const p of value) {
    if (!isObj(p)) return 'each prompt must be an object';
    if (typeof p.text !== 'string') return 'prompt text must be a string';
    const text = p.text.trim();
    if (!text) return 'prompt text must not be empty';
    if (text.length > MAX_PROMPT_CHARS) return `prompt text exceeds ${MAX_PROMPT_CHARS} chars`;
    if (typeof p.weight !== 'number') return 'prompt weight must be a number';
    if (!Number.isFinite(p.weight) || p.weight <= 0) continue;
    out.push({ text, weight: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, p.weight)) });
  }
  if (out.length === 0) return 'no prompts with a positive weight';
  return out;
}

const CONFIG_RANGES = { density: [0, 1], brightness: [0, 1], temperature: [0, 3] } as const;

export function sanitizeConfig(value: unknown): StreamConfig | undefined | string {
  if (value === undefined) return undefined;
  if (!isObj(value)) return 'config must be an object';
  const out: StreamConfig = {};
  for (const key of Object.keys(CONFIG_RANGES) as (keyof typeof CONFIG_RANGES)[]) {
    const v = value[key];
    if (v === undefined) continue;
    const [min, max] = CONFIG_RANGES[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      return `config.${key} must be a number in [${min}, ${max}]`;
    }
    out[key] = v;
  }
  return out;
}

function fail(error: string): GuardResult {
  return { ok: false, error };
}
