// Production wiring: real learner + B's worklet player + WebSocket transport to the relay.
import { createPCMPlayer } from '../audio/index.ts';
import { adaptiveLearner } from '../learner/adaptive/adapter.ts';
import type { ListeningPurpose, PCMPlayer } from '../shared/protocol.ts';
import { WebSocketTransport, defaultMusicUrl } from '../transport/index.ts';
import { SessionController, type ControllerConfig } from './index.ts';

export type BrowserControllerOptions = {
  player?: PCMPlayer;
  url?: string;
  seed?: number;
  purpose?: ListeningPurpose;
  config?: Partial<ControllerConfig>;
};

export function createBrowserController(opts: BrowserControllerOptions = {}): SessionController {
  const url = opts.url ?? defaultMusicUrl(location);
  return new SessionController({
    learner: adaptiveLearner,
    player: opts.player ?? createPCMPlayer(),
    createTransport: () => new WebSocketTransport(url),
    seed: opts.seed,
    purpose: opts.purpose,
    config: opts.config,
    // Dev-only: every vote logs the audible-blend estimate, useful when measuring downvote response time.
    log: import.meta.env.DEV ? (event, data) => console.debug('[sway]', event, JSON.stringify(data)) : undefined,
  });
}
