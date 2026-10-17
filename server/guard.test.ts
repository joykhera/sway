import { describe, expect, it } from 'vitest';
import {
  parseClientMessage,
  ProtocolError,
  sanitizeConfig,
  sanitizePrompts,
} from './guard.ts';
import { WEIGHT_MAX, WEIGHT_MIN } from '../src/shared/protocol.ts';

function expectBadMessage(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('bad_message');
    return;
  }
  expect.unreachable('expected ProtocolError');
}

describe('parseClientMessage', () => {
  it('parses a valid start message', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'start',
        prompts: [{ text: 'lofi rain', weight: 1 }],
      }),
    );
    expect(msg).toEqual({
      type: 'start',
      prompts: [{ text: 'lofi rain', weight: 1 }],
    });
  });

  it('accepts Buffer input', () => {
    const msg = parseClientMessage(
      Buffer.from(JSON.stringify({ type: 'stop' })),
    );
    expect(msg).toEqual({ type: 'stop' });
  });

  it('parses a valid steer message', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        type: 'steer',
        revision: 3,
        prompts: [{ text: 'a', weight: 1 }],
        config: { density: 0.5 },
      }),
    );
    expect(msg).toEqual({
      type: 'steer',
      revision: 3,
      prompts: [{ text: 'a', weight: 1 }],
      config: { density: 0.5 },
    });
  });

  it.each([
    'not json {{{',
    '42',
    '"hello"',
    'null',
    '[]',
    '{}',
    '{"type":"bogus"}',
    '{"type":42}',
  ])('rejects malformed input → bad_message: %s', (input) => {
    expectBadMessage(() => parseClientMessage(input));
  });

  it('rejects steer without numeric revision', () => {
    for (const rev of ['1', undefined, null, NaN, Infinity]) {
      expectBadMessage(() =>
        parseClientMessage(
          JSON.stringify({
            type: 'steer',
            revision: rev,
            prompts: [{ text: 'a', weight: 1 }],
          }),
        ),
      );
    }
  });
});

describe('sanitizePrompts', () => {
  it('keeps valid prompts and trims text', () => {
    expect(
      sanitizePrompts([{ text: '  ambient pad  ', weight: 0.8 }]),
    ).toEqual([{ text: 'ambient pad', weight: 0.8 }]);
  });

  it('clamps weights into [WEIGHT_MIN, WEIGHT_MAX]', () => {
    const out = sanitizePrompts([
      { text: 'a', weight: 0.01 }, // >0 → clamps up to 0.1
      { text: 'b', weight: 99 },
    ]);
    expect(out).toEqual([
      { text: 'a', weight: WEIGHT_MIN },
      { text: 'b', weight: WEIGHT_MAX },
    ]);
  });

  it('drops zero, negative, NaN and non-finite weights', () => {
    const out = sanitizePrompts([
      { text: 'zero', weight: 0 },
      { text: 'neg', weight: -1 },
      { text: 'nan', weight: NaN },
      { text: 'inf', weight: Infinity },
      { text: 'ok', weight: 1 },
    ]);
    expect(out).toEqual([{ text: 'ok', weight: 1 }]);
  });

  it('drops empty/blank/non-string text and non-numeric weight', () => {
    const out = sanitizePrompts([
      { text: '', weight: 1 },
      { text: '   ', weight: 1 },
      { text: 42, weight: 1 },
      { text: 'x', weight: 'loud' },
      null,
      'junk',
      { weight: 1 },
      { text: 'ok', weight: 1 },
    ]);
    expect(out).toEqual([{ text: 'ok', weight: 1 }]);
  });

  it('throws bad_message when nothing usable remains', () => {
    expectBadMessage(() => sanitizePrompts([]));
    expectBadMessage(() => sanitizePrompts([{ text: '', weight: 1 }]));
    expectBadMessage(() => sanitizePrompts([{ text: 'a', weight: 0 }]));
    expectBadMessage(() => sanitizePrompts('not-an-array'));
    expectBadMessage(() => sanitizePrompts(undefined));
  });

  it('does not rescale weights (R5: only ratios matter)', () => {
    const out = sanitizePrompts([
      { text: 'a', weight: 0.4 },
      { text: 'b', weight: 0.4 },
    ]);
    expect(out.map((p) => p.weight)).toEqual([0.4, 0.4]);
  });
});

describe('sanitizeConfig', () => {
  it('returns undefined for null/undefined', () => {
    expect(sanitizeConfig(undefined)).toBeUndefined();
    expect(sanitizeConfig(null)).toBeUndefined();
  });

  it('keeps known fields, clamps 0..1, drops unknown keys', () => {
    const out = sanitizeConfig({
      density: 0.7,
      brightness: 2.4, // clamps to 1
      temperature: 1.3,
      bpm: 999, // unknown to us → dropped
      junk: 'x',
    });
    expect(out).toEqual({ density: 0.7, brightness: 1, temperature: 1.3 });
  });

  it('drops non-finite numeric fields', () => {
    expect(
      sanitizeConfig({ density: NaN, temperature: Infinity }),
    ).toBeUndefined();
  });

  it('throws bad_message for non-object config', () => {
    expectBadMessage(() => sanitizeConfig(7));
    expectBadMessage(() => sanitizeConfig([1]));
  });
});
