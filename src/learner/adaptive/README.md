# Adaptive learner experiment

This optional module leaves `src/learner/index.ts` intact. Import the same four functions from `src/learner/adaptive`, plus `inspect` for diagnostics. It is deterministic, synchronous, browser-safe, and has no storage, clocks, network, or timers.

```ts
let state = createLearner(42, 'focus'); // focus | relax | energy | explore
let target = initialTarget(state);
({ state, target } = processVote({
  state, audible: heardBlend, currentTarget: target, vote: 'up', evidenceWeight: 1,
}));
target = evolveNoVote({ state, target, step: 1 }); // after adequate exposure
const diagnostics = inspect(state, target);
```

Both thumbs fit the whole normalized heard blend with a full 18 × 18 regularized linear model. They do not independently reward or punish every ingredient. With `x` normalized over all valid audible features, reward `r` of ±1, and evidence weight `w` clamped to 0..1:

```
g = 0.995 ** w
A = g A + (1 - g) 0.35 I + w x xᵀ
b = g b + w r x
theta = solve(A, b)
```

Cholesky triangular solves compute coefficients and candidate uncertainty without explicitly inverting the matrix. Empty audible evidence, zero weight, or non-finite weight produces no update or forgetting. Every explicit click still increments `votes`. `scores` exposes the regression coefficients for compatibility; these are neither probabilities nor independent causal preferences. Positive/negative evidence totals are discounted effective weights, not observed acceptance rates.

A bounded recovery heuristic addresses abrupt reversals that conservative forgetting alone handles slowly. A dislike counts as surprising only when the **before-vote** prediction is above 0.2 and directional information above 0.6. Collect two effective evidence units across at least two meaningfully different heard blends (normalized total variation at least 0.15); cap any one blend's contribution at one. Then retain 25% of old `A - 0.35 I`, `b`, and evidence totals, and add the latest feedback at its full supplied weight. Recovery is disarmed until an effective positive vote, preventing repeated resets within the same rejection episode. Zero-weight clicks cannot accumulate surprise, rearm recovery, or discount evidence. Rejecting an already predicted-poor exploratory option does not count as surprise. State holds a bounded six-blend surprise ledger and exposes recovery count/latest recovery vote for diagnostics.

This is one predeclared revision after an independent abrupt-reversal simulation exposed slow adaptation. The 25% retention and thresholds are uncalibrated heuristics, not an inferred change-point probability. Different prompt blends and controller-supplied weights are only a proxy for independent listening exposure; the learner cannot prove that two clicks reflect independent audio judgments. The correction needs before/after evaluation on the same fixtures, including stable and noisy tastes, rather than assuming stronger forgetting always helps.

Selection evaluates all 375 one-genre, one-instrument, one-mood, one-texture recipes. Prediction, model uncertainty, a weak purpose hint, transition cost, and seeded tie noise rank candidates. Purpose favors mood/texture but excludes no genre and changes no evidence. Model uncertainty retains the ambiguity of ingredients only heard together. `inspect().coverage` is average marginal information reduction, and `information` concerns the current blend only; neither is a calibrated confidence percentage. Phases depend on current predicted support and directional information, not just vote count. Repeated effective rejections reopen search. These are tunable heuristics, not statistical confidence bounds.

The renderer uses the team's vocabulary phrasings. Initial and newly introduced features receive a seeded phrasing; retained features keep their exact prompt text. `Target.phrasingSalt` stays fixed through the session so a mid-transition like can restore the original wording of an outgoing feature even after it left the pending target. Likes hold prompt text and weights, allowing controller equality checks to avoid needless ramps. Adaptive scheduled variations already change recipe identities, so this module does not additionally reword a retained feature at the baseline learner's 35% cadence. Learning remains over the same 18 feature IDs; variants such as felt/Rhodes/prepared piano differ musically, and the model does not claim to learn those subtypes separately.

A like holds the projected heard blend immediately. A dislike excludes the heard and pending recipe identities; it often searches nearby when the current family is supported and searches more broadly when evidence is weak or rejections accumulate. It does not always replace the genre. Scheduled `evolveNoVote` picks a nearby identity variation, with occasional broader probes; supported probes normally stay within 0.25 predicted reward of the current blend. Every scheduled change preserves all state, including A, b, scores, votes, RNG seed and evidence totals. Silence never becomes a synthetic thumb. `step` is a deterministic novelty counter; absent one, target decision metadata advances it. There is no retained exposure-history model in this first version, so the controller must schedule adequate listening windows.

`Target.lastDecision` explains the action and records its step, prediction and uncertainty. `inspect(state, target)` returns `phase`, `reason`, `evidence`, ranked coefficients, prediction, uncertainty, purpose, and information diagnostics. These diagnostics describe the prompt model, not acoustic measurements. UI should present them as experimental explanations and avoid calling coefficients “favorite ingredients” or uncertainty a likelihood.

The controller supplies the heard mixture after accounting for buffering and an `evidenceWeight` to limit correlated rapid clicks. This module cannot infer independent listening exposure from click count. The controller owns ramps, send cadence, timing, playback, and revisions. For a matched memory ablation, reset A, b, scores and effective evidence totals from `createLearner(state.seed, state.purpose)` while retaining action/RNG history and target metadata; surprise bookkeeping is policy history and cannot trigger without model-supported predictions. Older serialized experimental states lack the new recovery fields and require fresh initialization; persistence is outside this session-only experiment.

This is a practical MVP hypothesis. The additive model cannot represent arbitrary genre/instrument interactions, prompt controls may not match audible content, conservative forgetting can adapt slowly, and uncertainty/probe weights require comparison with simple baselines. Repeated likes identify support for a blend without identifying every ingredient. No convergence or listening-quality claim follows from the unit tests. Run synthetic baselines and real listening evaluation before adopting it as an improvement.

Validation: `vitest run src/learner/adaptive`, then the repository typecheck/build. Tests cover the exact coupled update, fractional/zero evidence, heard-vs-pending attribution, uncertainty under repeated co-occurrence, purpose priors, unchanged silent evidence, continued post-like variety, replay, finite long-run behavior, exact recovery algebra/latest-feedback retention, and suppression of resets for correlated or expected-poor rejections.
