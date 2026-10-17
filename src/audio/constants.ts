// Tunables for the browser PCM player. PREROLL_MS/REPRIME_MS are set from A's
// measured smoke report (docs/lyria-smoke-report.md); the rest remain tunables.
// Keep every magic number here so integration can iterate in one place.

/** Assumed Lyria output rate until Developer A's smoke test says otherwise. */
export const DEFAULT_SAMPLE_RATE_HZ = 48000;
export const CHANNELS = 2;
export const BYTES_PER_SAMPLE = 2;
/** One interleaved stereo s16le frame. */
export const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE;

/** Output stays silent until this much audio is buffered at start. Lyria delivers
 *  ~2 s chunks every ~2 s at ~1× realtime (docs/lyria-smoke-report.md), so the
 *  initial preroll must clear roughly one full block plus jitter. */
export const PREROLL_MS = 2750;
/** After an underrun, output stays silent until this much audio is buffered again.
 *  A bit less than the initial preroll — recovering quickly beats deep padding. */
export const REPRIME_MS = 1750;
/** Ring capacity at the output rate. Lyria can burst ahead of realtime; oldest audio is dropped beyond this. */
export const RING_CAPACITY_MS = 20_000;
/** How often the worklet posts stats to the main thread. */
export const STATS_INTERVAL_MS = 100;
/** Chunks held on the main thread before init/configure completes; oldest dropped beyond this. */
export const PENDING_CHUNK_LIMIT = 256;
/** Render quantum of the Web Audio API. */
export const RENDER_QUANTUM_FRAMES = 128;
