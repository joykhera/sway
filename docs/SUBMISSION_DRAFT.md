# Sway: an endless music stream that learns your taste, and an agent team that tries to improve itself

## 1. What we built and why

**Sway** plays endless instrumental music, generated live by Google Lyria RealTime. You have two controls: thumbs up and thumbs down. There are no accounts, no prompts to type and no skip button. A thumbs-down steers the music somewhere else. A thumbs-up gently strengthens what you liked. The music keeps playing through every change.

Alongside the product we built an **offline self-improving agent team** on Crusoe Managed Inference, using NVIDIA Nemotron models. It answers the hackathon's question: can a team turn its own history into a better version of itself, and prove it on tasks it has not seen? The team never controls the live music. It only suggests musical directions from a fixed list, and plain code makes the final choice.

## 2. How the self-improving team works

- **Advisor.** Reads a listener's recent thumbs history and proposes three candidate musical directions. A fixed scoring rule, not the model, picks the winner.
- **Reviewer.** Reads transcripts of past sessions and writes a diagnosis of what worked and what did not.
- **Rewriter.** Reads the diagnosis plus the full record of earlier accepted and rejected attempts. It then proposes new versions of the advisor's instructions, its "lessons learned" playbook, and a few bounded team settings, such as how often the advisor is consulted.
- **Gatekeeper.** Plain code that cannot be edited by the team. It keeps a change only if the change beats the current version on held-out listeners by a required margin, with a statistical confidence interval above zero. Otherwise the change is reverted.
- **Sealed test sets.** Simulated listeners with hidden tastes are split into training, validation and a sealed test group. The improvement loop never touches the sealed group. It is scored once, at the end, as the before-and-after proof.

Score = share of thumbs-ups the listener gives after 5 warm-up votes in a 30-vote session.

## 3. Results, reported honestly

**Bottom line: none of our three runs showed measurable improvement.** We did not prove the team improves itself. The rigor of the process is the real finding so far.

**Run 1** (24 unseen listeners x 3 sessions, sealed test):

| Policy | Like rate (95% CI) |
| --- | --- |
| Random | 26.3% (23.2 to 29.6) |
| Plain deterministic learner | 34.3% (30.3 to 38.4) |
| Team before (generation 0) | 33.6% (30.4 to 36.9) |
| Team after (generation 1) | 33.1% (29.5 to 36.5) |
| Oracle (reads hidden taste) | 68.1% (63.9 to 71.9) |

After vs before: **-0.5 points (CI -3.2 to +2.0)**. 11 listeners did better, 1 tied, 12 did worse. In the improvement loop, one change looked like a win on validation (+5.8 points, CI +0.8 to +11.3). On the sealed test it showed no gain, so it was most likely luck (a best-of-three pick on a small set), and the other 6 candidates in later rounds were all rejected. The held-out test caught a false win.

**Run 2** (pre-registered: design and success rule committed before running; two-stage gate; 40 fresh listeners x 3 sessions). The gate rejected every proposed change, so the final team equals generation 0. Before vs after: **+0.0 points (CI +0.0 to +0.0)**, which fails our pre-registered criterion by construction, because nothing was adopted. The team scored 28.0% (25.2 to 30.8) before and after. The plain learner scored 30.2% (27.0 to 33.2), random scored 22.5%, and the oracle scored 65.0%. The team trailed the plain learner by 2.2 points (CI -4.5 to +0.2). The rigorous gate refused to keep unhelpful changes.

In both runs the advisor team did not beat the plain learner.

**Run 3** (pre-registered before running, with a stricter bar because it was a third attempt: the improvement had to clear zero at 99% confidence). It used a newer advisor model and a wider set of editable team settings. The gate again rejected all 6 proposed changes, so the final team equals generation 0 and the criterion is **negative** (+0.0 points, 99% CI -0.3 to +0.2). On 40 fresh listeners the starting team scored 35.2% (32.6 to 37.9), the plain learner 33.7% (30.8 to 36.8) and random 29.0%. Generation 0 versus the learner was +1.4 points (CI -0.8 to +3.6): a weak hint in the right direction, not a significant result, and not the question we pre-registered, so we do not claim the advisor helps.

