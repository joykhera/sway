// These limits apply only until a speculative stream is explicitly resumed.
export const PREFETCH_MIN_MS = 3000;
export const PREFETCH_MAX_MS = 8000;
export const PREFETCH_AUDIO_LIMIT_MS = 12_000;
export const PREFETCH_SETUP_TIMEOUT_MS = 15_000;
export const PREFETCH_PAUSED_TTL_MS = 60_000;
export const PREFETCH_LIFETIME_MS = 75_000;

export const validPrefetchMs = (value: unknown): value is number => typeof value === 'number'
  && Number.isInteger(value) && value >= PREFETCH_MIN_MS && value <= PREFETCH_MAX_MS;
