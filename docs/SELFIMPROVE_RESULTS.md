# Self-improving taste team: results (Crusoe Managed Inference, NVIDIA Nemotron)

**Question:** can an agent team improve itself from its own history, keep a change only if it measurably helps, and prove it on tasks it has never seen?

**Honest headline:** none of three runs produced a measurable improvement. Run 1's loop adopted a variant that looked good on validation (+5.8 pts) and then showed no gain on the sealed test. Runs 2 and 3, each with a stricter pre-registered gate, adopted nothing, so their final team is the unchanged generation 0. The held-out tests and the gate did their job: they stopped us from claiming an improvement we did not have. Run 3 did surface one weak, non-significant hint: with a newer advisor model, generation 0 scored slightly above the plain learner (see below).

## The team
- **Advisor** (`NVIDIA-Nemotron-3-Nano-30B-A3B`, thinking off): from the listener's vote history, proposes 3 candidate musical directions from a fixed vocabulary. A deterministic scorer picks the winner. The LLM never controls the music and never sees hidden taste.
- **Reviewer** and **Rewriter** (`NVIDIA-Nemotron-3-Super-120B-A12B`, thinking on): read transcripts of past runs plus the history of accepted and rejected attempts, diagnose what worked, and rewrite the advisor prompt, a playbook of lessons, and a small set of bounded team parameters.
- **Gatekeeper** (plain code): keeps a change only if it beats the incumbent on held-out validation listeners by a margin, with a paired bootstrap confidence interval above zero. Otherwise it reverts.

## Test environment
Simulated listeners with hidden taste (pair effects, pickiness, fatigue, vote noise). Score = share of thumbs-up after 5 warmup votes in a 30-vote session. Listeners are split into train, validation and a **sealed test set** that the loop never touches. Reference lines: random (floor) and an oracle that reads hidden taste (ceiling, about 68%).

## Run 1 (complete)
**Loop:** 3 rounds, 3 variants per round, validation of 12 listeners x 2 sessions.
- Round 1: `avoid_immediate_repeat` adopted. Validation +5.8 pts (95% CI +0.8 to +11.3). It sped up advisor consultation (every 2 votes instead of 3), lengthened history, and added one lesson. Two other variants: one accepted but not best, one rejected (CI included zero).
- Rounds 2 and 3: all six variants rejected (gains between -4.2 and -1.2 pts).

**Sealed test, scored once:** 24 unseen listeners x 3 sessions (72 paired episodes).

| Policy | Like rate | 95% CI |
| --- | --- | --- |
| Random (floor) | 26.3% | 23.2 to 29.6 |
| Deterministic learner | 34.3% | 30.3 to 38.4 |
| Nemotron team, generation 0 (before) | 33.6% | 30.4 to 36.9 |
| Nemotron team, generation 1 (after) | 33.1% | 29.5 to 36.5 |
| Oracle (ceiling) | 68.1% | 63.9 to 71.9 |

Final vs generation 0: **-0.5 pts (CI -3.2 to +2.0)**, 11 listeners better, 1 tied, 12 worse. No measurable improvement. Cost: about 1,600 advisor calls for the test; the loop used about 1,000 per round, with no HTTP errors.

**What we learned:**
1. The validation win was the best of three candidates on a small set, with a lower bound of only +0.8, so it did not survive unseen listeners. The held-out test caught it.
2. Even generation 0 did not beat the plain learner. The advisor adds no value until its use is tuned, and the tuning we found did not generalize.

## Run 2 (pre-registered, complete)
Design, gate and success criterion were committed **before** running: `tools/selfimprove/PREREGISTRATION.md`. Changes from run 1: fresh listeners (new seed), larger validation sets (40 listeners x 2 sessions each), a two-stage gate (a winner must beat the incumbent by at least 3 pts with a confidence interval above zero, then replicate on a second untouched validation set), and a fresh sealed test of 40 listeners.

**Loop:** 3 rounds, 9 variants. **None passed the first gate.** Gains on validation ranged from -1.4 to +0.9 pts, all inside the roughly +/-3 pt noise of 80 paired sessions. The replication stage never ran. The final generation is generation 0. Cost: about 9,500 advisor calls, 24 minutes, no HTTP errors.

**Sealed test, scored once:** 40 unseen listeners x 3 sessions (120 paired episodes).

