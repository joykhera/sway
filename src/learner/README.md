# Preference learner

Person C's synchronous, browser-safe module for the Sway MVP. Import the four functions and types from `src/learner/index.ts`. It has no network, timers, storage, audio, or UI dependencies.

```ts
import { createLearner, initialTarget, processVote, evolveNoVote } from './learner';

let state = createLearner(42);
let target = initialTarget(state);

// D supplies an estimate at click time, including audio-buffer delay.
const result = processVote({
  state,
  audible: target.features, // substitute the actual estimated blend during a ramp
  currentTarget: target,
  vote: 'down',
});
state = result.state;
target = result.target;
// D supersedes its previous ramp and transitions to target.prompts.

// D schedules passive changes; do not synthesize a vote for silence.
target = evolveNoVote({ state, target });
```

## Integration contract

- `LearnerState` contains 18 preference scores, the explicit vote count and a numeric RNG seed. D holds it in tab memory, supplies the latest returned state for every click, preserves it on reconnect and creates a fresh learner on refresh.
- `FeatureBlend` is a sparse map of vocabulary IDs to intensities in **0..1**. Missing, non-finite, zero, negative and unknown entries contribute no evidence; intensities above 1 clamp to 1. These are estimated prompt influences, not acoustic measurements or preference scores.
- A `Target` contains `features` and canonical `prompts`. For valid output targets, **prompt weight = 2 × feature intensity**. D can linearly interpolate features with missing entries treated as 0. During a ramp, intermediate prompt weights must still follow the shared relay minimum: omit zero and handle weights below `WEIGHT_MIN` in D's sender. Do not project an intermediate mixture before passing it as `audible`, because that would discard evidence.
- Target projection keeps the two strongest genres/instruments and one strongest mood/texture. Stable vocabulary order resolves ties. It fills missing categories from the current target, then fixed defaults if necessary. **Learning happens before projection**, using every valid supplied audible feature, including components too small to retain in the target.
- 👍 updates audible feature evidence and raises one retained, currently audible quality relative to the others: highest learned score, then highest intensity, then vocabulary order. At its cap it holds. Uniformly scaling all weights would not change their ratios. With no audible evidence, a like leaves the direction unchanged.
- 👎 updates audible evidence and chooses a target with different feature IDs from the projected audible direction and the pending destination. About 85% of decisions change one or two groups; about 15% change all four. It evaluates 12 candidates in the selected move family using intensity-weighted **mean** preference score plus seeded noise. Normalizing utility prevents larger total weight alone from improving a candidate's score. This refines the handoff's proposed raw sum.
- `processVote` increments the vote count once, even if audible evidence is empty, and returns the advanced seed. Calls are pure: inputs are never mutated, and identical inputs give identical outputs. Negative/fractional seeds become unsigned 32-bit integers; non-finite seeds become zero.
- `evolveNoVote` changes one retained weight slightly, with no feature replacements or state changes. Its RNG derives from the seed and canonical target content because the existing API returns only a target. Pass the previous result to the next call. Variable step sizes with reflection at the intensity boundaries avoid short fixed-step/clipping cycles; identical input objects by value still reproduce exactly.

The public function shapes follow `docs/HANDOFF.md`. Intensity scale, projection and passive RNG rules above are concrete implementation choices for D to review before integration; they do not change shared protocol files. D owns the audible approximation, timing, ramping, revisions, retries and transport. Prompt targets alone do not prove that generated music changes audibly or better matches a listener's taste.

## MVP tuning

All learner parameters are in `constants.ts`. Values are starting hypotheses, not calibrated preference probabilities. Re-run the same seeded vote fixtures when changing them, then compare real listening sessions.

| Parameter | Default | Effect |
| --- | --- | --- |
| `learningRate` | 0.15 | Evidence change per vote times audible intensity |
| `broadMoveProbability` | 0.15 | Probability of a broad downvote move, selected before candidate ranking |
| `twoFeatureMoveProbability` | 0.5 | On local moves, chance of changing two groups instead of one |
| `explorationNoise` | 0.05 | Uniform ranking noise from −0.05 to +0.05 |
| `likeBoost` | 0.05 intensity | Up to +0.10 prompt weight on the selected quality |
| `passiveDrift` | 0.02 intensity | Maximum step; sampled magnitude 0.01–0.02, or 0.02–0.04 prompt weight, with overshoot reflected at boundaries |
| `candidateCount` | 12 | Candidate search breadth per downvote |
| `scoreLimit` | 2 | Evidence cap at −2..+2 |
| `INITIAL_INTENSITY` | Genre 0.4, instrument 0.35, mood 0.3, texture 0.2 | Initial balance; each gets ±0.05 seeded jitter |

Tune **learning rate → exploration → like strength** first, one at a time. Keep score caps and candidate count fixed initially. `minActiveIntensity=0.1`, `maxIntensity=1` and `promptScale=2` define the C/D representation and should change only with coordinated contract review. Prompt output also observes shared `WEIGHT_MIN`/`WEIGHT_MAX`.

D's separate controls are the initial 8-second transition, roughly 1-second send interval and roughly 45-second passive cadence. BPM/key remain fixed for MVP. The learner does not schedule any of these.

## Validation

Run the repository test/typecheck/build scripts after installing its locked dependencies. Focused tests live beside the module:

```sh
pnpm test src/learner
pnpm typecheck
pnpm build
```

The suite covers audible attribution, mixed transitions, normalized-share reinforcement, selected local/broad moves, sequential rapid votes, bounded long runs, invalid numerical evidence, immutable inputs, replay and passive drift. A fixed seed identifies a replay only together with its complete input/event sequence. Listening tests remain the team's next integration step.
