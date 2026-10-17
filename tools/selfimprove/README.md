# Self-improving taste team (hackathon track)

An agent team on Crusoe Managed Inference (NVIDIA Nemotron) that improves itself from its own run history. After each round it reviews what worked and what didn't, rewrites its own prompt, playbook and team parameters, keeps a change only if a deterministic gatekeeper measures a gain on held-out listeners, and proves the result once on a sealed test set it has never seen.

Offline only. This lane never touches the real-time path (relay, player, controller) and is not an MVP dependency. The LLM never controls Lyria and never writes prompt text that reaches the music model: it only proposes feature IDs from the fixed vocabulary, and the learner's own `toTarget` canonicalizes them.

## Team

| Agent | Model | Job |
| --- | --- | --- |
| Learner | none (deterministic, `src/learner`) | Keeps per-feature scores from 👍/👎 and proposes the next target. |
| Advisor (`advisor.ts`) | fast: `NVIDIA-Nemotron-3-Nano-30B-A3B`, thinking off | Every `advisorEveryNVotes` votes, reads the recent vote history (feature IDs and 👍/👎 only) plus its prompt and playbook, and proposes `candidateCount` feature sets as JSON. |
| Chooser (in `advisor.ts`) | none (deterministic) | Picks between the learner's target and the advisor's validated candidates by learner score + `llmCandidateBonus` + `noveltyBonus`. The LLM never picks the final target. |
| Reviewer (`reviewer.ts`) | strong: `NVIDIA-Nemotron-3-Super-120B-A12B` | Reads compact TRAIN transcripts and writes a diagnosis. |
| Rewriter (`rewriter.ts`) | strong | Gets the current artifacts, the diagnosis and the full history of accepted/rejected attempts, and returns N variant bundles. |
| Gatekeeper (`gatekeeper.ts`) | none (deterministic, frozen) | Keeps a variant only if the paired mean gain on validation is at least the margin (2 pts) AND the 95% bootstrap CI excludes 0. |

## The editable surface (`artifacts/`)

| File | What the Rewriter may change |
| --- | --- |
| `advisor_prompt.md` | Advisor instructions. The output format (JSON, allowed IDs, group limits) is appended by code and cannot be edited away. |
| `playbook.md` | Lessons learned, shown to the advisor. |
| `params.json` | Only the whitelisted keys in `params.ts`, each with min/max bounds enforced in code (out-of-range values are clamped, unknown keys dropped, non-numbers rejected): `advisorStartVote` [1,15], `advisorEveryNVotes` [1,10] (team structure: how often the LLM is in the loop), `historyWindow` [3,30], `candidateCount` [1,5], `llmCandidateBonus` [-0.5,0.5], `noveltyBonus` [0,0.5], `temperature` [0,1]. |

Frozen (never editable by the team): `personas.ts`, `simulator.ts` scoring, `stats.ts`, `gatekeeper.ts`, `src/learner`.

## Loop (`loop.ts`)

Each round:

1. Run the incumbent on TRAIN personas and collect transcripts (vote sequence, the target played, whether the learner or an advisor candidate chose it, advisor call outcomes, episode score).
2. Reviewer writes a diagnosis.
3. Rewriter proposes N variants; malformed ones are rejected and logged.
4. Incumbent and every variant run on VALIDATION personas with identical paired seeds.
5. Gatekeeper decides; the best accepted variant becomes the next generation, otherwise the incumbent is kept (revert).
6. Every attempt goes to `runs/<timestamp>/changelog.jsonl` (variant hash, val score, incumbent score, paired gain and CI, decision, reason, param clamping warnings, per-round LLM calls/tokens). Each generation's artifacts are written to `runs/<timestamp>/gen<k>/`; each round's transcripts, diagnosis, raw rewriter output and variants to `runs/<timestamp>/round<k>/`. The attempt history is fed back to the Rewriter in the next round.

The loop never loads the sealed TEST personas (a unit test checks the source).

## Final evaluation (`final.ts`)

Run once, on the 24 sealed TEST personas x 3 sessions: (a) deterministic learner, (b) advisor gen0 (original prompt/playbook/params, from `runs/<run>/gen0`), (c) advisor final generation. It reports paired bootstrap CIs for b-a, c-b and c-a, per-listener win/tie/loss counts, plus random and oracle reference lines, and writes `results/final.json` and `results/final.md`. A lock file (`results/final.lock`) refuses a second scoring; `--force` overrides it and the result records that it was forced. The lock is taken before scoring starts, so a crashed run also needs `--force` to retry (and is recorded as forced).

## Run 1 vs Run 2

