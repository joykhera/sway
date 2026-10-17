# Sway

Infinite instrumental music (Google Lyria RealTime) that adapts to 👍 / 👎. Full spec: [docs/HANDOFF.md](docs/HANDOFF.md). The app now uses the [adaptive learner integration](docs/adaptive-integration.md) through the existing UI, controller, worklet player and relay.

## Run

```sh
pnpm install --frozen-lockfile
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

`App.tsx` already uses `createBrowserController()`. Its wiring is:

```ts
import { adaptiveLearner, isAdaptiveState } from './learner/adaptive/adapter.ts';
import { createBrowserPreferencesStore } from './preferences/index.ts';
import { SessionController } from './controller/index.ts';
import { WebSocketTransport, defaultMusicUrl } from './transport/index.ts';

const controller = new SessionController({
  learner: adaptiveLearner,       // full adaptive model behind the shared Learner contract
  player,                        // B's PCMPlayer
  lookahead: true,              // prepared Like/Dislike audio when relay/player support it
  preferences: createBrowserPreferencesStore(),
  restoreState: (value, purpose) => isAdaptiveState(value) && value.purpose === purpose ? value : undefined,
  createTransport: () => new WebSocketTransport(defaultMusicUrl(location)),
  log: import.meta.env.DEV ? console.debug : undefined,
});
// Tap handler: call controller.start() synchronously as the first thing (browser autoplay policy).
```

## Controller behaviour (what D guarantees)

- **Feedback stays available.** Each active-session vote runs `learner.processVote`. A changed target replaces the ramp and sends its first step immediately; an unchanged target preserves the current ramp or held direction. Likes hold the estimated heard blend; Dislikes select another direction using learned preference and uncertainty.
- **Ramp:** 8 steps, one per second (`rampMs` / `stepMs` in `src/controller/config.ts`). Step *k* is a linear blend of the last-sent prompts and the new target, by prompt text; blends below the 0.1 minimum weight are dropped, never sent as 0. Lyria normalizes weights, so only ratios matter.
- **What was audible at click time:** the newest blend we sent at least `buffered ms (+ generationLatencyMs)` ago. The estimated heard timeline cannot move backward when the buffer grows. This remains an estimate, logged on every vote (`log('vote', …)`).
- **Evidence:** feedback before playback, during reconnect, priming or audio suspension has zero learning weight. Judgments of a similar heard blend within six seconds count as at most one weighted observation. Every click still acts on the requested direction.
- **Freshness:** after 45 s the controller calls `learner.evolveNoVote` with an increasing novelty step and ramps to the result. It never creates preference evidence. Likes holding the same direction do not postpone this timer; actual direction changes restart it. Disconnected or inaudible playback pauses variation.
- **Vote while connecting:** the action updates the pending direction immediately with zero learning weight. Before the socket opens, `start` carries the new target. After `start` is sent, the controller ramps to it on `ready`.
- **Reconnect:** on socket close or a retryable relay error, a new socket is opened with backoff (1, 2, 4, 8, 8 s), and `start` carries the **latest target** (no continuity to protect). Learner scores survive. After the schedule is exhausted the status becomes `error`. Relay-side upstream reconnects (`status:'reconnecting'` then a repeated `ready`) pause steering and resume toward the latest direction once playback is ready again.
- **`prompt_filtered`:** the stream keeps playing; the controller moves to another combination via `evolveNoVote` (no score change).
- **Prepared feedback:** while listening, two bounded candidate streams prepare the next Like/Dislike choices. Ready matching audio switches through a 100 ms crossfade; the chosen stream resumes and the next pair is prepared. Actual votes alone update preferences. Slow, stale or failed candidates use the normal ramp. This uses extra generation and up to three provider sessions; `createBrowserController({ lookahead: false })` disables it.
- **Directional Likes:** a Like after a recent, meaningfully different rejected heard blend also learns from the difference. It uses the existing evidence budget, keeps the liked music immediately, and biases future selections toward the approved change. This compares the full musical combination; it does not identify tempo as the cause.
- **Repeated Dislikes:** three distinct, effective rejected heard blends since the last effective Like activate a wider search that changes genre and instrument. Rapid clicks still steer but do not inflate this rejection streak.
- **Purpose:** optional Focus, Relax, Energy, Explore or Crazy supplies a weak starting hint. Crazy adds experimental electronic/percussive phrasing. Each purpose has its own learned model; switching purposes restores that model.
- **Local memory:** IndexedDB saves raw feedback and models across reloads on the same browser/origin. Start waits for bounded restoration; feedback during that brief load is replayed with zero evidence and remains bound to its original profile/session. Export JSON and reset all saved profiles are available before Start. Storage failures preserve playback and show that some changes may not be saved. See [storage details](src/preferences/README.md).

## Tests

| File | Covers |
| --- | --- |
| `src/controller/controller.test.ts` | ramps, strictly increasing revisions, rapid votes superseding, audible estimate, no-vote, pre-ready votes, reconnect, error handling, stop cleanup |
| `src/controller/adaptive-controller.test.ts` | purpose lifecycle, audible evidence gating, correlated clicks, monotonic heard estimates, continued variations after Likes |
| `src/learner/adaptive/*.test.ts` | joint model, exploration, recovery, no-vote invariants, complete-state adapter |
| `tests/e2e/adaptive.integration.test.ts` | actual adaptive learner and browser factory through the controller, transport and real relay with a mock upstream |
| `src/controller/preferences-controller.test.ts` | directional attribution, persistence, profile switching, restore races, failure handling, export/reset |
| `src/preferences/preferences.test.ts`, `tests/browser/preferences-proof.html` | storage validation/failures and real IndexedDB transactions, retention, reload/export |
| `src/controller/blend.test.ts` | prompt/feature interpolation, weight floor |
| `tests/e2e/relay.e2e.test.ts` | controller + `WebSocketTransport` against the real relay (mock upstream): audio, steering, slot release, reconnect, capacity |
| `tests/e2e/harness.ts` | fake relay, player and learner for other lanes to reuse |

Manual acceptance and local run steps: [docs/acceptance.md](docs/acceptance.md).
