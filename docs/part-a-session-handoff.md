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

## PR #8 (merged 2026-10-17, `e445694`): what changed

C's **adaptive learner** is now the default at `/`. It ranks 375 four-prompt recipes with a ridge model over the 18 features. There's an optional **Focus / Relax / Energy / Explore** hint before Start, and a 👍 **holds the heard blend**. Clicks within 6 s on a similar blend count once, and learning stops while audio is suspended or priming. The PR also adds an HTTP-fallback PCM player for non-secure origins. The baseline learner remains for comparison. See `docs/adaptive-integration.md`. There are 321 tests, and the build passes.

## Open items, by priority (revised after PR #8)

1. **The music sounds bad (user feedback).** PR #8 covers part of this:
   - **Done in part, "stations":** the purpose hint is only a weak prior (0.16). It is not a curated starting point, and Explore is the default.
   - **Done in part, "👍 = lock in":** a 👍 now holds the heard blend. But variations still fire **every 45 s even after a 👍**, by design. The old plan paused drift for ~2 min, so the team needs to decide.
   - **Not done, and now the main lever, "one dominant prompt":** every recipe is 4 prompts at 0.45/0.40/0.30/0.25, so genre is only ~32% of the mix. Google's examples and the Magenta RT user study favour 2–3 prompts with one clear lead. Change the weights in `src/learner/adaptive/recipes.ts` (C's file) to something like 0.6/0.25/0.15, or drop texture.
   - **New, A's lane:** the relay doesn't forward Lyria's `guidance`, `bpm` or `scale`. Try higher guidance and a fixed BPM and key for each purpose, set only at start (changing them later needs a context reset, which cuts the audio). Then compare by ear.
2. **Security is now more pressing.** PR #8 says a teammate ran a **Tailscale HTTP preview** against a real key, using caps kept outside Git. The relay in the repo still has **no auth and no Origin check**, so any `HOST=0.0.0.0` run is an open proxy. Add a shared-key gate at upgrade plus an Origin allowlist in `server/app.ts` before anyone shares a URL again.
3. ~~`generationLatencyMs` is 0~~: **resolved.** It is 2500 on `main`.
4. **Learner types: there are now three copies:** `protocol.ts`, `learner/types.ts` and `learner/adaptive/types.ts`. The adapter checks the shape at runtime. Align them eventually.
5. **No one has listened in real Chrome yet.** PR #8's live runs (~66 s and 16 s) checked the controls and transport, not the sound. The next step is a human listening A/B: baseline vs adaptive, and current weights vs a dominant genre.

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
