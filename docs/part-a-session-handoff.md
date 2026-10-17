# Part A — session handoff (2026-10-17)

For whoever picks up A (relay/backend) next. Start here, then `docs/HANDOFF.md` §0 and `docs/lyria-smoke-report.md`.

## Where things stand

**The MVP loop runs end to end on `main`:** Start → C's learner → D's controller → A's relay → live Lyria → B's player. A headless Chromium run confirmed start, votes (handled in ~40 ms), rapid votes, steers, refresh and restart.

| Lane | State |
|---|---|
| A — relay (`server/**`) | Done, verified live. Reconnects on the 10-min cap. Logs redact the key. |
| A — smoke test (`pnpm smoke`) | Done. All questions answered (see the report). |
| B — player + UI | Merged. Preroll is now chunk-sized (PR #6 fixed issue #5). |
| C — learner | Merged. A added **4 phrasings per feature** (`5aaa507`, needs C's review). |
| D — controller + transport | Merged. `App.tsx` uses the real controller; `?mock` gives a test tone. |

**Run it:** `pnpm install`, add your own `GEMINI_API_KEY` to `.env`, run `pnpm dev`, open http://127.0.0.1:5173 and click **Start listening**. Expect ~8 s of silence first (~4–5 s for Lyria plus a 3 s buffer). Hard-refresh (Cmd+Shift+R) after pulling.

## Verified facts (don't re-research)

- `sampleRateHz` is **rejected** (close 1007). Output is 48 kHz stereo s16le in 2.0 s chunks at ~1x realtime, with no run-ahead.
- First audio arrives 3.8–5.3 s after `play()`.
- **Hard 10:00 session cap**, closed with code 1011 "service unavailable" and no warning. The relay reconnects (~5 s gap). The team accepted that gap for the MVP.
- 5 concurrent sessions work on one free key. Weights are normalized server-side, so only ratios matter.
- All 72 learner phrasings pass Lyria's prompt filter. Ramps peak at 8 prompts (the relay caps at 10).

## Decisions made

- **Hosting and access:** localhost only, no access gate, mobile out of scope.
- **Workflow:** everyone commits to `main`; teammates also open PRs.
- **Latency:** a few seconds of steer latency is OK for the MVP.
- **Models:** open-source preferred for any AI additions (see below).

## Open items, by priority

1. **The music sounds bad (user feedback).** Proposed fixes, none built yet, and the team must agree because they touch C, D and a product decision:
   - **Curated starting "stations"** instead of a random 4-feature start.
   - **One dominant style prompt:** the genre phrasing gets ~50–60% of the weight, and the others add colour. Today 4 prompts are near-equal, which gives mush.
   - **👍 = lock in:** revert to the prompts behind what was audible at the click (~3–5 s earlier), pause the 45 s drift for ~2 min, and use a clearly audible boost. Today it's +0.05 intensity, about 2% of the mix.
   - Fewer steers while idle, so Lyria can settle into a groove.
2. **Security, before anyone deploys.** PR #3 added Render deploy files with `HOST=0.0.0.0`. The relay has **no auth**, so a public deploy is an open proxy on someone's Gemini key. Add an access gate (shared key or basic auth at upgrade) in `server/app.ts`, or agree not to deploy.
3. **D's `generationLatencyMs` is 0.** It should be ~3000, because Lyria holds ~3.2 s of lead. Otherwise votes are credited to prompts that weren't audible yet.
4. **Two copies of the learner types:** `protocol.ts` (`FeatureId = string`) and `learner/types.ts` (a strict union). Align them eventually.
5. **No browser audio check yet.** Nobody has confirmed audio in real Chrome (headless can't hear). If the UI shows PLAYING but it's silent, suspect B's player.

## v1.1 ideas researched (open-source, not started)

- **What was actually heard:** LAION `larger_clap_music` (Apache-2.0, ~200M parameters, runs on a Mac's CPU). It scores 10 s clips zero-shot against our vocabulary. Run it as a Python sidecar next to the relay, every ~20 s.
- **LLM advisor / "describe what you want":** `nemotron-3-nano:4b` via Ollama with a JSON schema (2.8 GB, commercial-OK license).
- **Switchyard** (NVIDIA) is an LLM *router*, not a model. Skip it unless we route between several LLMs.
- Avoid these for licensing reasons: Essentia and Music/Audio Flamingo (non-commercial).
- Ranked input ideas: describe a vibe (medium effort) > photo → vibe > record music that's playing (needs mic + CLAP).

## Gotchas

- **Shell:** it's nushell, where `open file.wav` prints bytes. Use `^open file.wav` or `afplay file.wav`.
- **Local stash:** `stash@{0}` holds an old local `App.tsx` wiring edit, which is now superseded. Dropping it needs approval; it's safe to drop.
- **Smoke WAVs:** they're in `smoke-out/` (gitignored). The 10-min one is `smoke-out/2026-10-17T19-54-24-234Z/smoke.wav`.
- **Live dev logs:** don't pipe `pnpm dev` through `grep` into a file. It buffers and hides the newest relay lines.
- **Playwright:** a harness lives in the session scratchpad (not in the repo). If browser checks matter, recreate it under `scripts/`.
