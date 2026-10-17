# Run 3 sealed test: before vs after self-improvement (new advisor model, wider surface; see PREREGISTRATION_RUN3.md)

40 unseen simulated listeners x 3 sessions (120 paired episodes). Score = share of thumbs-up after 5 warmup votes of 30.
Run: `tools/selfimprove/runs/run3`, final generation: gen0. Models: advisor nvidia/Nemotron-3.5-Lightning-30B-A3B; reviewer/rewriter nvidia/NVIDIA-Nemotron-3-Super-120B-A12B.

| Policy | Like rate | 95% CI |
| --- | --- | --- |
| Random (floor) | 29.0% | 26.7% - 31.3% |
| (a) Deterministic learner | 33.7% | 30.8% - 36.8% |
| (b) Advisor gen0 (original prompt/playbook/params) | 35.2% | 32.6% - 37.9% |
| (c) Advisor gen0 (after self-improvement) | 35.2% | 32.6% - 37.7% |
| Oracle (ceiling; reads hidden taste) | 70.3% | 67.2% - 73.4% |

| Comparison (paired) | Mean gain | 95% bootstrap CI | Per-listener wins / ties / losses |
| --- | --- | --- | --- |
| (b) gen0 vs (a) learner | +1.4 pts | -0.8 .. +3.6 | 24 / 4 / 12 |
| (c) final vs (b) gen0 | +0.0 pts | -0.2 .. +0.2 | 1 / 38 / 1 |
| (c) final vs (a) learner | +1.4 pts | -0.7 .. +3.6 | 24 / 4 / 12 |

**Run 3 success criterion (pre-registered): final minus gen0, paired 99% CI lower bound > 0 (95% only = suggestive). Result: +0.0 pts, 95% CI -0.2 .. +0.2, 99% CI -0.3 .. +0.2 -> NEGATIVE.**

Nothing was adopted (final = gen0): the criterion fails by construction and run 3 is negative.

Versus the plain learner (reported regardless of outcome):
- gen0 vs learner: +1.4 pts (95% CI -0.8 .. +3.6)
- final (gen0) vs learner: +1.4 pts (95% CI -0.7 .. +3.6)
