# Sway

Infinite instrumental music (Google Lyria RealTime) that adapts to 👍 / 👎. Full spec: [docs/HANDOFF.md](docs/HANDOFF.md).

## Run

```sh
pnpm install
cp .env.example .env     # GEMINI_API_KEY for live mode; or set MUSIC_MODE=mock for a test tone
pnpm dev                 # vite + relay (the dev server proxies /api/music)
pnpm test                # unit + integration (includes the relay e2e, mock mode, no Google calls)
pnpm typecheck
pnpm smoke               # live Lyria smoke test (A), see docs/lyria-smoke-report.md
```

## How the pieces connect

```
UI (B)  ──vote()/start()/stop()──▶  SessionController (D, src/controller)
                                      ├─ Learner (C)   processVote / evolveNoVote → Target
                                      ├─ PCMPlayer (B) configure / enqueuePcm / getBufferedDurationMs
                                      └─ MusicTransport (D, src/transport) ⇄ relay (A, server/) ⇄ Lyria
```

Wiring (in B's `App.tsx` once the learner and player exist):

```ts
import * as learner from './learner/index.ts';
import { SessionController } from './controller/index.ts';
import { WebSocketTransport, defaultMusicUrl } from './transport/index.ts';

const controller = new SessionController({
  learner,                       // must satisfy `Learner` in shared/protocol.ts
  player,                        // B's PCMPlayer
  createTransport: () => new WebSocketTransport(defaultMusicUrl(location)),
  log: import.meta.env.DEV ? console.debug : undefined,
});
// Tap handler: call controller.start() synchronously as the first thing (browser autoplay policy).
```

## Controller behaviour (what D guarantees)

- **Votes are never queued or locked out.** Each vote runs `learner.processVote`, supersedes any ramp in flight, and sends the first step of the new ramp immediately.
- **Ramp:** 8 steps, one per second (`rampMs` / `stepMs` in `src/controller/config.ts`). Step *k* is a linear blend of the last-sent prompts and the new target, by prompt text; blends below the 0.1 minimum weight are dropped, never sent as 0. Lyria normalizes weights, so only ratios matter.
- **What was audible at click time:** the newest blend we sent at least `buffered ms (+ generationLatencyMs)` ago. This is an estimate, logged on every vote (`log('vote', …)`).
- **Silence:** after 45 s without a vote the controller calls `learner.evolveNoVote` and ramps to the result. It never calls the score-updating path. Any vote restarts the timer.
- **Vote while connecting:** the learner updates at once. Before the socket opens, `start` carries the new target. After `start` is sent, the controller ramps to it on `ready`.
- **Reconnect:** on socket close or a retryable relay error, a new socket is opened with backoff (1, 2, 4, 8, 8 s), and `start` carries the **latest target** (no continuity to protect). Learner scores survive. After the schedule is exhausted the status becomes `error`. Relay-side upstream reconnects (`status:'reconnecting'` then a repeated `ready`) are handled without restarting ramps.
- **`prompt_filtered`:** the stream keeps playing; the controller moves to another combination via `evolveNoVote` (no score change).
- **Refresh** resets everything (no persistence, by design).

## Tests

| File | Covers |
| --- | --- |
| `src/controller/controller.test.ts` | ramps, strictly increasing revisions, rapid votes superseding, audible estimate, no-vote, pre-ready votes, reconnect, error handling, stop cleanup |
| `src/controller/blend.test.ts` | prompt/feature interpolation, weight floor |
| `tests/e2e/relay.e2e.test.ts` | controller + `WebSocketTransport` against the real relay (mock upstream): audio, steering, slot release, reconnect, capacity |
| `tests/e2e/harness.ts` | fake relay, player and learner for other lanes to reuse |

Manual acceptance and local run steps: [docs/acceptance.md](docs/acceptance.md).