The design of run 2 was fixed and committed before it ran: see [`PREREGISTRATION.md`](PREREGISTRATION.md).

| | Run 1 (negative, reported in `results/final.md`) | Run 2 (`--design run2`) |
| --- | --- | --- |
| Listeners | seed 2026: train / val 12 / sealed test 24 | seed 7001 (disjoint): train 12 / valA 40 / valB 40 / sealed test 40 |
| Gate | val gain >= 2 pts and paired CI > 0 | stage A on valA: gain >= 3 pts and CI > 0; only the best stage-A passer is replicated on valB: gain >= 2 pts and CI > 0 |
| Cutoff | none | `--deadline-minutes N`: no new round or stage starts after N minutes; latest adopted generation is final (gen0 if none) |
| Sealed test | `final.ts` -> `results/final.{md,json,lock}` | `final.ts --test-set run2 --run <dir>` -> `results/run2/final.{md,json,lock}` (own lock), with an explicit PASS/FAIL line for the pre-registered criterion (final minus gen0, CI lower bound > 0) |

Same models, same learner code, same gen0 bundle (`artifacts/`), same 3 variants and up to 3 rounds. Run-1 files and `runs/2026-10-17T20-56-34/` are left untouched.

```sh
npx tsx --env-file-if-exists=.env tools/selfimprove/loop.ts --design run2 --rounds 3 --variants 3 --concurrency 16 --deadline-minutes 40 --out tools/selfimprove/runs/run2
npx tsx --env-file-if-exists=.env tools/selfimprove/final.ts --test-set run2 --run tools/selfimprove/runs/run2   # once
```

## Reproducibility and cost

- `llm.ts` caches every non-empty response on disk under `.cache/` (gitignored), keyed by sha256(model, messages, temperature, thinking flag). Reruns are free and deterministic, and identical in-flight requests share one call so paired runs stay paired on a cold cache.
- Per-role call, cache-hit, error and token counts are logged per round and in `summary.json`.
- Episodes run with bounded concurrency (`--concurrency`, default 6) and results keep a deterministic order.
- Nemotron reasons before answering by default. The advisor turns that off (`chat_template_kwargs.enable_thinking=false`, added as the optional `thinking` flag in `crusoe.ts`), which is about 6x faster for this task. Reviewer and Rewriter keep thinking on with large `max_tokens`.

## Commands

The `pnpm` scripts exist, but `pnpm` currently re-runs an install check that the supply-chain guard blocks, so the direct commands are listed too.

```sh
# no key needed
npx tsx tools/selfimprove/baseline.ts                 # pnpm selfimprove:baseline  (random / learner / oracle on train+val)
npx vitest run tools/                                 # unit tests, no network (fake LLM client)

# needs CRUSOE_API_KEY in .env
npx tsx --env-file-if-exists=.env tools/selfimprove/smoke.ts   # pnpm selfimprove:smoke
npx tsx --env-file-if-exists=.env tools/selfimprove/loop.ts    # pnpm selfimprove:loop
  # flags (or env): --rounds 4 (SELFIMPROVE_ROUNDS) --variants 3 --train-personas 8 --train-reps 1
  #                 --val-personas 12 --val-reps 2 --concurrency 6 --margin 0.02 --from <bundle dir> --out <dir> --no-cache
npx tsx --env-file-if-exists=.env tools/selfimprove/final.ts --run tools/selfimprove/runs/<timestamp>   # pnpm selfimprove:final
  # flags: --reps 3 --concurrency 6 --force (re-score the sealed test set; recorded as forced)
```

## Honest limitations

- **Simulated listeners are a proxy for people.** Personas have additive taste, pair effects, pickiness, fatigue from repeats, and noise. A team that learns to exploit this simulator (for example, by avoiding repeats) may not transfer the same gain to real listeners.
- **Small samples.** Validation is 12 listeners x 2 sessions (24 paired episodes) and the test set is 24 x 3. Gains of a few points are within noise; the gatekeeper's CI rule rejects many plausible improvements, and picking the best of several accepted variants still slightly overstates the validation gain. The sealed test set is the unbiased check.
- **Cached nondeterminism.** With the cache on, one sampled LLM answer per exact prompt is reused, so a policy's score is one draw, not an average over sampling noise.
- **The LLM's role is bounded on purpose.** It only proposes candidate feature sets; the deterministic chooser can ignore it entirely (a negative `llmCandidateBonus`). Part of any measured gain can come from parameter changes (for example `noveltyBonus`) rather than from better language reasoning; the changelog shows which knobs each accepted variant moved.
- **No live music.** The loop never calls Lyria; scores measure targets chosen, not audio quality.