| Policy | Like rate | 95% CI |
| --- | --- | --- |
| Random (floor) | 22.5% | 20.1 to 25.3 |
| Deterministic learner | 30.2% | 27.0 to 33.2 |
| Nemotron team, generation 0 (before) | 28.0% | 25.2 to 30.8 |
| Nemotron team, final (identical to generation 0) | 28.0% | 25.2 to 30.8 |
| Oracle (ceiling) | 65.0% | 61.6 to 68.6 |

Primary pre-registered criterion (final minus generation 0, CI lower bound above 0): **+0.0 pts, FAIL.** This is true by construction, because nothing was adopted. Run 2 is negative.

**One further observation, replicated across both runs:** the Nemotron advisor team did not beat the plain deterministic learner. Run 1 sealed test: -0.7 pts (CI -3.2 to +1.7). Run 2 sealed test: -2.2 pts (CI -4.5 to +0.2). Neither difference is significant on its own, but both point the same way, so we do not claim the advisor helps.

**What we conclude:** in this simulated setting, a Nemotron advisor and a self-rewriting loop did not improve on a simple learner, and the evaluation process correctly refused to keep changes that did not help. We report this as a negative result.

## Run 3 (pre-registered, complete)
Pre-registered in `tools/selfimprove/PREREGISTRATION_RUN3.md` before running, with the multiplicity of a third attempt stated and a **stricter bar**: the final-vs-generation-0 interval must clear zero at **99%** confidence. Two changes: a newer advisor model (`Nemotron-3.5-Lightning-30B-A3B`) and a wider set of editable team settings (candidate scoring and mixing with the learner). Sizes were fixed for a one-hour budget: validation sets of 30 listeners x 2 sessions, sealed test of 40 x 3.

**Probe finding:** we first tried the 120B Super model as the advisor and it was unusable at this scale (median 10 to 14 s per call versus about 2 s, and over half of calls failing at 16 and 32 parallel).

**Loop:** 2 rounds, 6 variants, **none passed the first gate** (gains -1.7 to +0.1 pts; bar was +3.0). Final team = generation 0. About 3,800 advisor calls, 14.5 minutes. The rewriter used the new settings in every variant, to no effect.

**Sealed test, scored once:** 40 unseen listeners x 3 sessions (120 paired episodes).

| Policy | Like rate | 95% CI |
| --- | --- | --- |
| Random (floor) | 29.0% | 26.7 to 31.3 |
| Deterministic learner | 33.7% | 30.8 to 36.8 |
| Nemotron team, generation 0 (before) | 35.2% | 32.6 to 37.9 |
| Nemotron team, final (identical to generation 0) | 35.2% | 32.6 to 37.7 |
| Oracle (ceiling) | 70.3% | 67.2 to 73.4 |

Pre-registered criterion: final minus generation 0 = +0.0 pts (99% CI -0.3 to +0.2) -> **NEGATIVE**. The tiny difference between two copies of the same team comes from a handful of failed model calls (5 of about 1,000) that fall back to the learner.

**Weak hint, not a finding:** generation 0 (new advisor model) versus the plain learner was **+1.4 pts (95% CI -0.8 to +3.6)**, 24 listeners better, 4 tied, 12 worse. In runs 1 and 2 the same comparison (different, older advisor model) was -0.7 and -2.2 pts. The interval includes zero, the model changed between runs, and this comparison was not the pre-registered question, so we do not claim the advisor helps.

**Three-run summary:** the improvement loop found nothing that cleared its gate or held up on unseen listeners. The process worked as a guard against false wins.

## Limits
- Listeners are simulated, not people. A positive result would be evidence about the loop on a proxy task, not about real listeners.
- The three runs share one simulator and evaluate the original deterministic learner (`src/learner/index.ts`), not the adaptive learner (`src/learner/adaptive/`) that the app now ships. The baseline numbers reproduce identically on current `main`. Evaluating the shipped adaptive learner is future work.
- Small samples. We do not claim statistical significance beyond the stated intervals.

## Evidence
- Run 1: `tools/selfimprove/results/final.{md,json}`, `tools/selfimprove/runs/2026-10-17T20-56-34/` (changelog, every variant, diagnoses, raw rewriter output).
- Run 2: `tools/selfimprove/runs/run2/` (changelog, summary, every variant), `tools/selfimprove/results/run2/final.{md,json,lock}`.
- Run 3: `tools/selfimprove/runs/run3/`, `tools/selfimprove/results/run3/final.{md,json,lock}`.
