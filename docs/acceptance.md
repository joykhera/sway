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
| 1 | Cold start | Fresh tab, tap Start, music with no setup. Record time-to-audio (A measured about 5.8 s to `ready`) | |
| 2 | Downvote | Noticeable change within 5–15 s, no hard cut. **Record the measured seconds**, and report honestly if missed | |
| 3 | Upvote | Liked qualities emphasize gradually, no restart | |
| 4 | Rapid votes | 👎 three times during a ramp: no stall, no ignored click, final direction matches the last vote | |
| 5 | Passive listening | 10+ min: slow variation, no score updates (check debug log shows no `vote` events) | |
| 6 | Reconnect | After an upstream drop (or the ~10 min cap) audio resumes within ~10 s without refresh and without double-playing; status shows `reconnecting` then `playing` | |
| 7 | Refresh | Scores reset, new random start | |
| 8 | Security | Key absent from bundled JS, network panel and error text; beyond `MAX_STREAMS` the relay refuses (relay binds 127.0.0.1) | |

Note: Lyria's session cap is about 10 min (unconfirmed, see `docs/lyria-smoke-report.md`). The relay reconnects upstream itself (`reconnecting`, then a fresh `ready`); the controller keeps its ramp state and the player must reconfigure without double-playing.

## Measuring the downvote response (test 2)

Enable the controller `log` and note the `vote` timestamp, then listen and note when the music clearly changes. The ramp takes 8 s by design, so the first audible change is expected roughly 2–4 s (buffer plus generation) after the first step, and the full change near the end of the ramp.

## Local run checklist (MVP is localhost-only; mobile and hosted deploy are out of scope)

- [ ] `.env` has `GEMINI_API_KEY` (your own key) and `MUSIC_MODE=live`, or `MUSIC_MODE=mock` for a keyless run.
- [ ] `pnpm test` and `pnpm typecheck` pass on the commit you test.
- [ ] `pnpm dev`, open the Vite URL, tap Start, expect first sound in about 6 s.
- [ ] `pnpm build && grep -r GEMINI dist/` finds nothing.
