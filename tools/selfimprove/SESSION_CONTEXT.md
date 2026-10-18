# tools/selfimprove: session context (for starting a new thread)

Written 2026-10-17 ~17:00, extended later the same day with sections 11 to 13 (next phase and starter prompts). Read this first. It is a snapshot of what exists, what was decided, and what is left. Nothing here contains secrets.

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

## 11. Next phase: make it real (simulated listeners to real listeners)
Framing sentence used on our pages: "For now those listeners are simulated, and real listeners come next. The team runs on Crusoe Managed Inference using NVIDIA Nemotron models."

What changes when listeners are real:
- **A person cannot be replayed.** A simulator can run two team versions on the same listener. A real listener hears a session once and is changed by it. So an offline replay of a logged session can only say how a different policy *would have scored the same votes*, not how that person would have voted. A live comparison needs two versions assigned to different people (between-subjects) or to the same person in random order (crossover).
- **What the app already gives us:** each listener's browser stores their feedback locally (IndexedDB database `sway-preferences`, stores `profiles`, `feedback`, `metadata`), the player screen has Export and Reset controls, and the controller exposes `exportFeedback()` and `resetPreferences()`. Each feedback record holds the vote, the blend that was audible, the evidence weight and the targets before and after. Nothing goes to a server.
- **Metric candidates:** share of thumbs-up early versus late in a session (does it fit better over time?), and a blind forced-choice question after each session ("which fit your taste better?"), asked outside the app UI. Report the two separately.
- **Honest limits:** small samples; a few people cannot show significance; the team cannot learn live during a short demo, so we compare pre-built versions; a negative or unclear result is a valid outcome.
- **Rules carried over:** pre-register design, metric and success rule in a committed file BEFORE any real session; the three old sealed sets stay consumed; consent and no personal data; exports never committed; never print keys; no improvement claims we did not measure.

Two realistic setups (a tailored starter prompt for each is in section 12):
- **A. Live demo:** many people, 3 to 10 minutes each, one version per person assigned at random, about 10 to 30 listeners. Weak on proof; mostly "what real people did".
- **B. Small private test:** about 5 to 10 people, a few days, 2 to 3 sessions of 10 to 15 minutes each, blind crossover (everyone hears both versions in random order) plus a forced-choice question. Stronger design, slower.

Known prerequisite gap: the shipped app uses the **adaptive learner**, but all runs here used the original deterministic learner. Decide which policy the real-listener study compares, and say so in the pre-registration.

## 12. Starter prompts for a new thread (copy as written)
Generic ("make it real"):
```
Read tools/selfimprove/SESSION_CONTEXT.md first, then docs/SELFIMPROVE_RESULTS.md. Do not start work until you have summarized, in a few lines, what exists and what the three runs showed.

Goal: make it real. So far our self-improving team ran on Crusoe Managed Inference with NVIDIA Nemotron models, scored only on simulated listeners. Real listeners come next. Help me design and, once I approve, build the step from simulated to real listeners, keeping the same rule: a change stays only if it measurably beats the old version on listeners the team has never met.

Constraints:
- All three existing sealed test sets are used up. Any new experiment needs a new pre-registration committed before it runs, plus fresh listeners.
- Real people cannot be replayed. Think hard about what we can fairly measure: the app already stores each listener's feedback in the browser and has an export function. Say what an offline replay of that log can and cannot prove, versus a live comparison of two team versions on different listeners.
- Handle real listener data carefully: get consent, keep it local or anonymized, never commit it, never print API keys.
- Do not claim an improvement we did not measure. Report negative results as they are.
- Do not re-score old sealed sets. Do not edit the frozen files listed in the context file.

Start by asking me the questions you need (how many listeners, how long, where they listen, what we are allowed to store), then propose a study design and a short plan with the smallest first experiment. Wait for my approval before writing code. Use pnpm-free commands (npx tsx / vitest) as the context file explains.
```

Version A, live demo:
```
Read tools/selfimprove/SESSION_CONTEXT.md first, then docs/SELFIMPROVE_RESULTS.md. Summarize in a few lines what exists and what the three runs showed before doing anything else.

Goal: make it real for a LIVE DEMO. People at the event listen to Sway for a few minutes each. Our self-improving team runs on Crusoe Managed Inference with NVIDIA Nemotron models, but so far it was only scored on simulated listeners. Design a small, honest way to learn something from real listeners at the demo.

Setting and limits:
- Many different people, each for only 3 to 10 minutes. No time for the team to learn live; we compare two pre-built team versions (for example the starting team versus the best alternative) and assign each listener one version at random.
- Measure what the product claims: does the share of thumbs-up rise over a session? Compare early votes with later votes, per version. The app already stores each listener's feedback locally in the browser and can export it.
- Expect a small sample (perhaps 10 to 30 people). Say plainly what that sample can and cannot show. No claims of significance unless the numbers earn it.

Rules:
- Pre-register the design, the metric and the success rule in a file and commit it BEFORE the demo. The old sealed test sets are used up; do not re-score them.
- Consent and privacy: a one-line notice, no personal data, data stays local or anonymized, never committed. Never print API keys.
- Do not claim an improvement we did not measure. Report negative or unclear results as they are.
- Do not edit the frozen files listed in the context file. Use pnpm-free commands (npx tsx / vitest).

Start by asking me what you need (how many people we expect, how long the demo runs, which device they use), then propose the smallest design and the steps to get it demo-ready, including a quick way to assign versions and collect the exports. Wait for my approval before writing code.
```