**Across three runs:** no change we tried measurably improved the team, and every time the held-out test and the gate stopped us from claiming one.

## 4. What works today in the product

A team member reported these results from live listening. They are subjective stopwatch timings, not instrumented measurements.

- Live music works. Cold start to first sound took about 5 to 6 seconds.
- After a thumbs-down, the change was noticeable in about 8 to 9 seconds, and the transition was smooth.
- Manual acceptance tests 1 to 8 (`docs/acceptance.md`) were reported as passing.

The results are being recorded in the test table in `docs/acceptance.md` (pull request #13, awaiting merge). They were taken on a build from before the latest preference-saving change, and tests 2, 4, 6 and 7 are being re-run on the newest build.

## 5. Limits and what we would do next

- **Simulated listeners are a proxy.** Results say nothing yet about real people.
- **Learner mismatch.** The app now ships an adaptive learner, but all experiments evaluated the original deterministic learner. Re-baselining on the shipped learner is future work.
- **Model constraint.** In our probe, the Super 120B model was unusable as the advisor at scale: median 10 to 14 s per call versus about 2 s, and over half of calls failed at 16 and 32 parallel. It is used only as reviewer and rewriter.
- **Small samples.** Intervals are wide. Two negative runs on one simulator do not prove the idea cannot work.
- **Persistence.** Browser IndexedDB persistence is kept as a deliberate team decision. The handoff document is being updated for this (pull request #13); the README may still describe the older session-only behavior.
- **Next:** re-baseline on the adaptive learner, then test with real listeners.

---

## 6. Technical appendix

**Architecture.** Vite, React and TypeScript front end. A small Node WebSocket relay holds the Gemini key and forwards Lyria's 48 kHz stereo 16-bit PCM audio. The session controller turns votes into 8-step, 1-second-per-step prompt ramps, and a new vote supersedes a ramp in flight. After 45 s of silence the music slowly evolves, and silence is never counted as feedback. The learner works over a fixed vocabulary of musical features. The self-improve lane is `tools/selfimprove/` and runs offline. It never touches the relay or player.

**Models (Crusoe Managed Inference).**
- Advisor, runs 1 and 2: `NVIDIA-Nemotron-3-Nano-30B-A3B` (thinking off).
- Reviewer and rewriter: `NVIDIA-Nemotron-3-Super-120B-A12B` (thinking on).
- Advisor, run 3: `nvidia/Nemotron-3.5-Lightning-30B-A3B`.

**Editable surface.** Advisor prompt, playbook and whitelisted params, each clamped in code: `advisorStartVote`, `advisorEveryNVotes`, `historyWindow`, `candidateCount`, `llmCandidateBonus`, `noveltyBonus`, `temperature`. Frozen: personas, simulator scoring, stats, gatekeeper, `src/learner`. LLM responses are cached on disk, so reruns are deterministic. Final scoring uses a lock file to stop a second scoring of the sealed test set.

**Gates.** Run 1: gain of at least 2 points and paired bootstrap CI above 0. Run 2: stage A on validation-A needs at least 3 points and CI above 0, then the best passer must replicate on validation-B with at least 2 points and CI above 0.

**Tests.** `npx vitest run tools/` runs the self-improve unit tests with no network. `pnpm test` runs the main suite, including relay end-to-end tests in mock mode. The current test count is not stated in the files we read (`docs/HANDOFF.md` records 69 relay tests at one point in time).

**How to run.** Set `MUSIC_MODE=mock` for keyless use, or set `GEMINI_API_KEY` for live mode. Self-improve needs `CRUSOE_API_KEY`.
```sh
npx tsx tools/selfimprove/baseline.ts            # no key needed
npx tsx --env-file-if-exists=.env tools/selfimprove/loop.ts --design run2 --rounds 3 --variants 3 --concurrency 16 --deadline-minutes 40 --out tools/selfimprove/runs/run2
npx tsx --env-file-if-exists=.env tools/selfimprove/final.ts --test-set run2 --run tools/selfimprove/runs/run2   # once
```
App: `pnpm dev` after install, per the README.
