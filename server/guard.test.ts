import { describe, expect, it } from 'vitest';
import { WEIGHT_MAX, WEIGHT_MIN } from '../src/shared/protocol.ts';
import { MAX_PROMPT_CHARS, MAX_PROMPTS, parseClientMessage, validateClientMessage } from './guard.ts';

const start = (prompts: unknown, extra: object = {}) => validateClientMessage({ type: 'start', prompts, ...extra });

describe('guard', () => {
  it('rejects invalid JSON and non-objects', () => {
    expect(parseClientMessage('{nope').ok).toBe(false);
    expect(parseClientMessage('null').ok).toBe(false);
    expect(parseClientMessage('[]').ok).toBe(false);
    expect(parseClientMessage('"start"').ok).toBe(false);
  });

  it('rejects unknown types', () => {
    expect(validateClientMessage({ type: 'play' }).ok).toBe(false);
    expect(validateClientMessage({}).ok).toBe(false);
  });

  it('accepts stop', () => {
    expect(validateClientMessage({ type: 'stop', extra: 1 })).toEqual({ ok: true, msg: { type: 'stop' } });
  });

  it('accepts and trims a valid start', () => {
    expect(start([{ text: '  lofi ', weight: 1 }])).toEqual({
      ok: true,
      msg: { type: 'start', prompts: [{ text: 'lofi', weight: 1 }] },
    });
  });

  it('rejects bad prompt shapes', () => {
    expect(start(undefined).ok).toBe(false);
    expect(start({}).ok).toBe(false);
    expect(start([]).ok).toBe(false);
    expect(start(['lofi']).ok).toBe(false);
    expect(start([{ text: 1, weight: 1 }]).ok).toBe(false);
    expect(start([{ text: '   ', weight: 1 }]).ok).toBe(false);
    expect(start([{ text: 'x'.repeat(MAX_PROMPT_CHARS + 1), weight: 1 }]).ok).toBe(false);
    expect(start([{ text: 'lofi', weight: '1' }]).ok).toBe(false);
    expect(start(Array.from({ length: MAX_PROMPTS + 1 }, (_, i) => ({ text: `p${i}`, weight: 1 }))).ok).toBe(false);
  });

  it('drops zero, NaN, infinite and negative weights', () => {
    const r = start([
      { text: 'a', weight: 0 },
      { text: 'b', weight: NaN },
      { text: 'c', weight: -1 },
      { text: 'd', weight: Infinity },
      { text: 'e', weight: 0.5 },
    ]);
    expect(r).toEqual({ ok: true, msg: { type: 'start', prompts: [{ text: 'e', weight: 0.5 }] } });
  });

  it('rejects when every weight is dropped', () => {
    expect(start([{ text: 'a', weight: 0 }, { text: 'b', weight: -2 }]).ok).toBe(false);
  });

  it('clamps weights into range', () => {
    const r = start([{ text: 'a', weight: 0.01 }, { text: 'b', weight: 50 }]);
    expect(r.ok && r.msg.type === 'start' && r.msg.prompts.map((p) => p.weight)).toEqual([WEIGHT_MIN, WEIGHT_MAX]);
  });

  it('validates steer revision', () => {
    const prompts = [{ text: 'a', weight: 1 }];
    expect(validateClientMessage({ type: 'steer', revision: 3, prompts }).ok).toBe(true);
    expect(validateClientMessage({ type: 'steer', revision: 0, prompts }).ok).toBe(true);
    expect(validateClientMessage({ type: 'steer', revision: -1, prompts }).ok).toBe(false);
    expect(validateClientMessage({ type: 'steer', revision: 1.5, prompts }).ok).toBe(false);
    expect(validateClientMessage({ type: 'steer', revision: '1', prompts }).ok).toBe(false);
    expect(validateClientMessage({ type: 'steer', prompts }).ok).toBe(false);
  });

  it('validates config ranges and ignores unknown keys', () => {
    const prompts = [{ text: 'a', weight: 1 }];
    expect(start(prompts, { config: { density: 0.5, bpm: 120, temperature: 3 } })).toEqual({
      ok: true,
      msg: { type: 'start', prompts, config: { density: 0.5, temperature: 3 } },
    });
    expect(start(prompts, { config: { density: 1.5 } }).ok).toBe(false);
    expect(start(prompts, { config: { brightness: -0.1 } }).ok).toBe(false);
    expect(start(prompts, { config: { temperature: 3.1 } }).ok).toBe(false);
    expect(start(prompts, { config: { density: NaN } }).ok).toBe(false);
    expect(start(prompts, { config: 'loud' }).ok).toBe(false);
  });
});
