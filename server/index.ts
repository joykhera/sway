// Relay entry point. `pnpm dev` runs this via tsx watch; `pnpm start` runs it
// with NODE_ENV=production. Responsibilities:
//
//   - http server on config.host:config.port (127.0.0.1:8787 by default)
//   - GET /healthz → 200 {"ok":true}
//   - prod / dist-present: serve the built UI from distDir (SPA fallback,
//     traversal-safe); dev: non-/api GETs 404 — vite serves the UI
//   - ws upgrade only on MUSIC_WS_PATH (/api/music); anything else destroyed
//   - per-connection MusicSession; connections beyond maxStreams get
//     error{capacity} then close; binary client frames ignored
//   - close/error → session.dispose() frees the stream slot

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { errMessage, log } from './log.ts';
import { MusicSession } from './session.ts';
import { LyriaUpstream } from './upstream/lyria.ts';
import { MockUpstream } from './upstream/mock.ts';
import type { MusicUpstream } from './upstream/types.ts';
import { MUSIC_WS_PATH } from '../src/shared/protocol.ts';
import type { ServerMessage } from '../src/shared/protocol.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function startServer(config: Config): {
  server: Server;
  wss: WebSocketServer;
  sessions: Set<MusicSession>;
  close(): Promise<void>;
} {
  const distRoot = path.resolve(config.distDir);
  const serveStatic =
    process.env.NODE_ENV === 'production' || existsSync(distRoot);
  const sessions = new Set<MusicSession>();
  const sockets = new Set<Socket>();

  const createUpstream = (): MusicUpstream =>
    config.musicMode === 'mock'
      ? new MockUpstream()
      : new LyriaUpstream({ apiKey: config.geminiApiKey ?? '' });

  const server = createServer((req, res) => {
    void handleHttp(req, res, distRoot, serveStatic);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== MUSIC_WS_PATH) {
      log.warn('ws upgrade rejected: wrong path', { path: pathname });
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    if (sessions.size >= config.maxStreams) {
      log.warn('ws connection rejected: capacity', {
        remote,
        active: sessions.size,
      });
      sendWsJson(ws, {
        type: 'error',
        code: 'capacity',
        message: 'too many active streams',
        retryable: true,
      });
      // ws flushes queued sends before the close frame, so the UI sees it.
      try {
        ws.close(1013, 'capacity');
      } catch {
        // socket already gone
      }
      return;
    }

    const session = new MusicSession({
      send: (msg) => sendWsJson(ws, msg),
      sendBinary: (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
      },
      createUpstream,
      onDispose: () => sessions.delete(session),
    });
    sessions.add(session);
    log.info('client connected', { remote, active: sessions.size });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return; // the client never sends binary
      session.handleMessage(toBuffer(data));
    });
    ws.on('close', (code) => {
      session.dispose();
      sessions.delete(session);
      log.info('client disconnected', { remote, code });
    });
    ws.on('error', (err) => {
      log.warn('client socket error', { remote, error: errMessage(err) });
      session.dispose();
      sessions.delete(session);
    });
  });

  server.on('error', (err) => {
    log.error('http server error', { error: errMessage(err) });
  });
  server.on('listening', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    log.info('relay listening', {
      host: config.host,
      port,
      musicMode: config.musicMode,
      serveStatic,
      maxStreams: config.maxStreams,
    });
  });
  server.listen(config.port, config.host);

  const close = async (): Promise<void> => {
    for (const session of sessions) session.dispose();
    sessions.clear();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  };

  return { server, wss, sessions, close };
}

// ---- http helpers ----------------------------------------------------------

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  distRoot: string,
  serveStatic: boolean,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!serveStatic) {
      sendJson(res, 404, {
        error: 'no static build here; `pnpm dev` serves the UI via vite',
      });
      return;
    }
    await serveStaticFile(res, distRoot, pathname, req.method === 'HEAD');
  } catch (err) {
    log.error('http request failed', { error: errMessage(err) });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    if (!res.writableEnded) res.end();
  }
}

async function serveStaticFile(
  res: ServerResponse,
  distRoot: string,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'bad path' });
    return;
  }
  let filePath = path.resolve(distRoot, `.${rel}`);
  // Path traversal guard: resolved path must stay inside distRoot.
  if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  let stat = tryStat(filePath);
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = tryStat(filePath);
  }
  if (!stat?.isFile()) {
    // SPA fallback: unknown non-/api GETs get index.html.
    filePath = path.join(distRoot, 'index.html');
    stat = tryStat(filePath);
    if (!stat?.isFile()) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
  }
  const body = await readFile(filePath);
  const mime =
    MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': mime,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  if (!headOnly) res.write(body);
  res.end();
}

function tryStat(filePath: string): Stats | null {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendWsJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

// ---- main ------------------------------------------------------------------

function isMain(): boolean {
  const entry = process.argv[1];
  // `tsx -e "import('./server/index.ts')"` / `node -e` smoke checks have no
  // argv[1]; importing the module there is a deliberate boot.
  if (!entry) return true;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    startServer(loadConfig());
  } catch (err) {
    // Fail fast and loudly — never echo the key (config errors don't contain
    // it, and log.error redacts key= params regardless).
    log.error('startup failed', { error: errMessage(err) });
    process.exitCode = 1;
  }
}
