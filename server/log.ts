// Tiny structured logger: one JSON object per line.
// info → stdout, warn/error → stderr.
//
// R8: the @google/genai SDK embeds the Gemini API key in the upstream URL as
// `?key=...`. Never log upstream URLs, raw ws ErrorEvent/CloseEvent objects,
// or process.env. `redact` scrubs any `key=<value>` substring from every
// logged string as a second line of defense.

export type LogFields = Record<string, unknown>;

const KEY_PARAM = /key=[^&\s]+/g;

/** Strip `key=<value>` URL params (upstream auth) from a logged string. */
export function redact(value: string): string {
  return value.replace(KEY_PARAM, 'key=[redacted]');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value;
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void {
  const safeFields = (fields ? redactValue(fields) : {}) as LogFields;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event: redact(event),
    ...safeFields,
  });
  const stream = level === 'info' ? process.stdout : process.stderr;
  stream.write(line + '\n');
}

export const log = {
  info(event: string, fields?: LogFields): void {
    emit('info', event, fields);
  },
  warn(event: string, fields?: LogFields): void {
    emit('warn', event, fields);
  },
  error(event: string, fields?: LogFields): void {
    emit('error', event, fields);
  },
};

/** Best-effort message extraction that never leaks raw objects (or URLs). */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  if (typeof err === 'string') return redact(err);
  return 'unknown';
}
