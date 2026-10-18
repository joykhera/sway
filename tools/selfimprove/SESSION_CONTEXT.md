# tools/selfimprove: session context (for starting a new thread)

Written 2026-10-17 ~17:00. Read this first. It is a snapshot of what exists, what was decided, and what is left. Nothing here contains secrets.

## 1. What this lane is
An **offline** agent team for the Crusoe hackathon prompt: "an agent team on Crusoe Managed Inference that improves itself, keeps a change only if it measurably helps, and proves it with a before-and-after score on tasks it has not seen." It uses NVIDIA Nemotron models through Crusoe's OpenAI-compatible API. It never touches the live music path (relay, player, controller, learner).

Product context: **Sway** plays endless instrumental music (Google Lyria RealTime, via a Node relay) steered only by thumbs up/down. This lane tries to improve *how the next musical direction is chosen*, scored on **simulated listeners** with hidden tastes.

## 2. Where things are (git state at time of writing)
- Repo: `https://github.com/joykhera/sway`. Local main checkout: `/Users/4625labs/Workspace/Hackathons/crusoe-hackathon/sway-remote`.
- **PR #15** (open, not merged, no reviews): branch `feat/selfimprove-tools` (head was `9c6230a` before this file was added on top; check `git log`). It contains everything in this folder, the three runs' evidence, `docs/SELFIMPROVE_RESULTS.md` and `docs/SUBMISSION_DRAFT.md`. It was fast-forwardable on `main` at last check, with tsc clean and 546 tests passing.
- The local checkout `sway-remote` is on branch `feat/selfimprove-scaffold` (an older line of the same work, local only). Its working tree has **uncommitted** edits to `advisor.ts, final.ts, loop.ts, params.ts, personas.ts` (run 3 code). The same changes are already committed on `feat/selfimprove-tools`. **Prefer working from `feat/selfimprove-tools`.**
- A worktree for that branch exists at `/private/tmp/claude-502/wt-si`, which is a temporary folder and may disappear. For a stable copy: `git fetch origin && git worktree add ~/sway-selfimprove origin/feat/selfimprove-tools` (then symlink or install `node_modules`).
- `docs/self-improving-loop.excalidraw` (hand-drawn diagram) is untracked in `sway-remote/docs/`.
- Other PRs (by teammates, not this lane) may have changed `src/controller`, `src/learner`, `src/shared`. This lane imports from `src/learner` (read-only), so check `tsc` after pulling `main`.

## 3. Files in `tools/selfimprove/`
| File | Role | Editable by the rewriter? |
| --- | --- | --- |
| `personas.ts` | Simulated listeners (hidden taste, pair effects, pickiness, fatigue, noise); split functions for each run | No (frozen) |
| `simulator.ts` | Runs a 30-vote session; score = share of thumbs-up after 5 warmup votes | No (frozen) |
| `stats.ts`, `gatekeeper.ts` | Paired bootstrap CI; keep-or-revert rule | No (frozen) |
| `crusoe.ts` | Crusoe client: retries 429/5xx with backoff, optional `thinking:false`, never logs the key | No |
| `llm.ts` | Gateway: on-disk response cache (`.cache/`, gitignored), call/token stats, timeouts, JSON parsing | No |
| `advisor.ts` | Policy: wraps the deterministic learner; every N votes asks Nemotron for 3 candidate directions; a deterministic scorer picks | via params |
| `reviewer.ts`, `rewriter.ts` | Strong model reviews transcripts, drafts bounded variants | n/a |
| `params.ts` | Whitelisted, clamped team parameters | n/a |
| `loop.ts` | Improvement loop. `--design run2` / `run3` = two-stage gate | n/a |
| `final.ts` | Sealed-test scoring with single-use lock files | n/a |
| `refs.ts`, `baseline.ts`, `smoke.ts`, `team.ts` | Reference lines (random, oracle), baseline print, Crusoe smoke test, shared wiring | n/a |
| `artifacts/advisor_prompt.md`, `playbook.md`, `params.json` | **The team's editable surface** (starting bundle = "gen0") | Yes |
| `PREREGISTRATION.md`, `PREREGISTRATION_RUN3.md` | Binding written designs, committed before runs 2 and 3 | no |
| `runs/`, `results/` | Evidence: `runs/2026-10-17T20-56-34` (run 1), `runs/run2`, `runs/run3`; `results/final.*` (run 1), `results/run2/`, `results/run3/` | no |
| tests | `gatekeeper.test.ts, selfimprove.test.ts, run2.test.ts, run3.test.ts` (no network) | |

