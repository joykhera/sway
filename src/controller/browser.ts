// Production wiring: real learner + B's worklet player + WebSocket transport to the relay.
import { createPCMPlayer } from '../audio/index.ts';
import * as learner from '../learner/index.ts';
import type { PCMPlayer } from '../shared/protocol.ts';
import { WebSocketTransport, defaultMusicUrl } from '../transport/index.ts';
import { SessionController } from './index.ts';

export type BrowserControllerOptions = {
  player?: PCMPlayer;
  url?: string;
  seed?: number;
};

export function createBrowserController(opts: BrowserControllerOptions = {}): SessionController {
  const url = opts.url ?? defaultMusicUrl(location);
  return new SessionController({
    learner,
    player: opts.player ?? createPCMPlayer(),
    createTransport: () => new WebSocketTransport(url),
    seed: opts.seed,
    // Dev-only: every vote logs the audible-blend estimate, useful when measuring downvote response time.
    log: import.meta.env.DEV ? (event, data) => console.debug('[sway]', event, data) : undefined,
  });
}
