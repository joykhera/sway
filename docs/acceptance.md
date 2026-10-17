# Acceptance and release checklist (D)

## Integration checkpoints (handoff §8)

1. Mock PCM from the relay (`MUSIC_MODE=mock`) plays in B's browser for 3 min with no dropouts; start and stop work.
2. Seeded learner + simulated votes → expected `steer` messages with strictly increasing revisions (`pnpm test` covers the controller side).
3. `MUSIC_MODE=live`: continuous audio and audibly distinct prompt changes.
4. Real thumbs end to end, rapid thumbs, no-vote drift, phone and desktop.
5. Up to 5 testers, each running the app locally with their own key, for a few hours. `GEMINI_API_KEY` is not in the bundle or logs.

## Manual tests (record results below)

| # | Test | Pass criteria | Result |
| --- | --- | --- | --- |
| 1 | Cold start | Fresh tab, tap Start, music with no setup. Record time-to-audio (A measured about 5.8 s to `ready`) | **Pass.** About 5-6 s to first sound, most runs (live Lyria, Pavan, 2026-10-17) |
| 2 | Downvote | Noticeable change within 5–15 s, no hard cut. **Record the measured seconds**, and report honestly if missed | **Pass.** About 8-9 s to a clearly noticeable change, smooth with no hard cut. Pavan, 2026-10-17, subjective stopwatch timing, range not three separate readings |
| 3 | Upvote | Liked qualities emphasize gradually, no restart | **Pass.** Style gradually leans into what was playing, no restart. Pavan, 2026-10-17 |
| 4 | Rapid votes | 👎 three times during a ramp: no stall, no ignored click, final direction matches the last vote | **Pass.** Three quick 👎: buttons responsive, only the first vote carried `evidenceWeight` 1 (dedupe working). Pavan, 2026-10-17 |
| 5 | Passive listening | 10+ min: slow variation, no score updates (check debug log shows no `vote` events) | **Pass.** 10+ min passive listen with slow variation, as reported by Pavan, 2026-10-17 (no measurements taken) |
| 6 | Reconnect | After an upstream drop (or the ~10 min cap) audio resumes within ~10 s without refresh and without double-playing; status shows `reconnecting` then `playing` | **Pass.** Recovery after the upstream drop / 10-min cap worked, as reported by Pavan, 2026-10-17 (no timing recorded) |
| 7 | Refresh | Scores reset, new random start | **Pass.** Reported by Pavan, 2026-10-17 |
| 8 | Security | Key absent from bundled JS, network panel and error text; beyond `MAX_STREAMS` the relay refuses (relay binds 127.0.0.1) | **Pass.** Reported by Pavan, and independently checked by D on a production build of the branch source: neither `GEMINI_API_KEY` nor `CRUSOE_API_KEY` (value or name) appears anywhere in the bundled output. Not checked: relay stream cap under load |

Note: Lyria hard-caps sessions at 10:00 (confirmed, see `docs/lyria-smoke-report.md`; expect about 5 s of silence at each cap). The relay reconnects upstream itself (`reconnecting`, then a fresh `ready`); the controller keeps its ramp state and the player must reconfigure without double-playing.

> **Build caveat (D):** the manual results above were taken on a build from before PR #10 (directional preferences and saved browser profiles). That PR adds about 200 lines to the controller and stores preferences in IndexedDB, so a refresh no longer necessarily resets preferences (test 7 as written) and the controller has new behaviour. Re-run tests 2, 4, 6 and 7 on the latest `main` before the final demo. The handoff's "session only, refresh resets preferences" rule needs a team decision.

## Measuring the downvote response (test 2)

Enable the controller `log` and note the `vote` timestamp, then listen and note when the music clearly changes. The ramp takes 8 s by design, so the first audible change is expected roughly 2–4 s (buffer plus generation) after the first step, and the full change near the end of the ramp.

## Local run checklist (MVP is localhost-only; mobile and hosted deploy are out of scope)

- [ ] `.env` has `GEMINI_API_KEY` (your own key) and `MUSIC_MODE=live`, or `MUSIC_MODE=mock` for a keyless run.
- [ ] `pnpm test` and `pnpm typecheck` pass on the commit you test.
- [ ] `pnpm dev`, open the Vite URL, tap Start, expect first sound in about 6 s.
- [ ] `pnpm build && grep -r GEMINI dist/` finds nothing.