Params (gen0): `advisorStartVote 3, advisorEveryNVotes 3, historyWindow 12, candidateCount 3, llmCandidateBonus 0.05, noveltyBonus 0, temperature 0.4`, plus run-3 knobs `learnerScoreWeight 1, repeatPenalty 0, deferToLearnerProbability 0, poolMaxAge 30` (defaults reproduce the old behaviour exactly; a test asserts this).

## 4. The three runs (all negative on improvement)
All three evaluate the **original deterministic learner** (`src/learner/index.ts`), not the adaptive learner that the app now ships (`src/learner/adaptive/`).

| Run | Design | Loop outcome | Sealed test (like rate) |
| --- | --- | --- | --- |
| 1 (not pre-registered) | 3 rounds x 3 variants, validation 12x2 | 1 variant adopted (+5.8 pts val, CI +0.8..+11.3, best of 3) | seed 2026, 24x3: random 26.3, learner 34.3, gen0 33.6, gen1 33.1, oracle 68.1. gen1 vs gen0 -0.5 (CI -3.2..+2.0) |
| 2 (pre-registered) | stricter two-stage gate, valA/valB 40x2 | 9 variants, none passed; final = gen0 | seed 7001, 40x3: random 22.5, learner 30.2, gen0=final 28.0, oracle 65.0. gen0 vs learner -2.2 (CI -4.5..+0.2) |
| 3 (pre-registered, 99% bar) | Lightning advisor + wider params, valA/valB 30x2 | 6 variants, none passed; final = gen0 | seed 9001, 40x3: random 29.0, learner 33.7, gen0=final 35.2, oracle 70.3. gen0 vs learner +1.4 (CI -0.8..+3.6), not significant |

Honest reading: no improvement found. Run 1's validation win did not survive the sealed test. A weak, non-significant hint in run 3 that the new advisor model slightly beats the plain learner.

## 5. Rules and decisions to respect
- **All three sealed test sets are consumed** (locks: `results/final.lock`, `results/run2/final.lock`, `results/run3/final.lock`). Do not re-score them (`--force` records a forced rescoring; do not use it to chase a better number). **Any new experiment needs a new persona seed, a new pre-registration committed before running, and a new sealed test.**
- Multiplicity: it is already a third attempt. Report all runs together, in order, whatever happens. Never claim an improvement that was not measured.
- Frozen files: `personas.ts` scoring behaviour, `simulator.ts` scoring, `stats.ts`, `gatekeeper.ts`. `src/learner` is not edited by this lane.
- Leakage guard: no prompt or transcript may contain persona hidden taste (tests enforce this).
- Never print or commit API keys. Keys live in the gitignored `.env` (`CRUSOE_API_KEY`, `GEMINI_API_KEY`); checked: no key value in any committed file.

## 6. How to run
`pnpm` scripts are **blocked on this machine** by pnpm's supply-chain guard (one lockfile entry, `@asamuzakjp/css-color@7.1.7`, was too new). Dependencies were installed once with the one-off flag `--config.minimumReleaseAgeExclude=@asamuzakjp/css-color`. Use these direct commands:
```sh
npx tsx tools/selfimprove/baseline.ts                                    # no key; random / learner / oracle lines
npx tsx --env-file-if-exists=.env tools/selfimprove/smoke.ts             # lists Nemotron models, one call each
npx vitest run tools                                                     # tool tests, no network
npx tsc --noEmit                                                         # typecheck whole repo
# example loop (run 3 settings), then the single sealed test:
npx tsx --env-file-if-exists=.env tools/selfimprove/loop.ts --design run3 --rounds 2 --variants 3 --concurrency 24 --deadline-minutes 25 --out tools/selfimprove/runs/run3 --advisor-model nvidia/Nemotron-3.5-Lightning-30B-A3B
npx tsx --env-file-if-exists=.env tools/selfimprove/final.ts --test-set run3 --run tools/selfimprove/runs/run3 --concurrency 24
```
Baseline numbers (train/val): random 25.3/21.9, learner 32.7/30.3, oracle 67.9/66.8. They reproduce identically on current `main`.

