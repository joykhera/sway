import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('config', () => {
  it('defaults to live and requires a key', () => {
    expect(() => loadConfig({})).toThrow(/GEMINI_API_KEY/);
  });

  it('parses mock mode without a key', () => {
    expect(loadConfig({ MUSIC_MODE: 'mock' })).toMatchObject({ mode: 'mock', port: 8787, maxStreams: 5 });
  });

  it('keeps optional text-provider credentials separate from music mode', () => {
    expect(loadConfig({ MUSIC_MODE: 'mock' }).intentApiKey).toBeUndefined();
    expect(loadConfig({ MUSIC_MODE: 'mock', CRUSOE_API_KEY: '  text-provider-test-key  ' }).intentApiKey).toBe('text-provider-test-key');
    expect(loadConfig({ GEMINI_API_KEY: 'music-test-key' }).intentApiKey).toBeUndefined();
  });

  it('binds loopback unless HOST overrides', () => {
    expect(loadConfig({ MUSIC_MODE: 'mock' }).host).toBe('127.0.0.1');
    expect(loadConfig({ MUSIC_MODE: 'mock', HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('rejects bad values without echoing the key', () => {
    expect(() => loadConfig({ MUSIC_MODE: 'demo' })).toThrow(/MUSIC_MODE/);
    expect(() => loadConfig({ MUSIC_MODE: 'mock', PORT: 'abc' })).toThrow(/PORT/);
    try {
      loadConfig({ GEMINI_API_KEY: 'secret-key-value', MAX_STREAMS: '0' });
    } catch (err) {
      expect(String(err)).not.toContain('secret-key-value');
    }
  });
});
