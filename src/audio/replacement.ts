import { BYTES_PER_FRAME, PENDING_CHUNK_LIMIT } from './constants.ts';
import type { AudioFormat } from './types.ts';

export const REPLACEMENT_MIN_SECONDS = 3;
export const REPLACEMENT_MAX_SECONDS = 12;
export const REPLACEMENT_MAX_FADE_MS = 1000;

/** Validate and detach from caller mutation before either player changes state. */
export function prepareReplacement(audio: AudioFormat, chunks: ArrayBuffer[], fadeMs: number): Uint8Array | undefined {
  if (audio?.format !== 'pcm_s16le' || audio.channels !== 2
    || !Number.isInteger(audio.sampleRateHz) || audio.sampleRateHz < 8000 || audio.sampleRateHz > 192000
    || !Number.isFinite(fadeMs) || fadeMs < 0 || fadeMs > REPLACEMENT_MAX_FADE_MS
    || !Array.isArray(chunks) || chunks.length === 0 || chunks.length > PENDING_CHUNK_LIMIT) return;
  let length = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof ArrayBuffer)) return;
    length += chunk.byteLength;
    if (length > audio.sampleRateHz * BYTES_PER_FRAME * REPLACEMENT_MAX_SECONDS) return;
  }
  if (Math.floor(length / BYTES_PER_FRAME) < audio.sampleRateHz * REPLACEMENT_MIN_SECONDS) return;
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
    return bytes;
  } catch { return; } // Detached buffers cannot partially replace the current stream.
}
