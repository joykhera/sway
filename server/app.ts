import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { INTENT_PATH } from '../src/shared/intent.ts';
import { createIntentHttpHandler } from './intent/http.ts';
import type { IntentInterpreter } from './intent/service.ts';
import { MUSIC_WS_PATH } from '../src/shared/protocol.ts';
import { parseClientMessage } from './guard.ts';
import type { StreamSlots } from './limits.ts';
import { log } from './log.ts';
import { Session } from './session.ts';
import type { UpstreamFactory } from './upstream/types.ts';

export type RelayOptions = {
  createUpstream: UpstreamFactory;
  slots: StreamSlots;
  staticDir?: string;
  interpretIntent?: IntentInterpreter;
};

export type Relay = {
  server: http.Server;
  sessions: Set<Session>;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
};

const MAX_MESSAGE_BYTES = 64 * 1024;

export function createRelay(opts: RelayOptions): Relay {
  const sessions = new Set<Session>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let nextId = 1;
  const intent = createIntentHttpHandler(opts.interpretIntent);

  const server = http.createServer((req, res) => {
    if (req.url?.split('?')[0] === INTENT_PATH) return void intent.handle(req, res);
    if (req.url === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (opts.staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
      return void serveStatic(opts.staticDir, req, res);
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== MUSIC_WS_PATH) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const session = new Session(ws, opts.createUpstream, opts.slots, `s${nextId++}`);
    sessions.add(session);
    log.info(session.id, 'client connected', { clients: sessions.size });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return session.sendError('bad_message', 'binary frames are not accepted', false);
      const result = parseClientMessage(data.toString());
      if (!result.ok) {
        log.warn(session.id, 'bad message', { error: result.error });
        return session.sendError('bad_message', result.error, false);
      }
      session.handle(result.msg);
    });
    const cleanup = () => {
      session.dispose();
      sessions.delete(session);
    };
    ws.on('close', cleanup);
    ws.on('error', (err) => {
      log.warn(session.id, 'client socket error', { error: err.message });
      cleanup();
    });
  });

  return {
    server,
    sessions,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      });
    },
    async close() {
      intent.close();
      for (const s of sessions) s.dispose();
      sessions.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

async function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const base = path.resolve(root);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return void res.writeHead(400).end();
  }
  let file = path.resolve(base, '.' + pathname);
  if (file !== base && !file.startsWith(base + path.sep)) return void res.writeHead(403).end();
  const isFile = await stat(file).then((s) => s.isFile(), () => false);
  if (!isFile) file = path.join(base, 'index.html');
  const ok = await stat(file).then((s) => s.isFile(), () => false);
  if (!ok) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}
