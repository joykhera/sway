import { afterEach, describe, expect, it, vi } from 'vitest';
import { errMessage, log, redact } from './log.ts';

const SENTINEL_KEY = 'AIza_SENTINEL_SECRET_0123456789';

describe('redact', () => {
  it('strips key= URL param values', () => {
    expect(redact(`https://x.example/ws/Foo?key=${SENTINEL_KEY}`)).toBe(
      'https://x.example/ws/Foo?key=[redacted]',
    );
    expect(
      redact(`url?key=${SENTINEL_KEY}&other=1`),
    ).toBe('url?key=[redacted]&other=1');
  });

  it('leaves ordinary strings alone', () => {
    expect(redact('plain message')).toBe('plain message');
    expect(redact('keyboard cat')).toBe('keyboard cat');
  });
});

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits one JSON line to stdout for info', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log.info('test.event', { a: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('test.event');
    expect(parsed.a).toBe(1);
    expect(typeof parsed.ts).toBe('string');
  });

  it('warn/error go to stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.warn('w');
    log.error('e');
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
  });

  it('never emits a key= value or sentinel key in any field', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.info('connect', {
      url: `https://x.example/ws/BidiGenerateMusic?key=${SENTINEL_KEY}`,
      nested: { note: `key=${SENTINEL_KEY}` },
    });
    log.error('failed', { error: errMessage(new Error(`GET ?key=${SENTINEL_KEY} 500`)) });
    for (const spy of [out, err]) {
      for (const call of spy.mock.calls) {
        const line = String(call[0]);
        expect(line).not.toContain(SENTINEL_KEY);
        // every logged field value carrying `key=` must be fully redacted
        const parsed = JSON.parse(line) as Record<string, unknown>;
        for (const v of Object.values(parsed)) {
          const s = JSON.stringify(v);
          if (s.includes('key=')) expect(s).toContain('key=[redacted]');
          expect(s).not.toContain(SENTINEL_KEY);
        }
      }
    }
  });
});
