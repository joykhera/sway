/**
 * Pure helpers for interpreting Lyria audio chunks: mimeType parsing,
 * PCM duration math and a byte-order sanity check.
 */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Lyria's documented output (R2 in docs/part-a-plan.md). */
export const DEFAULT_PCM_FORMAT: Readonly<PcmFormat> = Object.freeze({
  sampleRate: 48000,
  channels: 2,
  bitsPerSample: 16,
});

export interface ParsedMimeType {
  /** Lower-cased base type, e.g. "audio/l16" or "audio/pcm". */
  baseType: string;
  sampleRate?: number;
  channels?: number;
  /** All parameters, keys lower-cased. */
  params: Record<string, string>;
}

const RATE_KEYS = ['rate', 'samplerate', 'sample_rate', 'sample-rate'];
const CHANNEL_KEYS = ['channels', 'channel', 'num_channels', 'channelcount'];

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Parse a mimeType such as "audio/l16;rate=48000;channels=2".
 * Returns undefined for a missing/empty mimeType.
 */
export function parseAudioMimeType(mimeType: string | undefined): ParsedMimeType | undefined {
  if (mimeType === undefined) return undefined;
  const trimmed = mimeType.trim();
  if (trimmed === '') return undefined;
  const [base = '', ...rest] = trimmed.split(';');
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (key !== '') params[key] = value;
  }
  const parsed: ParsedMimeType = { baseType: base.trim().toLowerCase(), params };
  for (const k of RATE_KEYS) {
    const v = positiveInt(params[k]);
    if (v !== undefined) {
      parsed.sampleRate = v;
      break;
    }
  }
  for (const k of CHANNEL_KEYS) {
    const v = positiveInt(params[k]);
    if (v !== undefined) {
      parsed.channels = v;
      break;
    }
  }
  return parsed;
}

export interface ResolvedFormat extends PcmFormat {
  rateSource: 'mimeType' | 'assumed';
  channelsSource: 'mimeType' | 'assumed';
  /** Human-readable explanation, printed in the console and report. */
  note: string;
}

/** Resolve the PCM format for a chunk, falling back to 48 kHz stereo s16le. */
export function resolveFormat(
  mimeType: string | undefined,
  fallback: Readonly<PcmFormat> = DEFAULT_PCM_FORMAT,
): ResolvedFormat {
  const parsed = parseAudioMimeType(mimeType);
  const sampleRate = parsed?.sampleRate ?? fallback.sampleRate;
  const channels = parsed?.channels ?? fallback.channels;
  const rateSource = parsed?.sampleRate !== undefined ? 'mimeType' : 'assumed';
  const channelsSource = parsed?.channels !== undefined ? 'mimeType' : 'assumed';
  const note =
    `${sampleRate} Hz (${rateSource}), ${channels} ch (${channelsSource}), ` +
    `${fallback.bitsPerSample}-bit PCM (assumed signed little-endian)` +
    (mimeType === undefined || mimeType === '' ? ' — chunk had no mimeType' : ` — mimeType "${mimeType}"`);
  return { sampleRate, channels, bitsPerSample: fallback.bitsPerSample, rateSource, channelsSource, note };
}

/** Seconds of audio represented by `bytes` of interleaved PCM. */
export function pcmDurationSec(bytes: number, fmt: Readonly<PcmFormat>): number {
  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  if (bytesPerSecond <= 0) return 0;
  return bytes / bytesPerSecond;
}

/**
 * Mean absolute difference between consecutive 16-bit samples of the same
 * channel, read as little-endian and as big-endian. Real music is smooth in
 * the correct byte order, so the correct reading has a much smaller score.
 */
export function byteOrderScores(buf: Uint8Array, channels: number): { le: number; be: number } {
  const frameBytes = 2 * channels;
  const frames = Math.floor(buf.length / frameBytes);
  if (frames < 2) return { le: 0, be: 0 };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let le = 0;
  let be = 0;
  let n = 0;
  for (let f = 1; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const cur = f * frameBytes + c * 2;
      const prev = cur - frameBytes;
      le += Math.abs(view.getInt16(cur, true) - view.getInt16(prev, true));
      be += Math.abs(view.getInt16(cur, false) - view.getInt16(prev, false));
      n++;
    }
  }
  return { le: le / n, be: be / n };
}

/** Swap bytes of each 16-bit sample (returns a new buffer). */
export function byteswap16(buf: Uint8Array): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const a = out[i] ?? 0;
    out[i] = out[i + 1] ?? 0;
    out[i + 1] = a;
  }
  return out;
}
