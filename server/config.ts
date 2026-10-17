// Env-driven relay config. Fail fast at startup on unusable settings so a
// misconfigured deploy exits loudly instead of limping.

export type MusicMode = 'live' | 'mock';

export type Config = {
  /** Port the relay binds. Default 8787 (vite.config.ts proxies /api/music here). */
  port: number;
  /** Default 127.0.0.1 (localhost only). HOST overrides for container deploys. */
  host: string;
  /** 'live' = Lyria RealTime via @google/genai; 'mock' = local paced tone. */
  musicMode: MusicMode;
  /** Absent only allowed when musicMode === 'mock'. Never logged. */
  geminiApiKey?: string;
  /** Max simultaneous browser sessions (each may hold one upstream stream). */
  maxStreams: number;
  /** Static UI build dir served in production / when present. */
  distDir: string;
};

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_STREAMS = 5;
const DEFAULT_DIST_DIR = 'dist';

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseMusicMode(raw: string | undefined): MusicMode {
  if (raw === undefined || raw.trim() === '') return 'live';
  const mode = raw.trim().toLowerCase();
  if (mode === 'live' || mode === 'mock') return mode;
  throw new Error(`MUSIC_MODE must be 'live' or 'mock', got ${JSON.stringify(raw)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const musicMode = parseMusicMode(env.MUSIC_MODE);
  const apiKeyRaw = env.GEMINI_API_KEY?.trim();
  const geminiApiKey = apiKeyRaw ? apiKeyRaw : undefined;

  // Fail fast: a live-mode relay without a key can never start a stream.
  if (musicMode === 'live' && !geminiApiKey) {
    throw new Error(
      'MUSIC_MODE=live requires GEMINI_API_KEY. Put your key in .env ' +
        '(see .env.example), or set MUSIC_MODE=mock for a local test tone.',
    );
  }

  return {
    port: parsePort(env.PORT),
    host: env.HOST?.trim() || DEFAULT_HOST,
    musicMode,
    geminiApiKey,
    maxStreams: parsePositiveInt(env.MAX_STREAMS, DEFAULT_MAX_STREAMS, 'MAX_STREAMS'),
    distDir: env.DIST_DIR?.trim() || DEFAULT_DIST_DIR,
  };
}
