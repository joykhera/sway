# Part A — Lyria relay + repo scaffold: plan

Owner: A (`server/**`, `scripts/smoke-lyria.ts`, plus the initial repo scaffold). Branch: `feat/lyria-relay`.
Status: decisions locked after grilling on 2026-10-17.

## Decisions (and how they differ from the handoff)

| Topic | Decision | Differs from handoff? |
|---|---|---|
| Hosting | **Localhost only.** Server binds `127.0.0.1`. Each dev runs their own copy. | Yes, no deploy for MVP |
| Mobile | **Out of scope for MVP.** (AudioWorklet needs https or localhost, so phones would need a tunnel.) | Yes, drops manual test 6 and the phone checks |
| Access gate | None, since there's no public URL. Revisit when tunneling or deploying. | Yes |
| API keys | Each dev uses their own `GEMINI_API_KEY` in a gitignored `.env` (separate projects = separate quota). | Clarifies |
| Guards | Minimal: bind 127.0.0.1, validate input, idempotent cleanup, cap of 5 upstream streams. No byte caps or rate limits yet. | Trimmed |
| Mock | **Live-first.** `MUSIC_MODE=mock` sends a plain tone paced at 1x realtime, for Vitest and keyless devs only. | Trimmed |
| 10-min session cap | **Drop + reconnect.** On upstream close the relay sends `status:'reconnecting'`, reopens with the latest applied prompts, then sends a **fresh `ready`**. The browser socket stays open. Seamless overlap rotation only if testers complain. | New |
| Run-ahead / latency | **Measure first.** Forward chunks as received. The smoke test measures the burst ratio. If it's >1x, add relay pacing (≤2 s lead). | New |
| Weights | **Validate + pass through.** Drop 0, NaN and negative weights; clamp to [0.1, 2.0]; never send an empty set. Log the normalized shares. No rescaling. | Clarifies |
| Scaffold | **A scaffolds the repo** (single package, pnpm, Vite+React+TS, Node server via `tsx`, Vitest) and commits a `src/shared/protocol.ts` stub copied verbatim from the handoff. D still owns protocol.ts after that. | Yes, the handoff gave this to D. **Tell D.** |

## Research findings (2026-10-17, docs + `@google/genai@2.30.0` source)

- **R1** `models/lyria-realtime-exp` is still **experimental**. No realtime successor exists (Lyria 3/3.5 are per-song).
- **R2** Official output is **48 kHz stereo s16le**, control latency ≤2 s. The SDK config type has **no `sampleRateHz`**; the 44.1k in the guide is an untyped pass-through field. Default to 48000; parse `AudioChunk.mimeType` if it's present.
- **R3** `AudioChunk.data` is **base64** → `Buffer.from(b64,'base64')` → binary WS frame.
- **R4** `live.music.connect()` resolves on socket open, **not** `setupComplete`, so wait for `setupComplete` before sending prompts/config/`play()`.
- **R5** Weights are normalized server-side to sum 1, so **only ratios matter**. Note for C/D: scaling every weight up does nothing. To "amplify" a feature, raise it *relative to* the others.
- **R6** ~10-min session cap (DevRel article, not official docs). No `goAway` on music messages.
- **R7** Ephemeral tokens don't work for Lyria (Google staff, Aug 2025), so the relay is mandatory.
- **R8** The SDK puts the key in the upstream URL (`?key=`). **Never log upstream URLs or raw ErrorEvents.**
- **R9** Generation is "as fast as possible, not real time", in ~2 s chunks; allow 5–10 s to settle after start.
- **R10** Quota, pricing and concurrency are **unpublished**; limits are per project and tighter for experimental models. Free today, with no guarantee. Check aistudio.google.com/rate-limit.
- **R11** Prompt best practice (Google guide): 2–3 prompts, balanced weights 0.3–1.0, separate prompts for instrument vs mood, ramp weights rather than jump. The community DJ app throttles updates to ~200 ms.

## Repo scaffold (A does once, then hands protocol.ts to D)

