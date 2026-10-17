import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, redact, registerSecret } from './log.ts';

describe('log redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  const key = 'AIzaSyTESTKEY_0123456789abcdefghij';

  it('scrubs registered secrets and key= query params', () => {
    registerSecret(key);
    expect(redact(`token ${key} here`)).not.toContain(key);
    expect(redact('wss://x/ws?key=abc123&alt=1')).toBe('wss://x/ws?key=[REDACTED]&alt=1');
    expect(redact('key=zzz')).toBe('key=[REDACTED]');
    expect(redact('unregistered AIzaSyOTHER_0123456789abcdefghijkl')).not.toContain('AIzaSyOTHER');
  });

  it('never prints the key through the logger', () => {
    registerSecret(key);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('test', `url wss://host/path?key=${key}`, { nested: { url: `?key=${key}` }, raw: key });
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).not.toContain(key);
    expect(line).toContain('[REDACTED]');
  });
});