## 7. Crusoe and Nemotron facts learned
- Base URL `https://api.inference.crusoecloud.com/v1` (OpenAI-compatible), key from the Crusoe console. 13 models were listed. Real IDs carry an `NVIDIA-` prefix for some: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`, `nvidia/Nemotron-3.5-Lightning-30B-A3B` (also listed: `Nemotron-3-Nano-Omni-Reasoning-30B-A3B`, `NVIDIA-Nemotron-3.5-Super-VL`). Always confirm via `/models` or the smoke test.
- Roles: advisor = Nano (runs 1-2) or Lightning (run 3), thinking **off**; reviewer and rewriter = Super, thinking **on**. Override the advisor model with `CRUSOE_MODEL_ADVISOR` or `--advisor-model`.
- Reasoning is on by default and costs time: a trivial call was about 375 tokens and 3.2 s versus about 48 tokens and 0.5 s with `chat_template_kwargs: {enable_thinking: false}`.
- Super (120B) as the advisor was unusable at scale: median 10-14 s per call, over half of calls failing at 16 and 32 parallel. Nano and Lightning: median about 2 s, no errors at 16-32 parallel (probe of 80 calls).
- Volume per run: run 2 about 9,500 advisor calls, 1 reviewer, 3 rewriter. Run 3 about 3,800 advisor calls (about 1.5% errors, which fall back to the learner). Rewriter and reviewer produced no malformed output.
- Cache behaviour: when the incumbent is unchanged, rounds replay the same cached train run and diagnosis, so the reviewer sees identical input each round; only the rewriter's history changes. Failed calls are not cached, so re-scoring identical teams can differ by a few listeners.

## 8. Known issues and gaps
- The app ships the **adaptive learner**, whose interface changed (`createLearner(seed, purpose?)`, `processVote(... evidenceWeight)`, `evolveNoVote(... step, intent)`, an `intent` decision kind). This lane's baseline policy still uses the deterministic learner. Evaluating the shipped learner in the simulator is untested.
- Simulated listeners are a proxy. Nothing here says anything about real people.
- The advisor never saw anything but vote history and feature IDs; it cannot hear the music. This may bound what any prompt rewrite can achieve.
- Run 1 was not pre-registered; a marketing/submission page once implied otherwise and was corrected.

## 9. Open items and sensible next steps
1. **Merge PR #15** (Joy or the user), so the lane and the results are on `main`. Rebase first if `main` moved.
2. If continuing the science: pick a *different hypothesis* before running (for example, evaluate the shipped adaptive learner as the baseline, or give the advisor richer information), write a new pre-registration with a new seed, commit it, then run. Validate on validation sets only until the single sealed test.
3. Optional: add an adaptive-learner policy to `baseline.ts` for a validation-only comparison.

## 10. Related material
- Write-up: `docs/SELFIMPROVE_RESULTS.md`. Submission draft: `docs/SUBMISSION_DRAFT.md`. Diagram: `docs/self-improving-loop.excalidraw`.
- Published pages (private artifacts): results story https://claude.ai/artifact/N6uaYr4r885VuJJ5j4ue1N; Crusoe and Nemotron story https://claude.ai/artifact/TyTHJRz2Zc1LRqp8SF9SBR.
- Team handoff: `docs/HANDOFF.md`. Lyria facts: `docs/lyria-smoke-report.md`.
