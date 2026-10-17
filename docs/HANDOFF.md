# Personalized Infinite Music — MVP Build Handoff

**Status:** In progress. Lyria RealTime access is verified live and A's relay is on `main` (see §0)  
**Prepared:** 2026-10-17 · **Updated:** 2026-10-17 (after A's research, grilling and first live runs)  
**Audience:** Four developers working in parallel  
**Product goal:** Test whether an infinite instrumental music stream can learn a listener's taste using only thumbs-up and thumbs-down, and change the music in response without interrupting playback.

> **Read this first:** This is intentionally a *small experimental MVP*, not a production streaming service or a full reinforcement-learning training pipeline. Ship the complete real-time feedback loop before considering LLM-based personalization, cross-user music sharing, accounts, databases, or sophisticated ML.

---

## 0. Status update — 2026-10-17 (read this before the rest)

**What's on `main`:**

| Item | State |
|---|---|
| Repo scaffold | Single pnpm package: Vite + React + TS, Node relay run by `tsx`, Vitest. Owner stubs in `src/{ui,audio,learner,controller,transport}`. `pnpm dev` runs Vite and the relay; Vite proxies `/api/music` to the relay on `127.0.0.1:8787`. |
| `src/shared/protocol.ts` | Copied from §5 plus an `ErrorCode` union, an `AudioFormat` type, and constants `MUSIC_WS_PATH`, `WEIGHT_MIN`, `WEIGHT_MAX`. **D owns it from here; please review.** |
| A: relay (`server/**`) | Done and **verified against live Lyria**: start → `ready` → binary PCM → steer → stop. MUSIC_MODE=mock gives a paced tone for keyless dev and tests. 69 tests pass. |
| A: smoke test (`pnpm smoke`) | Works live. Results are in `docs/lyria-smoke-report.md`. All questions are answered except how long a steer takes to be heard, which needs a listening pass. |
| A's plan / decisions | `docs/part-a-plan.md` |
| D: controller + transport | **Done and merged to `main`** (PR #1). `SessionController` (`src/controller`), `WebSocketTransport` (`src/transport`), contracts for `Learner`, `PCMPlayer`, `MusicSessionController` added to `protocol.ts`, plus unit and relay e2e tests (129 tests green across the repo). See README for the wiring snippet. |

**Setup for everyone:** `pnpm install`, `cp .env.example .env`, add your **own** `GEMINI_API_KEY` from aistudio.google.com/apikey (each key belongs to a separate project, so each gets its own quota). Without a key, set `MUSIC_MODE=mock`.

**Verified live facts (they override older text below):**
- Lyria **rejects `sampleRateHz`**: the session closes with code 1007 `Unknown name "sampleRateHz"`. Output is fixed at **48 kHz stereo s16le**, and every chunk carries mimeType `audio/l16;rate=48000;channels=2`.
- Audio arrives in **exactly 2.0 s chunks (384,000 B) about every 2 s, at ~1.0x realtime**, with a steady ~1.8 s lead. There is no run-ahead, so no relay pacing is needed.
- `setupComplete` comes ~0.9 s after connect. First audio comes **~3.8 s after `play()`**. The relay sends `ready` ~5.8 s after the browser's `start`.
- **Weights are normalized server-side to sum to 1** (SDK docs), so only *ratios* matter. Scaling every weight up together does nothing.
- Ephemeral tokens don't work for Lyria (Google staff, Aug 2025), so the relay is required.
- The SDK puts the API key in the upstream URL. The relay redacts it from all logs.
- **Sessions are hard-capped at 10:00** with no warning. The server closes with code **1011** "The service is currently unavailable." (misleading). The relay already reconnects on it, which costs ~5 s of silence and a musical re-settle every 10 minutes.
- **At least 5 concurrent sessions** work on one free key (5/5 tested). First audio comes 3.8–5.3 s after `play()`.
- **Unverified:** free-tier quota (Google publishes none; check aistudio.google.com/rate-limit), and how long until a steer is *audible* (needs a listening pass on the 12-minute WAV).

**Decisions made since the original handoff:**
- **Localhost only** for the MVP: no deploy and no access gate. The relay binds `127.0.0.1`.
- **Mobile is out of scope** for the MVP. AudioWorklet needs https or localhost, so phones would need a tunnel.
- **Everyone works on `main`** (pull with rebase, then push). No `feat/*` branches.
- **10-min cap:** on an upstream drop the relay sends `status:'reconnecting'`, reopens with the latest prompts and sends a **fresh `ready`**. The browser socket stays open, with a 5–10 s re-settle. Seamless rotation comes later, only if testers complain.
- **Guards trimmed:** validation, a 5-stream cap and cleanup only. No byte caps or rate limits until there's a public URL.

**D status update (later 2026-10-17):**
- D's controller, transport and wiring are on `main` (PRs #1, #4). Latency fix (2.5 s audible-estimate lag) and the start/stop race guard are on `main` too.
- C extended the controller in PR #8 (evidence weighting so repeated clicks on a similar blend count once, learning and novelty gated on audible output, relay-side reconnect handling, optional listening purpose) and the app now ships `adaptiveLearner` (`src/learner/adaptive/`). D reviewed it: no blocker found; D did not read the adaptive model internals.
- **Manual acceptance (live Lyria, Pavan):** tests 1-8 pass. Cold start 5-6 s; downvote change noticeable at about 8-9 s, smooth (target 5-15 s); upvote leans gradually; rapid votes fine. Tests 5-8 (passive 10 min, reconnect at the cap, refresh, security) also pass, as reported by Pavan without measurements; D separately confirmed no API key (value or name) appears in a production bundle. All eight manual acceptance tests pass. See `docs/acceptance.md`.
- Hackathon track (self-improving Nemotron team, `tools/selfimprove/`, not yet on `main`): two pre-registered runs, both negative on improvement (run 1 sealed test: gen1 33.1% vs gen0 33.6%, no gain; run 2: no variant passed the gate). Note both runs evaluate the pre-PR-#8 deterministic learner, not the shipped adaptive one.

**D status (2026-10-17):**
- Reviewed `protocol.ts`: `ErrorCode` accepted as proposed. Added the learner, player and controller contracts (additive, no change to existing types).
- Controller handles repeated `ready`, relay-side `reconnecting`, `prompt_filtered` (stream keeps playing, retargets without learning), retryable errors (new socket, backoff, restarts from latest target) and non-retryable errors (status `error`).
- Revisions: the controller keeps counting across reconnects (always increasing, which the reset-on-`start` rule allows).
- Checked against A's relay in mock mode (`tests/e2e/relay.e2e.test.ts`). **Not yet done:** the live Lyria run and the measured downvote latency, which need B's player and C's learner.
- **C's learner is on `main` and works with the controller (Checkpoint 2 passed):** `tests/e2e/learner.integration.test.ts` drives it through 200 simulated votes. Every prompt set is valid (weights within 0.1–2.0, never empty), revisions strictly increase, and runs are reproducible per seed.
- **Blocked on:** B (`src/audio` must satisfy `PCMPlayer`; nothing pushed yet). Until then tests use the fake player in `tests/e2e/harness.ts`; reuse it. Live Lyria and the downvote latency measurement wait on B.

**Action items by owner:**
- **B:** (1) The jitter buffer must hold **≥2.5–3 s** before playback starts. Audio arrives in 2 s blocks, so 0.5–1.5 s will underrun. (2) `ready` can arrive **again** after `reconnecting`; reconfigure without double-playing. (3) Drop the mobile checks.
- **C:** Only weight ratios matter. "Amplify" a liked feature by raising it *relative to the others*. Keep 2–3+ prompts and separate instrument prompts from mood prompts (Google's prompt guide).
- **D:** Review the `protocol.ts` additions. Handle a repeated `ready`, `error.code` values from `ErrorCode`, and `upstream_lost` (the socket stays open, so you can send `start` again). Revisions reset on each `start`. Expect ~6 s from `start` to first sound, and plan the start UI around it.

---

## 1. Product decisions — settled, do not reopen without a blocker

| Topic | Decision |
| --- | --- |
| Experience | Infinite, continuously evolving instrumental music; not a playlist of discrete songs |
| Audience | 1–5 simultaneous testers, a few hours of usage |
| Access | Web app for desktop browsers on localhost (~~mobile~~ out of scope for MVP, see §0) |
| UI | Music playback plus **👍** and **👎**. A necessary initial tap to enable audio is acceptable due to browser autoplay restrictions; error/reconnect notices may appear |
| Feedback signals | **Explicit thumbs only**. No skip button, surveys, sliders, behavioral inference, or implicit preference updates |
| Thumbs up | Reinforce the *currently audible* characteristics and gradually amplify those qualities, within safe limits |
| Thumbs down | Learn from current characteristics; choose a meaningfully different target and steer there smoothly |
| Response | A noticeably different musical direction after a downvote, aiming for **5–15 seconds** without restarting audio. This is a target to measure, not an API guarantee |
| Multiple votes | Always accept immediately; the most recent feedback changes the active target, even during a prior transition |
| No vote | Slowly evolve within current style; **do not** interpret silence as liking or disliking |
| Musical scope | Broad instrumental space: ambient, lo-fi, jazz, electronic, classical; instruments, moods, textures |
| Exploration | Mostly change one or two characteristics; occasionally try a much different combination; stay close to positively rated styles |
| Persistence | ~~Session only~~ **Changed 2026-10-17 (decision: Pavan, via PR #10; Joy and Xueming to confirm):** preferences are saved **locally in the browser (IndexedDB, per listening purpose)** and restored on refresh. No server storage, no accounts. A raw per-click feedback log (up to 10,000 records, exportable) is also kept locally, which supersedes the earlier "no listening logs" rule for local browser storage only. There is a reset path (`resetPreferences()`) |
| Deployment | **Hosted music API**, no self-hosted music model or GPUs. The relay runs **locally** (`127.0.0.1`) and each dev uses their own key. No hosted deploy for the MVP |
| Multiuser sharing | Defer cross-user reuse/caching. For MVP, one Lyria session per tester is simpler |
| Runtime general-purpose LLM | **Not required for baseline**. Treat LLM-guided exploration as an optional controlled experiment, not a launch dependency |
| Core question | Does explicit binary feedback improve the *perceived* relevance of the ongoing soundscape over repeated iterations? |

### What is explicitly OUT of scope

Sign-in, subscription/billing, user profiles, server-side preference persistence, track library, cross-user reuse, server-side logs of listening behavior, skip, like history, text prompting, editing, export, cross-fades between different tracks, recommender embeddings, training/fine-tuning a foundation model, multi-agent orchestration, social features, playlists, native apps, moderation dashboard, complex observability.

### Critical distinction

Lyria generates audio. Our application chooses **music directions** (weighted prompts) based on votes. A thumbs-down does **not** prove which individual feature the listener disliked. Our learner accumulates uncertain evidence through repeated experiments.

---

## 2. Model/API decision

### Primary: Google **Lyria RealTime**

- Model in the documentation: `models/lyria-realtime-exp` (experimental; verify current access before implementation).
- Maintains a bidirectional WebSocket music session and continuously returns audio chunks.
- Supports live `WeightedPrompt` updates for genres, instruments, and moods, plus configuration controls such as density/brightness.
- Provider advises intermediate weight updates for smoother transitions. Major changes to BPM or key/scale require context reset and may cause hard transitions: **do not dynamically change them in v1**.
- Instrumental-only by design, fitting our product.
- Google documentation labels it experimental/preview: availability, quotas, pricing, and API shapes must be rechecked at implementation time.

**Why not ElevenLabs Music, Stable Audio, ACE-Step for v1?** These are valid music-generation options but are less clearly designed for continually steerable, live musical control. Our differentiator is responsive music changes within an ongoing stream, not editing or maximizing full-song output quality.

### Official implementation references

1. [Lyria RealTime guide](https://ai.google.dev/gemini-api/docs/realtime-music-generation)
2. [Lyria prompt guide](https://ai.google.dev/gemini-api/docs/lyria-prompt-guide)
3. [Live Music WebSocket reference](https://ai.google.dev/api/live_music)
4. [Google Gemini cookbook: Lyria RealTime quickstart](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_LyriaRealTime.ipynb)
5. [Google Live API ephemeral token documentation](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) — **not proof** that ephemeral tokens work for the separate Live Music endpoint.

**Known documentation inconsistency (resolved 2026-10-17):** The JS example's `sampleRateHz: 44100` is **rejected** by the API (close 1007). Output is **48 kHz stereo s16le**, confirmed by each chunk's mimeType. The relay reads the rate from the mimeType and passes it in `ready`.

**Integration risk:** A browser must not contain an unrestricted Gemini API key. Ephemeral tokens are confirmed **not** to work for Lyria (Google staff, Aug 2025), so build a tiny backend WebSocket relay holding `GEMINI_API_KEY`. This is not AI infrastructure or GPU hosting; it is ordinary minimal app hosting.

---

## 3. Architecture

```text
Browser (React + TypeScript)
  ├── Player UI: one-time Start tap, then audio + thumbs up/down
  ├── PCM player: Web Audio / AudioWorklet + short jitter buffer
  ├── Session controller: vote handling, transition ramp, status
  └── Preference learner: in-memory scores + candidate selector
          │
          │ WebSocket: text control messages + binary PCM audio
          ▼
Tiny Node WebSocket relay (API key stays server-side)
          │
          │ @google/genai Live Music session
          ▼
Google Lyria RealTime
```

**One browser tab = one session = one Lyria connection.** Closing/disconnecting cleans it up. No DB required.

Recommended project: **pnpm monorepo or a single Vite/Node TypeScript repository**, but do not invest time in sophisticated tooling. Use `@google/genai`, React, Vite, `ws` (or a comparable WebSocket library), Vitest, and a tiny Node server. A managed Node deployment can serve the frontend and relay in one service. Keep API keys server-side. Browser autoplay needs a user gesture.

---

## 4. Four-person parallel work split (strict ownership)

**Integration rule: commit the shared protocol/types below before parallel development.** Teams should mock each other's dependencies and not edit one another's owned modules. Each person owns tests for their area. Work begins in parallel after a 15-minute contract review.

| Developer | Owns | Core outcome | Must NOT own |
| --- | --- | --- | --- |
| **A — Lyria / backend transport** | `server/**` | Secure relay; start/steer/stop Lyria; PCM audio forwarding; error and cleanup handling | Preference rules, React UI, frontend vote controller |
| **B — Frontend / audio** | `src/ui/**`, `src/audio/**`, `src/App.tsx` | Responsive player and thumbs; buffer and play continuous PCM in browsers; UI states | Lyria API server, learner internals |
| **C — Preference intelligence** | `src/learner/**` | Deterministic, seeded, pure-function learning; exploration and prompt targets; unit tests | WebSocket, UI, scheduling |
| **D — Session orchestration / verification** | `src/controller/**`, `src/transport/**`, `tests/e2e/**`, docs | Wire learner to votes and relay; time transitions; handle rapid votes; mocks/integration tests and deploy checklist | Internals owned by A/B/C |

**Shared source file:** `src/shared/protocol.ts` — frozen and owned initially by D, reviewed by A/B/C before they start. Any change is a small PR explicitly approved by affected owners. Keep imported shared types browser-safe (no Node dependencies).

### Developer A: Backend / Lyria integration

> **Status 2026-10-17:** Tasks 1–7, 9 and 10 (partly) are done and verified live. Task 8 is trimmed for localhost (5-stream cap and validation only). Remaining: the 12-minute cap run, the concurrency probe, and steer-latency listening notes.

**Tasks**

1. Stand up a Node HTTPS-capable host or local HTTP dev server with an upgraded WebSocket path `/api/music`.
2. Validate `GEMINI_API_KEY` at process start; never send it to browsers.
3. Connect using official `@google/genai` Live Music SDK if it works under Node. Prefer the SDK over a handcrafted wire protocol.
4. For `start`, create one upstream session, send initial weighted prompts and configuration, then `play()`; send `ready` only when format/setup are known.
5. For `steer`, send latest valid full prompt set; ignore stale revisions and discard superseded queued updates.
6. Forward received raw PCM chunks as **binary WebSocket frames** to client; avoid putting base64 in JSON if you already have bytes.
7. For `stop`/disconnect/error, close upstream session, free all handlers and timers, and report status.
8. Add simple protective controls: at most 5 simultaneous upstream streams, per-connection time/byte limits, no public unauthenticated open proxy; private beta access restriction or deployment-level access gate.
9. Offer a **mock audio mode** that emits deterministic PCM (e.g., a test tone or fixture) with no Google calls, for B/D to develop in parallel.
10. Smoke test live 3–5 minute streaming and one small and one substantial prompt adjustment. Capture verified sample format, initial buffering, errors, and whether API access exists.

**Definition of done:** B can connect to a mock or live relay and play uninterrupted PCM; `steer` changes upstream prompt weights; the secret is never shipped to client; all stream resources close on disconnect. Document verified sample rate and provider-specific quirks.

### Developer B: Player and responsive UI

**Tasks**

1. Build single-page responsive interface with a centered waveform/now-playing indication and two obvious thumbs controls.
2. Start audio from first user tap; expose a clear start state to accommodate browser autoplay policy. No complex player controls.
3. Implement an `AudioWorklet` or equivalent streaming PCM player: interleaved stereo signed 16-bit little-endian bytes → float buffers; preserve stereo; handle browser `AudioContext` sample-rate mismatch by resampling.
4. Keep a jitter buffer and track buffered milliseconds. ~~0.5–1.5 s~~ **Lyria sends 2 s blocks every ~2 s, so start playback at ≥2.5–3 s buffered** and tune down only if no dropouts occur.
5. Expose functions/event listeners per interfaces below so D can attach the real controller; develop initially against mock stream and mock click handlers.
6. Show only minimal non-intrusive status: connecting, playing, reconnecting, API unavailable. Thumb buttons must stay responsive during transitions.
7. Verify Chrome desktop (plus Safari/Firefox desktop if time allows; mobile is out of scope). Audio must not double-play after remounts, reconnections or a repeated `ready`.

**Definition of done:** A mock PCM stream plays continuously; visible thumbs invoke callbacks without blocking; mobile playback starts on a gesture; player is robust to irregular audio chunk sizes.

### Developer C: Preference learner

**Tasks**

1. Implement the fixed feature vocabulary, initial randomized combination and reproducible seeded RNG.
2. Implement `learn(state, audibleFeatures, vote)` as a pure function with bounded evidence scores.
3. Implement `chooseNextTarget(state, current, vote, rng)` with mostly local moves and occasionally broad exploration.
4. Implement `amplifyLikedTarget(...)` for thumbs-up: emphasize presently active liked qualities gradually, cap intensity, do not restart playback.
5. Implement `evolveWithoutFeedback(...)` to produce a small change within the active musical style, **without modifying learned scores**.
6. Convert feature targets into validated Lyria `WeightedPrompt[]` values: one or two genres, one or two instruments, one mood, one texture; nonzero weights; avoid contradictory combinations.
7. Write deterministic unit tests demonstrating scores increase/decrease correctly, all weights are valid, broad exploration occurs occasionally, repeated likes don't diverge, and no-vote never changes preference scores.

**Definition of done:** D can call one typed function per vote and get a valid music target immediately, with no side effects or network requirements.

### Developer D: Session controller, integration, and validation

**Tasks**

1. Freeze protocol and frontend abstractions; commit stubs so A/B/C compile before any work is merged.
2. Implement browser WebSocket transport: parse JSON status frames, route binary frames to B's player, send start/steer/stop controls to A; handle close/error/reconnect.
3. Maintain live state: current audible estimate, latest target, interpolation start, transition revision, last vote, feature learner state.
4. On click, immediately update C's learner using the **best available estimate of what was audible at click time**; calculate a new target and supersede old transition. Never queue votes until transition end.
5. Interpolate prompt weights from *current estimated blend* toward target over an 8-second initial ramp; send throttled updates (e.g., once per second). Do not reset Lyria context for these prompt changes.
6. On no vote, evolve only sound direction at a low cadence (e.g., 45 seconds) without treating silence as positive feedback.
7. On reconnect, restore **the session's in-memory preference scores** (same tab until refresh) but accept that musical continuity may be temporarily interrupted; do not automatically carry preferences across refresh.
8. Build test harness with A's mock PCM and C's seeded learner; test mid-ramp repeated votes and 5–15-second changes.
9. Assemble smoke test instructions, deployment `.env.example`, acceptance criteria and a short README. Coordinate release integration.

**Definition of done:** End-to-end button → learner → weighted prompts → live audio works, including rapid thumbs, while the UI stays responsive.

---

## 5. Shared contracts (freeze before coding)

File: `src/shared/protocol.ts`. This is an **application protocol** between browser and relay, **not** Google's wire protocol. Developer A translates to SDK calls.

```ts
export type Vote = 'up' | 'down';

export type WeightedPrompt = { text: string; weight: number };

export type StreamConfig = {
  density?: number;     // 0..1, optional
  brightness?: number;  // 0..1, optional
  temperature?: number; // use provider defaults initially
};

export type ClientMessage =
  | { type: 'start'; prompts: WeightedPrompt[]; config?: StreamConfig }
  | { type: 'steer'; revision: number; prompts: WeightedPrompt[]; config?: StreamConfig }
  | { type: 'stop' };

export type ServerMessage =
  | { type: 'status'; state: 'connecting' | 'playing' | 'reconnecting' | 'stopped' }
  | { type: 'ready'; audio: { format: 'pcm_s16le'; sampleRateHz: number; channels: 2 } }
  | { type: 'error'; code: string; message: string; retryable: boolean };

// Audio chunks from server are raw BINARY WebSocket frames, not ServerMessage.
```

**Contract details:**

- `start` must precede `steer`. `ready` identifies the actual audio format (48 kHz stereo in practice). **`ready` may be sent again after `status:'reconnecting'`.**
- `steer` represents an entire desired prompt set, not a delta. Revisions increase monotonically **within one stream and reset on each `start`**. The server ignores old revisions and coalesces steers to at most one upstream update per 200 ms (newest wins).
- `error.code` is one of `bad_message | bad_state | capacity | upstream_unavailable | upstream_lost | prompt_filtered | internal`. After `upstream_lost` (3 failed reconnects), the socket stays open and the client may send `start` again.
- Lyria normalizes weights to sum to 1, so **only ratios between prompts matter**.
- Server validates each prompt (`text` nonempty, finite numeric `weight` **not 0**); clamp to an agreed safe range, initially 0.1–2.0; omit rather than send weight 0.
- Browser `vote` is a local event consumed by D, **not a direct backend message**. Browser computes the target via C before sending `steer`.
- Prompts should not include arbitrary user text; they're drawn from the fixed vocabulary for v1.
- Client must know the verified sample rate before playback. Do not intermix JSON status with binary PCM incorrectly.
- If config changes, remember Lyria API expects a full config message. To minimize risk, keep density/brightness fixed initially and primarily steer by weighted prompts.

### Learner API (frozen proposal)

```ts
export type FeatureId = string; // specific union defined in learner/vocabulary.ts
export type FeatureBlend = Record<FeatureId, number>; // missing feature = 0
export type LearnerState = {
  scores: Record<FeatureId, number>;
  votes: number;
  seed: number;
};
export type Target = {
  features: FeatureBlend;
  prompts: WeightedPrompt[];
};

export function createLearner(seed: number): LearnerState;
export function initialTarget(state: LearnerState): Target;
export function processVote(args: {
  state: LearnerState;
  audible: FeatureBlend;
  currentTarget: Target;
  vote: Vote;
}): { state: LearnerState; target: Target };
export function evolveNoVote(args: {
  state: LearnerState;
  target: Target;
}): Target;  // must not mutate state.scores
```

If implementation strongly prefers a different function layout, C and D decide **before** merging; these semantics are required.

### Playback abstraction (B exposes to D)

```ts
export interface PCMPlayer {
  initializeFromUserGesture(): Promise<void>;
  configure(audio: { sampleRateHz: number; channels: 2; format: 'pcm_s16le' }): void;
  enqueuePcm(bytes: ArrayBuffer): void;
  getBufferedDurationMs(): number;
  close(): Promise<void>;
}
```

### Browser transport abstraction (D exposes to UI)

```ts
export interface MusicSessionController {
  start(): Promise<void>;
  vote(v: Vote): void;   // synchronous local update; no button lockout
  stop(): void;
  subscribe(listener: (state: { status: string; lastError?: string }) => void): () => void;
}
```

---

## 6. Baseline preference-learning design (implementable now)

Use **online feature-score learning**, not generator fine-tuning. It is a deliberately simple contextual-bandit-inspired heuristic, not a fully trained RL model.

### Vocabulary (`learner/vocabulary.ts`)

| Group | Fixed options |
| --- | --- |
| Genre | `ambient`, `lofi`, `jazz`, `electronic`, `classical` |
| Instrument | `piano`, `synth`, `guitar`, `strings`, `percussion` |
| Mood | `calm`, `dreamy`, `hopeful`, `melancholic`, `energetic` |
| Texture | `sparse`, `layered`, `rhythmic` |

For Lyria, map IDs to descriptive prompt snippets such as `lo-fi hip-hop groove`, `soft felt piano`, `warm ambient synthesizer pads`, `spacious dreamy atmosphere`. **Do not pretend feature labels perfectly describe the produced sound**—they describe what we asked the model to generate.

### Learning rule

Start every score at zero. For current audible feature intensities `x_i` and feedback `r ∈ {+1,-1}`:

```text
score[i] = clamp(score[i] + 0.15 * r * x[i], -2, +2)
```

`audible` is an estimate of the blended prompt influences that the listener heard; not direct acoustic measurement. If someone votes mid-transition, estimate blend at that time using current ramp progress **minus approximate buffered audio delay**. This must be treated as uncertain; track the approximation in debug logs.

### Candidate selection

- Generate **12** valid candidates using the vocabulary.
- About **85%** of exploration steps: change **one or two** active characteristics while retaining the core style.
- About **15%**: broader exploratory combination, still instrumental.
- Score candidate = sum of learned feature scores times its active feature intensities + small seeded random exploration noise. Do not overfit to the first one or two votes.
- After `down`: prefer a different candidate, but protect continuity by transitioning prompt weights over time.
- After `up`: reinforce current active features; gradually increase their influence (subject to max weight), retaining subtle ongoing variation.
- Every ~45 seconds without feedback: a **small within-style variation**, no score update.
- Normalize prompt weights to a reasonable range (e.g., 0.2–1.2, upper cap 2.0). **Omit** features with weight 0, because the provider disallows zero prompt weights. Lyria rescales weights to sum to 1, so "amplify" means raising a feature *relative to the others*. The relay drops ≤0/NaN weights and clamps the rest to 0.1–2.0.
- Retain a random seed for repeatable tests. It only needs to live in tab memory.

These are **hypotheses**, not empirically tuned values. Keep constants in one file for easy iteration.

### Transition controller

- Treat UI votes as immediate synchronous input.
- Snapshot approximate audio blend, update learner, then set `targetRevision += 1`.
- Compute transition ramp from **estimated current** blend to newly selected target. Supersede previous ramp on each vote.
- Ramp default: **8 seconds**, sending intermediate weighted prompts about once a second; avoid flooding Google or driving guidance too high.
- Because model response is generative, a ramp schedule is **not** proof that the desired sound is audibly different within 8 seconds. Test this manually.
- No BPM or scale changes during live MVP. Changes to density/brightness are optional later if weighted prompts alone prove insufficient.
- If a prompt is filtered upstream, log diagnostic info and fallback to another valid combination.

---

## 7. LLM versus deterministic learner: decision and experiment

### Current decision

**Do not put an LLM into the critical streaming/vote path for launch.** Even with unlimited budget, a general-purpose LLM's superiority for sparse 👍/👎 signals is unproven. It can infer musical relationships and propose creative combinations, but cannot reliably identify why a listener disliked a sound, and a text-only LLM doesn't hear the generated audio itself. A deterministic learner updates numeric preference evidence accurately and predictably.

### Why a hybrid could eventually outperform either alone

- **Deterministic learner:** consistent updates, bounded prompt changes, reproducible tests, exploration/exploitation controls.
- **LLM advisor:** proposes sensible *untried combinations* using general musical knowledge (e.g., liking ambient piano plus disliking heavy drums might motivate a test of minimalist felt piano with soft strings).
- **Hybrid:** LLM proposes, deterministic learner scores and verifies with votes, controller handles transitions. This is a **hypothesis to A/B test**, not a guaranteed performance improvement.

### Optional v1.1 experiment — **must not block the four-way MVP**

- Behind a developer feature flag `EXPERIMENT_LLM_ADVISOR=true`.
- Every ~3–5 votes, send **structured vote history and feature IDs only** to an LLM (never the Gemini key to browser). Ask it for exactly **three candidate feature sets** with a JSON schema restricted to allowed vocabulary; no free-form provider instructions.
- Filter/validate candidates against fixed vocabulary and continuity constraints. Deterministic scorer chooses a winner; the LLM does **not** directly control Lyria.
- Run A/B sessions: baseline deterministic vs hybrid LLM advisor, same streaming and UI.
- For 1–5 testers, treat this as qualitative signal, **not statistical proof**. If both seem viable, expand tests before inferring superiority.
- A more significant future improvement might be **audio embeddings** of actual generated output, so votes attach to *what was heard* rather than just textual controls. That is explicitly beyond MVP.

Useful research context:
- https://ojs.aaai.org/index.php/AAAI/article/view/41321/45282 — 2026 survey of LLMs + bandits.
- https://arxiv.org/abs/2602.08067 — LLM-assisted warm-start in a streaming recommendation research setting; not a validation of this app specifically.
- https://research.google/pubs/diverse-user-preference-elicitation-with-multi-armed-bandits/ — importance of exploration during preference elicitation.

---

## 8. Build sequence, parallel merge plan

### 0 — Before coding (all four, ~15-minute coordination)

1. Confirm the Lyria RealTime model is accessible to the project API key and review quotas/billing. If inaccessible, record blocker immediately—don't invent a compatible replacement.
2. Freeze shared types/contracts and pick a single test sample rate from smoke test or make the player configurable.
3. Agree on repository paths, package manager, Node/TypeScript versions and deploy target.
4. Create stubs in all four owned modules, so each lane can mock dependencies and compile independently.

### 1 — Work in parallel

- **A:** API relay + mocked PCM and live provider proof.
- **B:** Player/audio UI against mocked PCM; mobile/responsive checks.
- **C:** Pure preference-learning functions and deterministic tests.
- **D:** Controller and local mocked integration test against frozen interfaces.

### 2 — Integration checkpoints

- **Checkpoint 1:** A binary mock PCM stream plays in B's browser with no dropouts for 3 minutes; D can start/stop it.
- **Checkpoint 2:** C's seeded learner receives simulated votes; D issues the expected `steer` messages with strictly increasing revisions.
- **Checkpoint 3:** Replace mock provider with Lyria; verify continuous audio and distinct prompt changes.
- **Checkpoint 4:** Connect thumbs input end-to-end; verify repeated rapid thumbs and no-vote drift; test on phone and desktop.
- **Checkpoint 5:** Publish privately to up to 5 testers; test a few hours. Keep `GEMINI_API_KEY` out of frontend bundle and logs.

### Branch / PR convention

~~Feature branches~~ **Updated: everyone commits to `main`** (`git pull --rebase --autostash` before pushing). Only touch your own lane's files. No shared-file edits except protocol review. Push small commits early; use mock interfaces until a dependency is live.

---

## 9. MVP acceptance tests

### Required automated tests

- Learner scores stay in bounds after hundreds of votes.
- Negative votes reduce associated feature scores; positive votes increase them.
- No-vote evolution does **not** change preference scores.
- Candidate selection produces valid instrumental-only prompt sets and never sends a zero weight.
- Seeded runs are reproducible in unit tests.
- During transition, new vote supersedes target (not queued); stale `steer` revision is ignored.
- Downvote changing two attributes produces a non-identical target; thumbs-up strengthens present features within caps.
- WebSocket close cleans up audio player and Lyria connection.
- Binary PCM is decoded in the correct format; frontend can play with mismatched browser/device sample rate.

### Required manual tests

1. **Cold start:** Open in a fresh tab → tap Start → continuous music within reasonable latency, without any profile/setup.
2. **Downvote:** Music changes noticeably toward a different direction within **5–15 s** without an audible hard cut; log measured actual duration. If model cannot meet it, report honestly rather than claiming success.
3. **Upvote:** Current music gradually emphasizes liked characteristics without a restart.
4. **Rapid votes:** Press 👎 three times rapidly while a transition is in progress; no stalls or ignored clicks, and final target reflects newest feedback.
5. **Passive listening:** Leave music on for at least 10 minutes; slow variation occurs without explicit reward updates.
6. ~~**Mobile**~~ Out of scope for the MVP. Instead, **Reconnect:** after an upstream drop (or the ~10 min cap), audio resumes within ~10 s without a page refresh and without double-playing.
7. **Refresh:** ~~Clears scores~~ **Updated:** saved taste is restored from browser storage; after `resetPreferences()` (or clearing site data) it returns to a randomized start.
8. **Security:** API key is absent from bundled JS, browser requests and error text; excessive unauthenticated streaming is blocked.

### Success metric for first experiment

Focus on observed behavior and user preference, not just code correctness. For 1–5 testers, ask after testing whether they feel the sound increasingly fits their tastes; observe whether consecutive downvotes often lead to eventual sustained positive feedback. Do **not** treat lack of votes as positive feedback or claim statistical significance from this sample size.

Potential later research metric: compare blind, equal-duration clips sampled near beginning vs after ~15–20 votes, preferably with a forced-choice test conducted separately from the MVP interface.

---

## 10. Risks / explicit assumptions

1. **Provider availability:** Lyria RealTime is experimental; account access, price, quota and limits are not guaranteed by this handoff. Confirm before engineering effort.
2. **Musical steering is probabilistic:** Requested weighted prompts may not correspond exactly to audible output. A text-only learner cannot verify what the user heard.
3. **Response time:** A 5–15-second perceptible change is a product target, not guaranteed by prompt weights or time to API acknowledgement.
4. ~~**Sample-rate ambiguity**~~ **Resolved:** 48 kHz stereo s16le, and `sampleRateHz` is rejected. The remaining latency budget is ~2 s chunking plus ≤2 s control latency plus the browser buffer (≥2.5 s), so expect ≥5 s before a steer can be heard.
4b. **Session cap (confirmed):** a hard 10-minute cap, closing with 1011 and no warning. The relay reconnects automatically, but every 10 minutes there's a ~5 s gap and the music re-settles.
5. **Security:** Hosted service still needs a secure minimal relay unless a *verified* safe client authentication mechanism for Lyria is available. Don't expose long-lived keys.
6. **Reliability:** Lost WebSocket / upstream termination can interrupt the soundscape. Reconnect with current in-tab preferences; seamless reconnection is not guaranteed for v1.
7. **Preference attribution:** One negative vote offers ambiguous evidence; avoid overinterpreting it. Overly aggressive reinforcement can trap user in a narrow style.
8. **No real RL model training:** “Reinforcement learning” is a product-level description of feedback-driven adaptation. The MVP is a simple online preference learner, and this is intentional.
9. **Shared audio/caching:** We agreed this is a possible future scale optimization, but including it now would undermine fastest-to-product.
10. **Audio rights:** Lyria's output and provider terms govern allowed use. Re-evaluate licensing if moving from private experiment to a commercial music product.

---

## 11. First working demo: exact scenario

1. Open app; user taps Start (required for browser audio policy).
2. Initialize random broad instrumental prompt blend, e.g. `dreamy ambient pads` (0.8), `soft piano` (0.6), `sparse layered texture` (0.4).
3. Start Lyria stream; immediately feed PCM to browser audio buffer.
4. User presses 👎. Controller snapshots approximate audible blend; learner updates scores; produces a nearby but different target, e.g. more `jazz piano`, less `ambient pads`.
5. Over ~8 seconds, controller sends stepped prompt updates while audio continues. Perceptible response target is 5–15 seconds; measure it.
6. User presses 👍 mid-change. Controller uses the latest audible estimate, reinforces the present features, and redirects ramp to a stronger version of that mixture without restarting.
7. User stops voting. Music slowly varies within the current style; scores stay unchanged.
8. Refresh tab. ~~Session preferences reset to zero.~~ Saved preferences are restored from the browser (see the Persistence row); reset clears them.

If all eight work with a real Lyria connection, the MVP is ready for a small qualitative test.

---

## 12. Questions intentionally deferred

- Will audio embeddings be needed for true auditory similarity rather than prompt similarity?
- Does an LLM-guided candidate explorer beat deterministic exploration after ~10–20 votes?
- How will profiles persist across visits?
- When (if ever) should generated segments be cached/reused across users?
- What are the unit economics at 100+ concurrent listeners?
- Is another streaming model better than Lyria for nuanced music transformations?

**Do not block the MVP on these questions.**

---

## One-paragraph handoff to all four developers

> Build a responsive web app that starts playing continuous instrumental music through Google's Lyria RealTime hosted API. The only recurring controls are thumbs-up and thumbs-down. An in-memory TypeScript preference learner maintains scores for a fixed set of musical characteristics and uses balanced exploration; thumbs-up gradually amplifies liked elements, thumbs-down steers to another style, and silence slowly evolves the current style without being treated as feedback. Music must continue through transitions, targeting a noticeable downvote response within 5–15 seconds. Accept new votes immediately even mid-transition. No accounts, database, skip button, user-entered prompts, persistence, LLM dependency or GPU hosting. A small secure Node WebSocket relay protects the music API key and forwards stereo PCM. Four developers own the backend relay, audio/UI, preference learner, and session orchestration/testing in parallel under the frozen contracts in this document.