```
package.json          pnpm, "type":"module", Node 22
  scripts: dev (vite + tsx watch server, concurrently), build, start, test, smoke
vite.config.ts        proxies ws /api/music → http://127.0.0.1:8787
tsconfig.json         strict; paths for src/shared
.env.example          GEMINI_API_KEY=, MUSIC_MODE=live|mock, PORT=8787
.gitignore            node_modules, dist, .env, *.wav
index.html, src/main.tsx, src/App.tsx (B's placeholder)
src/shared/protocol.ts   verbatim handoff types (D-owned after scaffold)
src/{ui,audio,learner,controller,transport}/index.ts   empty stubs per owner
server/  (A)
scripts/smoke-lyria.ts (A)
```

## server/ layout

```
server/
  index.ts            http server on 127.0.0.1; ws upgrade on /api/music; prod serves dist/
  config.ts           env parse; fail fast if MUSIC_MODE=live and no key
  guard.ts            runtime validation of ClientMessage; weight sanitizing
  session.ts          per-browser state machine; revision gate; steer coalescing; reconnect; dispose()
  upstream/types.ts   MusicUpstream { start, steer, close; onAudio, onFiltered, onWarning, onClosed }
  upstream/lyria.ts   SDK adapter: awaits setupComplete; base64→Buffer; rate from mimeType
  upstream/mock.ts    paced tone
  log.ts              structured logs with key redaction
```

**Session state machine:** `idle → connecting → playing ⇄ reconnecting → closed`
- `start` only from `idle`; otherwise `error{code:'bad_state'}`.
- `steer` with `revision <= lastApplied` → dropped. While connecting or reconnecting, keep only the latest pending steer.
- Upstream sends are coalesced: ≤1 per ~200 ms, newest wins.
- Upstream close while the client is connected → reconnect up to 3 times with backoff → else `error{code:'upstream_lost', retryable:true}`.
- `filteredPrompt` → `error{code:'prompt_filtered', retryable:true}` plus a log entry.
- Client close → `dispose()`: close upstream, clear timers, release the stream slot. Idempotent.

**Error codes A emits** (propose these to D as a protocol comment): `bad_message`, `bad_state`, `capacity`, `upstream_unavailable`, `upstream_lost`, `prompt_filtered`, `internal`.

## Smoke test — `pnpm smoke` (first thing, with your key)

1. Connect → `setupComplete` → prompts → config → `play()`. Run once with `sampleRateHz: 48000` and once with no rate.
2. Log: time to setupComplete and to first chunk; each chunk's byte size, duration and mimeType; cumulative audio seconds vs wall seconds (**burst ratio**); every `warning`/`filteredPrompt`.
3. Small steer at t=60 s, large steer at t=120 s. Write `smoke.wav` plus a timestamp log so you can listen for when the sound changes.
4. Keep running to 12 min to see whether and how the cap ends the session (close code and reason).
5. Open 2, 3, 5 parallel sessions to find the concurrency limit.
6. Write the results to `docs/lyria-smoke-report.md`. They decide the sample rate, the pacing question and whether reconnect matters.

## Tests (Vitest, A-owned)

guard (invalid shapes, 0/NaN/negative weights, empty set), stale revision dropped, steer coalescing keeps newest, steer-before-start rejected, pending steer applied after setup, upstream drop → `reconnecting` + fresh `ready` with latest prompts, client disconnect → upstream closed + slot released, 6th stream → `capacity`, mock frames are `% 4 == 0` bytes and paced, no API key in any log line or client frame.

## Order of work

1. Scaffold + `.env.example` + protocol stub → push to `main` and tell the team (unblocks B/C/D).
2. `pnpm smoke` with your key → report.
3. Relay live path (lyria adapter + session) → Checkpoint 1 with B.
4. Reconnect, filtered prompts, cap, mock tone, tests.
5. Fill in the smoke report findings (sample rate, quirks) in README.

## Heads-up messages for the team

- **D:** A is scaffolding the repo and protocol.ts stub (verbatim handoff). You own protocol.ts from then on. Proposed: error-code list above, and "`ready` may be re-sent after `reconnecting`".
- **B:** `ready` can arrive more than once; reconfigure if the rate changes. Expect 48 kHz unless the smoke test says otherwise. Mobile is out of scope.
- **C/D:** Lyria normalizes weights to sum 1, so only ratios matter. Keep 2–3+ prompts, separate instrument and mood prompts, ramp rather than jump.
