# Sealed test: before vs after self-improvement

24 unseen simulated listeners x 3 sessions (72 paired episodes). Score = share of thumbs-up after 5 warmup votes of 30.
Run: `tools/selfimprove/runs/2026-10-17T20-56-34/`, final generation: gen1. Models: advisor nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B; reviewer/rewriter nvidia/NVIDIA-Nemotron-3-Super-120B-A12B.

| Policy | Like rate | 95% CI |
| --- | --- | --- |
| Random (floor) | 26.3% | 23.2% - 29.6% |
| (a) Deterministic learner | 34.3% | 30.3% - 38.4% |
| (b) Advisor gen0 (original prompt/playbook/params) | 33.6% | 30.4% - 36.9% |
| (c) Advisor gen1 (after self-improvement) | 33.1% | 29.5% - 36.5% |
| Oracle (ceiling; reads hidden taste) | 68.1% | 63.9% - 71.9% |

| Comparison (paired) | Mean gain | 95% bootstrap CI | Per-listener wins / ties / losses |
| --- | --- | --- | --- |
| (b) gen0 vs (a) learner | -0.7 pts | -3.2 .. +1.7 | 10 / 0 / 14 |
| (c) final vs (b) gen0 | -0.5 pts | -3.2 .. +2.0 | 11 / 1 / 12 |
| (c) final vs (a) learner | -1.2 pts | -4.4 .. +1.9 | 10 / 3 / 11 |
