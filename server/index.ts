import path from 'node:path';
import { createRelay } from './app.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createStreamSlots } from './limits.ts';
import { log, registerSecret } from './log.ts';
import { createLyriaFactory } from './upstream/lyria.ts';
import { createMockFactory } from './upstream/mock.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[config] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
registerSecret(config.apiKey);

const relay = createRelay({
  createUpstream: config.mode === 'live' && config.apiKey ? createLyriaFactory(config.apiKey) : createMockFactory(),
  slots: createStreamSlots(config.maxStreams),
  staticDir: config.production ? path.resolve('dist') : undefined,
});

const port = await relay.listen(config.port);
log.info('server', 'listening', { url: `http://127.0.0.1:${port}`, mode: config.mode, maxStreams: config.maxStreams });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server', 'shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 3000);
  force.unref();
  await relay.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
