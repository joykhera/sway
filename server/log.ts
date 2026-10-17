type Fields = Record<string, unknown>;

const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out
    .replace(/([?&;\s"']key=)[^&\s"';]+/gi, '$1[REDACTED]')
    .replace(/^key=[^&\s"';]+/i, 'key=[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

function format(tag: string, msg: string, fields?: Fields): string {
  const extra = fields && Object.keys(fields).length > 0 ? ' ' + safeJson(fields) : '';
  return redact(`[${tag}] ${msg}${extra}`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

export const log = {
  info: (tag: string, msg: string, fields?: Fields) => console.log(format(tag, msg, fields)),
  warn: (tag: string, msg: string, fields?: Fields) => console.warn(format(tag, msg, fields)),
  error: (tag: string, msg: string, fields?: Fields) => console.error(format(tag, msg, fields)),
};

export function errorMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
