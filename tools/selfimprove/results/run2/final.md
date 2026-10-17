# Run 2 sealed test: before vs after self-improvement (two-stage gate, see PREREGISTRATION.md)

40 unseen simulated listeners x 3 sessions (120 paired episodes). Score = share of thumbs-up after 5 warmup votes of 30.
Run: `tools/selfimprove/runs/run2`, final generation: gen0. Models: advisor nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B; reviewer/rewriter nvidia/NVIDIA-Nemotron-3-Super-120B-A12B.

| Policy | Like rate | 95% CI |
| --- | --- | --- |
| Random (floor) | 22.5% | 20.1% - 25.3% |
| (a) Deterministic learner | 30.2% | 27.0% - 33.2% |
| (b) Advisor gen0 (original prompt/playbook/params) | 28.0% | 25.2% - 30.8% |
| (c) Advisor gen0 (after self-improvement) | 28.0% | 25.2% - 30.8% |
| Oracle (ceiling; reads hidden taste) | 65.0% | 61.6% - 68.6% |

| Comparison (paired) | Mean gain | 95% bootstrap CI | Per-listener wins / ties / losses |
| --- | --- | --- | --- |
| (b) gen0 vs (a) learner | -2.2 pts | -4.5 .. +0.2 | 15 / 5 / 20 |
| (c) final vs (b) gen0 | +0.0 pts | +0.0 .. +0.0 | 0 / 40 / 0 |
| (c) final vs (a) learner | -2.2 pts | -4.5 .. +0.2 | 15 / 5 / 20 |

**Primary success criterion (pre-registered): final minus gen0, paired 95% CI lower bound > 0. Result: +0.0 pts, CI +0.0 .. +0.0 -> FAIL.**
