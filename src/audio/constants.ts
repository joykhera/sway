// Tunables for the browser PCM player. Hypotheses, not measured values (handoff §6).
// Keep every magic number here so integration can iterate in one place.

/** Assumed Lyria output rate until Developer A's smoke test says otherwise. */
export const DEFAULT_SAMPLE_RATE_HZ = 48000;
export const CHANNELS = 2;
export const BYTES_PER_SAMPLE = 2;
/** One interleaved stereo s16le frame. */
export const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE;

/** Output stays silent until this much audio is buffered at start. Handoff hypothesis: 0.5–1.5 s. */
export const PREROLL_MS = 750;
/** After an underrun, output stays silent until this much audio is buffered again. */
export const REPRIME_MS = 300;
/** Ring capacity at the output rate. Lyria can burst ahead of realtime; oldest audio is dropped beyond this. */
export const RING_CAPACITY_MS = 20_000;
/** How often the worklet posts stats to the main thread. */
export const STATS_INTERVAL_MS = 100;
/** Chunks held on the main thread before init/configure completes; oldest dropped beyond this. */
export const PENDING_CHUNK_LIMIT = 256;
/** Render quantum of the Web Audio API. */
export const RENDER_QUANTUM_FRAMES = 128;
