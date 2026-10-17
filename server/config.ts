export type MusicMode = 'live' | 'mock';

export type Config = {
  mode: MusicMode;
  apiKey: string | undefined;
  port: number;
  maxStreams: number;
  production: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.MUSIC_MODE?.trim() || 'live';
  if (mode !== 'live' && mode !== 'mock') {
    throw new Error(`MUSIC_MODE must be "live" or "mock" (got "${mode}")`);
  }
  const apiKey = env.GEMINI_API_KEY?.trim() || undefined;
  if (mode === 'live' && !apiKey) {
    throw new Error('GEMINI_API_KEY is required when MUSIC_MODE=live (put it in .env, or set MUSIC_MODE=mock)');
  }
  return {
    mode,
    apiKey,
    port: intEnv(env, 'PORT', 8787, 0, 65535),
    maxStreams: intEnv(env, 'MAX_STREAMS', 5, 1, 1000),
    production: env.NODE_ENV === 'production',
  };
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
  }
  return n;
}
