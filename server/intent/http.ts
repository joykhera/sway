import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseInterpretRequest, type InterpretResponse } from '../../src/shared/intent.ts';
import type { IntentInterpreter } from './service.ts';
import { durationMs, observe, requestId, type IntentHttpReason, type IntentObserver } from './telemetry.ts';

export type IntentHttpHandler = { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): void };
export type HttpOptions = { maxConcurrent?: number; requestsPerMinute?: number; now?: () => number; bodyTimeoutMs?: number; observer?: IntentObserver };
const MAX_BODY = 16 * 1024;
const unavailable: InterpretResponse = { status: 'error', message: 'Text interpretation is unavailable on this server.' };

export function sameOrigin(req: IncomingMessage): boolean {
  if (!req.headers.origin || !req.headers.host || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) return false;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === req.headers.origin
      && origin.host === req.headers.host && !origin.username && !origin.password;
  } catch { return false; }
}
function send(res: ServerResponse, status: number, value: InterpretResponse): void {
  if (!res.destroyed && !res.writableEnded) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(value));
}
class BodyError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', fail); signal.removeEventListener('abort', abort); };
    const fail = (cause: unknown) => { cleanup(); req.resume(); reject(cause); };
    const abort = () => fail(new BodyError(408, 'The request took too long.'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) return fail(new BodyError(413, 'The description is too large.'));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new BodyError(400, 'Send a valid JSON description.')); }
    };
    req.on('data', data); req.once('end', end); req.once('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A small, server-wide limit avoids trusting spoofable forwarded addresses. */
export function createIntentHttpHandler(interpret?: IntentInterpreter, options: HttpOptions = {}): IntentHttpHandler {
  const active = new Map<AbortController, { res: ServerResponse; report: (status: number | null, reason: IntentHttpReason) => void }>();
  const arrivals: number[] = [];
  const now = options.now ?? Date.now;
  let closed = false;
  return {
    async handle(req, res) {
      const id = requestId();
      const started = performance.now();
      let reported = false;
      const report = (httpStatus: number | null, reason: IntentHttpReason) => {
        if (reported) return;
        reported = true;
        observe(options.observer, { event: 'http', requestId: id, durationMs: durationMs(started), httpStatus, reason });
      };
      const respond = (status: number, value: InterpretResponse, reason: IntentHttpReason) => {
        report(status, reason);
        send(res, status, value);
      };
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return respond(405, { status: 'error', message: 'Use POST for a music description.' }, 'method');
      }
      if (!sameOrigin(req)) return respond(403, { status: 'error', message: 'Open this page from the music server to submit a description.' }, 'origin');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return respond(415, { status: 'error', message: 'Send the description as JSON.' }, 'content_type');
      if (closed || !interpret) return respond(503, unavailable, 'unavailable');
      if (Number(req.headers['content-length']) > MAX_BODY) return respond(413, { status: 'error', message: 'The description is too large.' }, 'body_too_large');
      const time = now();
      while (arrivals.length && arrivals[0]! <= time - 60_000) arrivals.shift();
      if (arrivals.length >= (options.requestsPerMinute ?? 12) || active.size >= (options.maxConcurrent ?? 2)) {
        res.setHeader('retry-after', '5');
        return respond(429, { status: 'error', message: 'Text interpretation is busy. Please wait a moment before trying again.' }, arrivals.length >= (options.requestsPerMinute ?? 12) ? 'rate_limit' : 'concurrency_limit');
      }
      arrivals.push(time);
      const controller = new AbortController();
      active.set(controller, { res, report });
      const disconnected = () => { if (!res.writableEnded) { controller.abort(); report(null, 'aborted'); } };
      req.once('aborted', disconnected);
      res.once('close', disconnected);
      const bodyTimer = setTimeout(() => controller.abort(), options.bodyTimeoutMs ?? 5000);
      bodyTimer.unref();
      try {
        const value = await readBody(req, controller.signal);
        clearTimeout(bodyTimer);
        const input = parseInterpretRequest(value);
        if (!input) return respond(400, { status: 'error', message: 'Check the description and music settings, then try again.' }, 'invalid_request');
        const result = await interpret(input, controller.signal, { requestId: id });
        if (!controller.signal.aborted) respond(200, result, 'interpreted');
      } catch (cause) {
        if (cause instanceof BodyError) respond(cause.status, { status: 'error', message: cause.message }, cause.status === 408 ? 'body_timeout' : cause.status === 413 ? 'body_too_large' : 'invalid_json');
        else if (!controller.signal.aborted) respond(500, unavailable, 'internal_error');
      } finally {
        clearTimeout(bodyTimer);
        req.off('aborted', disconnected); res.off('close', disconnected);
        active.delete(controller);
      }
    },
    close() {
      closed = true;
      for (const [controller, { res, report }] of active) { report(503, 'shutdown'); controller.abort(); send(res, 503, unavailable); }
    },
  };
}