Version B, small private test (friends and family):
```
Read tools/selfimprove/SESSION_CONTEXT.md first, then docs/SELFIMPROVE_RESULTS.md. Summarize in a few lines what exists and what the three runs showed before doing anything else.

Goal: make it real with a SMALL PRIVATE TEST of about 5 to 10 people I know, over a few days. Our self-improving team runs on Crusoe Managed Inference with NVIDIA Nemotron models, but it was only scored on simulated listeners so far. Design a study that can tell us whether the team's version of Sway fits real tastes better than the starting version.

Setting and limits:
- Each person does two or three sessions of 10 to 15 minutes. Use a blind crossover: every person hears both team versions, in random order, without being told which is which. That gives more power than one version per person.
- After each session ask one short forced-choice question outside the app UI ("which session fit your taste better?"), plus the app's own feedback log, which each listener's browser stores locally and can export.
- Fix the primary metric and the success rule first. Report the forced-choice result and the thumbs-based result separately and say honestly how small the sample is.

Rules:
- Pre-register the design, the metric and the success rule in a file and commit it BEFORE the first session. The old sealed test sets are used up; do not re-score them.
- Get informed consent, collect no personal data beyond what we need, keep exports out of git, and never print API keys.
- Do not claim an improvement we did not measure. Report negative or unclear results as they are.
- Do not edit the frozen files listed in the context file. Use pnpm-free commands (npx tsx / vitest).

Start by asking me what you need (who, how many, how long, where they listen, what we may store), then propose the study design, the analysis plan and the smallest first step. Wait for my approval before writing code.
```

## 13. Material produced after the first version of this file
- **Pages (private artifacts, share from the page's Share menu):** results story https://claude.ai/artifact/N6uaYr4r885VuJJ5j4ue1N (version 2, with the loop drawn as a ring and a bar chart per run). Crusoe and Nemotron story https://claude.ai/artifact/TyTHJRz2Zc1LRqp8SF9SBR (version 4): headline "Music that learns you, and improves itself based on the listener", a hand-drawn sketch of the loop, "Why we built on Crusoe", "The right model for the right job", "What we plan to achieve". The section "Who does each job in the loop" was removed on request. Hand-drawn diagram source: `docs/self-improving-loop.excalidraw`.
- **50-word brief (reusable):** "Sway is endless instrumental music, generated by Google's Lyria, that learns your taste from two buttons: thumbs up and thumbs down. The music never stops. Alongside it, an AI team on Crusoe and NVIDIA Nemotron proposes improvements and keeps one only if it beats the old version on unseen listeners."
- **Crusoe usage statement (summary of what was drafted):** Crusoe powers the offline self-improving team only; Lyria powers the live music. OpenAI-style API with a console key kept in a gitignored `.env`; Nano or Lightning as the high-volume advisor (thinking off), Super as reviewer and rewriter (thinking on); roughly 20,000 model calls across the three runs and tests at 12 to 24 in parallel; retries with backoff; disk cache; no GPUs or servers to run.
- **Crusoe feedback (summary):** easy OpenAI-compatible start, fast steady small models, `/models` is the source of truth; docs inconsistent on endpoints, IDs and key menu paths; Super (120B) failed over half of calls at 16 to 32 parallel with no published limits to explain it; reasoning on by default and the off switch is hard to find; no capability or speed hints in the model list; cost visibility unclear.
- **Partner feedback (summary):** Nemotron followed vocabulary-restricted JSON very reliably; Lyria: strong live steerable stream, but docs omit that `sampleRateHz` is rejected, the hard 10 minute session cap closes with a misleading error, browser-safe tokens do not work (relay required), prompt weights are normalized (only ratios matter), quotas and pricing unpublished.
- **Main repo around this time:** most app PRs merged (#1 to #4, #6 to #8, #10, #12, #14, #17, #19); #13 (docs) and #15 (this lane) open and fast-forwardable; #16 and #18 (text and song requests) stale against `main`; issue #9 open. README was rewritten by a teammate to tell the same Crusoe and Nemotron story. Re-check with `git fetch` and `gh pr list` before acting.
