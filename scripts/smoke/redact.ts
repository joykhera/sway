/**
 * The SDK puts the API key in the WebSocket URL (`?key=`), so anything that
 * came from the socket layer is scrubbed before it is printed or written.
 */
export function makeScrubber(secret: string): (text: string) => string {
  return (text: string): string => {
    let out = text;
    if (secret.length > 0) out = out.split(secret).join('[REDACTED]');
    return out.replace(/([?&]key=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  };
}

/** Best-effort string from an unknown thrown value, without dumping objects. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  return `non-Error value of type ${typeof err}`;
}
