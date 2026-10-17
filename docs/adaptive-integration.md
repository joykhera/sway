# Adaptive learning in the main Sway app

The initial integration was merged in PR #8. This update starts from team `main` at `e428399` and adds directional feedback, Crazy and persistent profiles. The normal `/` route now uses the adaptive learner; there is no separate demo page or replacement backend.

## Listening experience

Before Start, an optional Focus / Relax / Energy / Explore / Crazy row provides a weak starting hint. Explore is the default. The original live screen remains the status indicator, breathing ring, thumbs and End Session control.

- A Like holds the estimated heard combination and adds positive evidence when playback is audible. After a recent rejected blend, a meaningfully different liked blend also supplies a before/after comparison that influences future selections.
- A Dislike adds negative evidence and chooses another combination. Early search is broad; supported preferences make nearby changes more likely. Three distinct effective rejected heard blends since the last effective Like activate a broader genre-and-instrument change. Rapid clicks on essentially the same heard music do not escalate this rule. A Like clears that streak; uncertainty and learned preferences still determine subsequent exploration.
- Fresh variations continue every 45 seconds, including after Likes. Holding the same direction does not postpone them indefinitely. A genuine direction change restarts the interval. Variations never invent a preference vote.
- Each purpose has a separate model saved in browser-local IndexedDB. Stop/Start retains it, changing purpose restores its own model, and reloading reconstructs a fresh target from saved preferences. No accounts or cross-device synchronization are provided.
- Crazy requests experimental electronic/synth or percussion sounds, energetic mood and intricate rhythm using a soft starting prior and dedicated phrasing. It changes neither gain nor explicit BPM controls.

The model ranks 375 prompt recipes using a regularized joint estimate over 18 features, uncertainty, a weak purpose prior and transition cost. It learns from a whole combination, not a claim that a single Like identifies a favorite instrument. Recovery discounts older evidence after two distinct, sufficiently unexpected negative observations; it is a bounded heuristic, not guaranteed convergence.

The team's four wording variants per feature are retained for the existing profiles; Crazy adds experimental wording on selected controls. A stable session seed chooses wording for new features, while continuing features keep their exact wording. A mid-transition Like can restore the original wording of an outgoing feature. These variants share the same feature-level preference estimate; finer preferences within a feature are not modeled separately.

## Directional feedback and local memory

The controller compares a Like to the last explicit rejected heard blend only when it is at most 120 seconds old and normalized total-variation distance is at least 0.15. That reference is used once and cleared across Stop/reconnect/profile changes. The learner splits the existing observation weight equally between support for the liked blend and support for its difference from the rejected blend. No extra vote is invented. Several controls can change together, so approval supports the bundled change; it does not establish that faster tempo caused the Like. Tempo is not independently measured here.

IndexedDB stores the complete validated model separately for all five profiles and an append-only feedback history, including zero-evidence clicks. Each model/event write is atomic. Events contain timing, profile, estimated heard blend, before/after targets, effective weight and the optional comparison. The newest 10,000 events are retained across profiles; pruning raw history does not discard learned model state. Export and reset are available on the start screen. Reset clears all profiles and feedback. Storage is limited to this browser and exact origin and may be cleared by the browser; there is no backend collection or backup. See [storage contract](../src/preferences/README.md).

Playback continues when storage is unavailable. Failed restoration prevents writes from overwriting unread profiles; failed saves produce an incomplete-save status. While restoration runs, explicit profile selection wins over saved selection, and pending feedback remains attached to its originating profile/session with zero evidence. No comparison anchor persists across sessions. Concurrent tabs are not a synchronized multi-writer model.

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

Unit and integration coverage includes full model-state preservation, effective evidence weight, both thumbs, correlated clicks, Likes holding direction, repeated Likes retaining variation deadlines, purpose restoration rules, reconnects and real-relay cleanup. The browser factory test catches accidentally wiring the old learner back into the app.

Earlier bounded Lyria recordings and synthetic experiments motivated this algorithm. They do not establish human preference improvement or reliable convergence; noisy feedback remains a known weakness. New sensors, cross-device synchronization and an explanatory dashboard remain outside this integration.

## Earlier integration verification — 2026-10-17

- Final combined code: **321 tests across 34 files**, TypeScript and production build passed. Frozen installs passed on pnpm 11 and deployment-pinned pnpm 10.30.3. The generated client bundle contains no supplied API credential.
- Chrome exercised the actual UI, controller, AudioWorklet, transport and relay, first with a mock provider and then one bounded Google session. The real stream ran for about 66 seconds from Start to Stop, returned 48 kHz stereo, redirected ambient/synth toward jazz/guitar after Dislike, held after Like, then changed texture automatically. Sixteen ordered steer messages completed both ramps; no filter or reconnect was observed. This verifies controls and transport, not perceived sound quality.
- That live check preceded the teammate phrasing merge. The merged variant renderer passed deterministic regressions, full tests and a production-browser mock check. After the user's HTTP follow-up, a separate 16-second capped Google check verified the app over the actual Tailscale HTTP address with the scheduled-buffer fallback. It reached playing, received 48 kHz stereo and accepted feedback without browser warnings/errors. These live checks preceded the final `1ffed8c` merge; its shared 2.75/1.75-second buffer defaults were verified by automated tests and build, not another Google session.
- HTTP mock-browser checks covered Start, both thumbs, Stop and restart with retained purpose. Fifteen new fallback tests cover split frames, source rates, buffer limits, suspension and init/close races; ten factory tests protect selection and custom injections. Independent review also checked delayed source cleanup. Cross-device access, mobile rendering, a Linux Docker image build and long-session human listening are not claimed as verified.

The localhost preview uses `MUSIC_MODE=mock` through the production server. The private Tailscale preview uses the same built app and existing relay/provider via an external machine-local host, with one stream. The user subsequently requested removing the demo time limits; its dedicated launcher now explicitly disables both session and aggregate time caps. Bounded defaults remain available for separate agent experiments. It rejects unrelated WebSocket origins and disables automatic provider retries. Mock proof verified all runtime caps, terminal errors, post-budget rejection and cleanup; no team server source was replaced. The two agent-run live checks used roughly 82 seconds of provider-session wall time in total. Credential, runtime host, logs and screenshots remain outside Git. Public deployment is outside the scope of this integration.


## Directional preference update verification — 2026-10-17

- All **367 tests across 37 files**, TypeScript and production build pass. No runtime dependency, server protocol, audio implementation or deployment configuration changed in this update.
- Twelve real-browser IndexedDB checks pass, including profile separation, selection, bounded event retention, export, atomic duplicate-ID rollback, clear and reuse.
- The actual app with a mock provider saved a Crazy Dislike and a later Like, restored Crazy and two votes after reload, and exported both records. The Like contains its rejected reference and the restored model contains 0.5 pairwise evidence. This verifies end-to-end attribution and persistence, not acoustic preference improvement.
- The production app over Tailscale HTTP reached playing with the scheduled-buffer fallback, saved feedback and restored the selected profile/count. The normal localhost path also exercised AudioWorklet. No Google generation was used for this update.
- Fixed synthetic fixtures show future energetic/rhythmic selection changing after approved exploration and the three-rejection genre/instrument escape. These are policy checks, not evidence of human convergence or that the learner beats a simpler baseline. Human listening validation remains necessary.
