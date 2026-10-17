# Adaptive learning in the main Sway app

Built from team `main` at `0907b71`, pulled before integration. The normal `/` route now uses the adaptive learner; there is no separate demo page or replacement backend.

## Listening experience

Before Start, an optional Focus / Relax / Energy / Explore row provides a weak starting hint. Explore is the default. The original live screen remains the status indicator, breathing ring, thumbs and End Session control.

- A Like holds the estimated heard combination and adds positive evidence when playback is audible.
- A Dislike adds negative evidence and chooses another combination. Early search is broad; supported preferences make nearby changes more likely. Repeated unexpected rejections can reopen search.
- Fresh variations continue every 45 seconds, including after Likes. Holding the same direction does not postpone them indefinitely. A genuine direction change restarts the interval. Variations never invent a preference vote.
- Stop/Start retains this tab's model. Changing purpose while stopped resets it. Reloading resets everything; there are no accounts or saved cross-session profiles.

The model ranks 375 prompt recipes using a regularized joint estimate over 18 features, uncertainty, a weak purpose prior and transition cost. It learns from a whole combination, not a claim that a single Like identifies a favorite instrument. Recovery discounts older evidence after two distinct, sufficiently unexpected negative observations; it is a bounded heuristic, not guaranteed convergence.

## Wiring and preserved infrastructure

`App.tsx` → `createBrowserController()` → `adaptiveLearner` → existing `SessionController` → existing `WebSocketTransport` → existing relay → Lyria. The original AudioWorklet receives the returned PCM. The adapter retains the complete matrix, evidence and recovery state behind the shared learner interface.

The original player architecture, ring buffer, visualizer, transport, relay, provider adapter and Render configuration remain. The player only gains a live AudioContext state diagnostic so suspension cannot count as listening evidence. The controller retains eight one-second ramp steps, ordered steer revisions, buffer-based attribution and reconnect handling. Tempo/key controls and the wire protocol are unchanged. The baseline learner remains available for comparison, but is no longer the browser default.

New controller behavior includes monotonic heard estimates, reconnect evidence gating, explicit novelty steps and a six-second correlation window. Similarity uses normalized total-variation distance below 0.15. Repeated clicks still steer but do not become multiple independent training examples. This timing is an engineering estimate; it does not measure what the listener actually perceived.

`?mock` retains the team's standalone UI-only mock. To exercise the adaptive algorithm without Google, use the normal `/` route with `MUSIC_MODE=mock` on the relay. That relay produces a test tone; it does not demonstrate generated musical quality.

## Run and verify

```sh
pnpm install --frozen-lockfile
MUSIC_MODE=mock pnpm dev
pnpm test
pnpm build
```

For live playback, use the existing server-side `GEMINI_API_KEY` configuration and `MUSIC_MODE=live`. Never place a key in a `VITE_` variable or client code. The production Docker setup is unchanged apart from copying `pnpm-workspace.yaml` before its frozen dependency install.

The workspace override pins the test DOM's `@asamuzakjp/css-color` to 7.1.6 because 7.1.7 was inside the machine's package release-age window. Dependency lifecycle scripts are explicitly disabled; no release-age exception is introduced. The lockfile works with local pnpm 11 and the Dockerfile's pnpm 10.30.3.

Outside localhost, the existing AudioWorklet requires HTTPS. A private Tailscale HTTPS reverse proxy can serve the existing app without replacing its audio player. Plain HTTP on a Tailscale IP is insufficient for this player.

## Evidence and limits

Unit and integration coverage includes full model-state preservation, effective evidence weight, both thumbs, correlated clicks, Likes holding direction, repeated Likes retaining variation deadlines, purpose reset rules, reconnects and real-relay cleanup. The browser factory test catches accidentally wiring the old learner back into the app.

Earlier bounded Lyria recordings and synthetic experiments motivated this algorithm. They do not establish human preference improvement or reliable convergence; noisy feedback remains a known weakness. Persistent profiles, new sensors and an explanatory dashboard are outside this integration.
