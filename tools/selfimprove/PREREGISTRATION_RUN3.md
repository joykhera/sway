# Pre-registration for run 3 (committed BEFORE run 3 starts)

## Record so far (both reported in full)
- **Run 1:** adopted variant (+5.8 pts on validation) then no gain on the sealed test (final vs gen0 -0.5 pts, CI -3.2..+2.0).
- **Run 2 (pre-registered):** 9 variants, none passed the gate; final = gen0; sealed-test criterion FAIL by construction. gen0 vs learner on the sealed test: -2.2 pts (CI -4.5..+0.2).
- Honest reading: no improvement found, and the advisor team has not beaten the plain learner in either run.

## Run 3 is a third attempt. Multiplicity is stated up front.
Three attempts at the same question inflate the chance that one passes by luck. Therefore this run uses a **stricter success bar** (below), and all three runs are reported together, in order, whatever happens.

## What changes (two substantive changes, decided before seeing any run-3 result)
1. **Advisor model: `nvidia/Nemotron-3.5-Lightning-30B-A3B`** (a newer-generation Nemotron) instead of `NVIDIA-Nemotron-3-Nano-30B-A3B`. We do not claim it is stronger, only newer. **Probe finding, reported as is:** we first tried the 120B Super model as the advisor and it was unusable at this scale (median 10-14 s per call versus about 2 s, and over half of calls failing at 16 and 32 parallel). Lightning (median about 2 s, 0 errors in 80 calls, valid JSON each time) and Nano were usable. Reviewer and rewriter stay on Super (1-3 calls per round).
2. **Wider editable surface.** Besides the advisor prompt, playbook and existing params, the rewriter may change a bounded whitelist of team-structure parameters that control how candidates are scored and mixed with the learner's own proposal (for example weights for learner score, novelty and repeat penalty, number of candidates, probability of deferring to the learner). All bounded and clamped in code. No file under `src/learner` is edited.

## Fixed design (sized to a one-hour budget)
- Fresh listeners from seed 9001, disjoint from runs 1 and 2: train 8 (1 session each), validation-A 30 and validation-B 30 (2 sessions each), sealed test 40 (3 sessions each).
- Same two-stage gate as run 2: stage A, margin >= 3 pts and paired 95% CI above 0 on validation-A; stage B (best stage-A winner only), margin >= 2 pts and CI above 0 on validation-B.
- At most 2 rounds, 3 variants per round, concurrency 24, hard wall-clock cutoff of 25 minutes for the loop. If cut off, the latest adopted generation is final (gen0 if none).
- gen0 for run 3 = the original starting prompt, playbook and params, with the new advisor model and the new parameters at values that reproduce the old behaviour.
- Sealed test 3 is scored exactly once: random, learner, gen0, final, oracle, same paired bootstrap.

## Success criterion (fixed now)
- **Claimed improvement:** final minus gen0, paired **99%** bootstrap CI lower bound above 0 on sealed test 3.
- **Suggestive only:** 95% CI lower bound above 0 but 99% not. Reported as suggestive, not as a win.
- Anything else: negative. If final = gen0 (nothing adopted), the criterion fails by construction and run 3 is negative.
- We also report gen0 and final versus the plain learner.

## Limits (stated regardless of outcome)
Simulated listeners, not people. The scorer never exposes hidden taste to any agent. Three runs on one simulator are not evidence about real listeners. All runs evaluate the original deterministic learner, not the adaptive learner the app now ships.
