# Adaptive learning in the main Sway app

Built from team `main` at `0907b71`, pulled before integration, then merged teammate updates through `1ffed8c`, including prompt phrasing, buffering, error recovery and Docker build fixes, before final verification. The normal `/` route now uses the adaptive learner; there is no separate demo page or replacement backend.

## Listening experience

Before Start, an optional Focus / Relax / Energy / Explore row provides a weak starting hint. Explore is the default. The original live screen remains the status indicator, breathing ring, thumbs and End Session control.

- A Like holds the estimated heard combination and adds positive evidence when playback is audible.
- A Dislike adds negative evidence and chooses another combination. Early search is broad; supported preferences make nearby changes more likely. Repeated unexpected rejections can reopen search.
- Fresh variations continue every 45 seconds, including after Likes. Holding the same direction does not postpone them indefinitely. A genuine direction change restarts the interval. Variations never invent a preference vote.
- Stop/Start retains this tab's model. Changing purpose while stopped resets it. Reloading resets everything; there are no accounts or saved cross-session profiles.

The model ranks 375 prompt recipes using a regularized joint estimate over 18 features, uncertainty, a weak purpose prior and transition cost. It learns from a whole combination, not a claim that a single Like identifies a favorite instrument. Recovery discounts older evidence after two distinct, sufficiently unexpected negative observations; it is a bounded heuristic, not guaranteed convergence.

The team's four wording variants per feature are retained. A stable session seed chooses wording for new features, while continuing features keep their exact wording. A mid-transition Like can restore the original wording of an outgoing feature. These variants share the same feature-level preference estimate; finer preferences within a feature are not modeled separately.

## Wiring and preserved infrastructure

`App.tsx` → `createBrowserController()` → `adaptiveLearner` → existing `SessionController` → existing `WebSocketTransport` → existing relay → Lyria. The original AudioWorklet, or the HTTP-compatible scheduled-buffer fallback, receives the returned PCM. The adapter retains the complete matrix, evidence and recovery state behind the shared learner interface.

The original worklet architecture, ring buffer, visualizer, transport, relay, provider adapter and Render configuration remain. The player gains a live AudioContext state diagnostic so suspension cannot count as listening evidence. An additional scheduled-buffer player supports HTTP origins, selected automatically only when secure-context worklet capabilities are unavailable. The controller retains eight one-second ramp steps, ordered steer revisions, buffer-based attribution and reconnect handling. Tempo/key controls and the wire protocol are unchanged. The baseline learner remains available for comparison, but is no longer the browser default.

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

The factory keeps the existing AudioWorklet on capable HTTPS/localhost contexts. On ordinary HTTP, it uses AudioContext and scheduled AudioBufferSourceNodes, because [AudioWorklet requires a secure context](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet). No browser security setting or HTTPS exception is needed. The fallback shares the PCM interface and learner-facing buffer/suspension diagnostics. It uses a 2.75-second initial buffer, a 1.75-second re-prime, a 20-second queue cap, and native source-rate resampling. Main-thread scheduling can be more sensitive to a busy tab; long-session perceptual quality remains unmeasured.

## Evidence and limits

Unit and integration coverage includes full model-state preservation, effective evidence weight, both thumbs, correlated clicks, Likes holding direction, repeated Likes retaining variation deadlines, purpose reset rules, reconnects and real-relay cleanup. The browser factory test catches accidentally wiring the old learner back into the app.

Earlier bounded Lyria recordings and synthetic experiments motivated this algorithm. They do not establish human preference improvement or reliable convergence; noisy feedback remains a known weakness. Persistent profiles, new sensors and an explanatory dashboard are outside this integration.

## Verification receipt — 2026-10-17

- Final combined code: **321 tests across 34 files**, TypeScript and production build passed. Frozen installs passed on pnpm 11 and deployment-pinned pnpm 10.30.3. The generated client bundle contains no supplied API credential.
- Chrome exercised the actual UI, controller, AudioWorklet, transport and relay, first with a mock provider and then one bounded Google session. The real stream ran for about 66 seconds from Start to Stop, returned 48 kHz stereo, redirected ambient/synth toward jazz/guitar after Dislike, held after Like, then changed texture automatically. Sixteen ordered steer messages completed both ramps; no filter or reconnect was observed. This verifies controls and transport, not perceived sound quality.
- That live check preceded the teammate phrasing merge. The merged variant renderer passed deterministic regressions, full tests and a production-browser mock check. After the user's HTTP follow-up, a separate 16-second capped Google check verified the app over the actual Tailscale HTTP address with the scheduled-buffer fallback. It reached playing, received 48 kHz stereo and accepted feedback without browser warnings/errors. These live checks preceded the final `1ffed8c` merge; its shared 2.75/1.75-second buffer defaults were verified by automated tests and build, not another Google session.
- HTTP mock-browser checks covered Start, both thumbs, Stop and restart with retained purpose. Fifteen new fallback tests cover split frames, source rates, buffer limits, suspension and init/close races; ten factory tests protect selection and custom injections. Independent review also checked delayed source cleanup. Cross-device access, mobile rendering, a Linux Docker image build and long-session human listening are not claimed as verified.

The localhost preview uses `MUSIC_MODE=mock` through the production server. The private Tailscale preview uses the same built app and existing relay/provider via an external machine-local host, with one stream, 90 seconds per session and 180 seconds total listening time. It rejects unrelated WebSocket origins and disables automatic provider retries. Mock proof verified all runtime caps, terminal errors, post-budget rejection and cleanup; no team server source was replaced. The two agent-run live checks used roughly 82 seconds of provider-session wall time in total. Credential, runtime host, logs and screenshots remain outside Git. Public deployment is outside the scope of this integration.
