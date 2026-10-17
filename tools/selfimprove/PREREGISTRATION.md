# Pre-registration for run 2 (written and committed BEFORE run 2 starts)

## Run 1 (already complete, negative; reported in full)
- 3 rounds, validation set of 12 listeners x 2 sessions. Round 1 adopted one variant (+5.8 pts on validation, 95% CI +0.8..+11.3, best of 3 candidates). Rounds 2 and 3 rejected all 6 variants.
- Sealed test, run once (24 unseen listeners x 3 sessions): learner 34.3%, gen0 33.6%, final (gen1) 33.1%. Final vs gen0: -0.5 pts, CI -3.2..+2.0. **No measurable improvement.**
- Diagnosis: the validation gain was most likely selection luck (best of 3 on a small set). The keep rule was too easy to pass.
- Evidence: `results/final.md`, `results/final.json`, `runs/2026-10-17T20-56-34/`. These files are not edited or removed.

## What changes in run 2 (process only; no change to listeners' behaviour, scorer or gen0 team)
1. Fresh persona sets from a new seed (7001), disjoint from run 1: train 12, validation-A 40, validation-B 40 (replication), sealed test 40. The run-1 test set is never reused.
2. Two-stage gate: a variant is adopted only if it (A) beats the incumbent on validation-A by at least 3 pts with the paired 95% CI above 0, AND (B) replicates on the untouched validation-B with mean gain at least 2 pts and CI above 0. Only the best stage-A winner is replicated (one replication test per round).
3. Same models, same learner code as run 1, same 3 variants and up to 3 rounds. Hard cutoff by wall-clock time; if cut off, the latest adopted generation is final (gen0 if none).
4. Sealed test 2 is scored exactly once: final vs gen0 vs learner, 40 listeners x 3 sessions, same paired bootstrap.

## Success criterion (fixed now)
"The team improved itself" is claimed ONLY if, on sealed test 2, final minus gen0 has a paired 95% CI lower bound above 0. Otherwise we report run 2 as negative too. Both runs are reported together, in this order, whatever happens. Nothing about the test sets, the criterion or the gate is changed after seeing any result.

## Known limits (stated regardless of outcome)
Listeners are simulated, not people. The scorer never lets any agent see hidden taste. Two runs on one simulator is not evidence about real listeners.
