import { FEATURE_IDS, FEATURE_OF_TEXT, GROUP_IDS } from '../vocabulary';
import type { WeightedPrompt } from '../../shared/protocol';
import type { MusicIntent } from '../../shared/intent';
import { createRng, hashText, normalizeSeed } from '../rng';
import type { Rng } from '../rng';
import { activeIds, fingerprint, nudgeFeatures, signature } from '../targets';
import { PARAMETERS as P } from './constants';
import { dot, factor, solve, uncertainty, vector } from './model';
import { CRAZY_VARIANTS, renderTarget } from './phrasing';
import { RECIPES, changedGroups, distance, purposePrior } from './recipes';
import { intentPrior, matchesIntent, validatedIntent, withIntentPrompts } from './intent';
import type { Decision, FeatureBlend, FeatureId, LearnerState, Purpose, Target } from './types';

export type { Decision, FeatureBlend, FeatureId, LearnerState, Purpose, Target } from './types';
export { PARAMETERS } from './constants';

const coefficients = (theta: number[]) => Object.fromEntries(FEATURE_IDS.map((id, i) => [id, theta[i]!])) as Record<FeatureId, number>;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function createLearner(seed: number, purpose: Purpose = 'explore'): LearnerState {
  return {
    scores: coefficients(FEATURE_IDS.map(() => 0)), votes: 0, seed: normalizeSeed(seed), purpose,
    A: FEATURE_IDS.map((_, i) => FEATURE_IDS.map((__, j) => i === j ? P.ridge : 0)),
    b: FEATURE_IDS.map(() => 0), evidence: 0, positiveEvidence: 0, negativeEvidence: 0, pairwiseEvidence: 0,
    lastVote: null, recentRejections: 0, rejectedBlends: [],
    unexpectedDislikes: [], recoveryArmed: true, recoveries: 0, lastRecoveryVote: null,
  };
}

function context(state: LearnerState, features: FeatureBlend) {
  const L = factor(state.A);
  const theta = solve(L, state.b);
  const x = vector(features);
  const predicted = dot(theta, x);
  const uncertain = uncertainty(L, x);
  const priorVariance = dot(x, x) / P.ridge;
  const information = priorVariance > 0 ? clamp01(1 - uncertain ** 2 / priorVariance) : 0;
  const supported = predicted > P.supportedPrediction && information > P.supportedInformation;
  const reopening = state.recentRejections >= 1.8;
  const phase = reopening ? 'Reopening search'
    : supported ? 'Staying nearby'
      : predicted > 0.1 && information > 0.25 ? 'Finding a family' : 'Exploring';
  return { L, theta, x, predicted, uncertain, information, supported: supported && !reopening, reopening, phase };
}

function phrasingSalt(target: Target, state: LearnerState): number {
  return Number.isFinite(target.phrasingSalt) ? normalizeSeed(target.phrasingSalt!) : state.seed;
}

function retainedPhrasing(target: Target, state: LearnerState, intent?: MusicIntent): readonly WeightedPrompt[] {
  // Clearing a request must restore the profile's special wording for retained
  // controls too. Outside that renderer-context change, keep existing phrases.
  return !intent && target.intentRendering && state.purpose === 'crazy'
    ? target.prompts.filter(({ text }) => !CRAZY_VARIANTS[FEATURE_OF_TEXT.get(text)!]) : target.prompts;
}

function withDecision(target: Target, kind: Decision['kind'], reason: string, state: LearnerState, step: number, salt: number, keep: readonly WeightedPrompt[] = target.prompts, styleEscape = false, intent?: MusicIntent): Target {
  const current = context(state, target.features);
  return {
    // Intent is session context, not a saved-profile switch. Neutral vocabulary
    // cannot retain Crazy's fast/frenetic embellishments over a new slow request.
    ...withIntentPrompts(renderTarget(target.features, {}, { keep, salt }, intent ? 'explore' : state.purpose), intent),
    ...(intent ? { intentRendering: true as const } : {}),
    phrasingSalt: salt,
    lastDecision: {
      kind,
      ...(styleEscape ? { styleEscape: true } : {}),
      reason: kind === 'redirect' && state.lastRecoveryVote === state.votes
        ? `Reconsidering older assumptions after distinct supported blends were rejected. ${reason}` : reason,
      phase: current.phase, step, prediction: current.predicted, uncertainty: current.uncertain,
    },
  };
}

function choose(state: LearnerState, base: Target, pending: Target, mode: 'initial' | 'down' | 'variation' | 'apply', step: number, rng: Rng, escapeFrom?: FeatureBlend, intent?: MusicIntent): Target {
  const current = context(state, base.features);
  const scheduled = mode === 'variation';
  const styleEscape = escapeFrom !== undefined;
  const broad = styleEscape || mode === 'initial' || mode === 'apply' || current.reopening || (scheduled
    ? rng.next() < (current.supported ? P.probeProbability : P.earlyVariationProbeProbability)
    : !current.supported || rng.next() < P.probeProbability);
  // Hard request constraints are applied before nearest-neighbour, escape or
  // credible-probe filtering. None of those policies may relax the request.
  const catalog = intent ? RECIPES.filter(({ target }) => matchesIntent(target.features, intent)) : RECIPES;
  if (!catalog.length) throw new TypeError('Music intent leaves no feasible recipes.');
  let candidates = catalog.filter(({ target }) => mode === 'initial' || mode === 'apply'
    || (signature(target.features) !== signature(base.features) && signature(target.features) !== signature(pending.features)));
  // One or two feasible recipes can be exhausted by heard/pending exclusions.
  // Prefer leaving the heard identity, then hold rather than break a constraint.
  if (!candidates.length) {
    candidates = catalog.filter(({ target }) => signature(target.features) !== signature(base.features));
    if (!candidates.length) candidates = catalog;
  }
  if (styleEscape && intent) {
    // If a style group is fixed (e.g. jazz-only), escape through the next mutable
    // groups. Maximise feasible change rather than ever producing an empty set.
    const axes = GROUP_IDS.filter(group => new Set(catalog.map(({ target }) => activeIds(target.features, group).join('|'))).size > 1).slice(0, 2);
    const changes = (target: Target, from: FeatureBlend) => axes.reduce((n, group) => n
      + Number(activeIds(target.features, group).every(id => !activeIds(from, group).includes(id))), 0);
    const mostChanged = Math.max(...candidates.map(({ target }) => changes(target, pending.features)));
    candidates = candidates.filter(({ target }) => changes(target, pending.features) === mostChanged);
    const mostNovel = Math.max(...candidates.map(({ target }) => changes(target, escapeFrom)));
    candidates = candidates.filter(({ target }) => changes(target, escapeFrom) === mostNovel);
  } else if (styleEscape) {
    // Always leave the pending genre/instrument. Also avoid every audible one
    // when feasible; a long transition may already contain the entire palette.
    const pendingGenres = activeIds(pending.features, 'genre');
    const pendingInstruments = activeIds(pending.features, 'instrument');
    const pendingChanged = candidates.filter(({ target }) =>
      activeIds(target.features, 'genre').every(id => !pendingGenres.includes(id))
      && activeIds(target.features, 'instrument').every(id => !pendingInstruments.includes(id)));
    if (pendingChanged.length) candidates = pendingChanged;
    const heardGenres = activeIds(escapeFrom, 'genre');
    const heardInstruments = activeIds(escapeFrom, 'instrument');
    const novelGroups = (target: Target) => Number(activeIds(target.features, 'genre').every(id => !heardGenres.includes(id)))
      + Number(activeIds(target.features, 'instrument').every(id => !heardInstruments.includes(id)));
    const mostNovel = Math.max(...candidates.map(({ target }) => novelGroups(target)));
    candidates = candidates.filter(({ target }) => novelGroups(target) === mostNovel);
  }
  const closest = Math.min(...candidates.map(({ target }) => changedGroups(base.features, target.features)));
  if (!broad) candidates = candidates.filter(({ target }) => changedGroups(base.features, target.features) === closest);
  if (broad && current.supported && scheduled) {
    const credible = candidates.filter(({ x }) => dot(current.theta, x) >= current.predicted - P.credibleProbeDrop);
    if (credible.length > 0) candidates = credible;
  }
  const uncertaintyBonus = current.supported ? P.supportedUncertaintyBonus : P.uncertaintyBonus;
  const cost = mode === 'initial' ? 0 : current.supported ? P.supportedTransitionCost : P.transitionCost;
  let best = candidates[0]!;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = dot(current.theta, candidate.x)
      + uncertaintyBonus * uncertainty(current.L, candidate.x)
      + P.purposePrior * purposePrior(state.purpose, candidate.target)
      + intentPrior(state, candidate.target, intent)
      - cost * distance(current.x, candidate.x)
      + (rng.next() * 2 - 1) * P.tieNoise;
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  const changeCount = changedGroups(base.features, best.target.features);
  const kind = mode === 'initial' ? 'initial' : mode === 'apply' ? 'intent' : mode === 'down' ? 'redirect' : broad ? 'probe' : 'variation';
  const reason = catalog.length === 1 && mode !== 'initial' && mode !== 'apply'
    ? 'The active request permits only one recipe; keeping its constraints rather than inventing an unavailable variation.'
    : mode === 'apply' ? intent
      ? 'Applying the current request within saved preferences; text adds no preference evidence.'
      : 'Clearing the request and returning to saved preferences; no evidence was changed.'
    : styleEscape && intent ? 'Opening a wider search after three distinct rejections; changing the mutable groups inside the active request.'
    : styleEscape ? 'Opening a wider style search after three distinct rejected heard blends; changing genre and instrument where the active mixture permits.'
    : mode === 'initial' ? 'Starting with a broad recipe; purpose is a soft starting hint, not learned taste.'
    : mode === 'down' ? current.supported
      ? `Trying a different ${changeCount === 1 ? 'ingredient' : 'combination'} near the supported family after a dislike.`
      : 'Trying another direction after a dislike; preference evidence is still uncertain.'
      : broad ? 'Testing a plausible alternative while keeping room for discovery; silence adds no preference evidence.'
        : 'Adding a nearby variation after exposure; likes guide the family without freezing the music.';
  return withDecision(best.target, kind, reason, state, step, phrasingSalt(pending, state), mode === 'initial' ? [] : retainedPhrasing(pending, state, intent), styleEscape, intent);
}

export function initialTarget(state: LearnerState, intent?: MusicIntent): Target {
  return choose(state, RECIPES[0]!.target, RECIPES[0]!.target, 'initial', 0, createRng(state.seed), undefined, validatedIntent(intent));
}

/** Apply/clear session context using current saved evidence, without mutating it. */
export function applyIntent(args: { state: LearnerState; currentTarget: Target; intent?: MusicIntent }): Target {
  return choose(args.state, args.currentTarget, args.currentTarget, 'apply', args.currentTarget.lastDecision?.step ?? 0,
    createRng(args.state.seed), undefined, validatedIntent(args.intent));
}

export function processVote(args: {
  state: LearnerState;
  audible: FeatureBlend;
  currentTarget: Target;
  vote: 'up' | 'down';
  evidenceWeight?: number;
  comparison?: { previous: FeatureBlend };
  intent?: MusicIntent;
}): { state: LearnerState; target: Target } {
  if (args.vote !== 'up' && args.vote !== 'down') throw new Error('Vote must be up or down');
  const intent = validatedIntent(args.intent);
  const x = vector(args.audible);
  const suppliedWeight = args.evidenceWeight ?? 1;
  const w = Number.isFinite(suppliedWeight) && dot(x, x) > 0 ? clamp01(suppliedWeight) : 0;
  // A zero-weight/correlated click is an action, not a learning or forgetting step.
  const gamma = w > 0 ? P.forgetting ** w : 1;
  const reward = args.vote === 'up' ? 1 : -1;
  // A Like following an explicitly rejected blend can support the direction of
  // change. The controller owns recency/exposure eligibility. Do not normalize
  // this difference: tiny changes must not turn into full-strength directions.
  const previous = args.comparison?.previous;
  const validPrevious = previous && typeof previous === 'object' && !Array.isArray(previous)
    && Object.entries(previous).every(([id, value]) => FEATURE_IDS.includes(id as FeatureId)
      && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
  const prior = validPrevious ? vector(previous) : null;
  const difference = prior && dot(prior, prior) > 0 ? x.map((value, i) => value - prior[i]!) : null;
  const pairWeight = w > 0 && reward > 0 && difference
    && distance(x, prior!) >= P.comparisonMinDistance ? w * P.comparisonShare : 0;
  const absoluteWeight = w - pairWeight;
  let rejectedBlends = args.state.rejectedBlends.map(blend => [...blend]);
  if (w > 0 && reward > 0) rejectedBlends = [];
  else if (w > 0 && rejectedBlends.every(blend => distance(blend, x) >= P.styleEscapeBlendDistance)) {
    rejectedBlends = [...rejectedBlends, x].slice(-P.styleEscapeRejections);
  }
  let unexpectedDislikes = args.state.unexpectedDislikes.map((observation) => ({ x: [...observation.x], weight: observation.weight }));
  let recoveryArmed = args.state.recoveryArmed;
  let recover = false;
  if (w > 0 && reward > 0) {
    unexpectedDislikes = [];
    recoveryArmed = true;
  } else if (w > 0 && recoveryArmed) {
    // Surprise is assessed BEFORE fitting this dislike, independently of the
    // selection phase. Expected poor exploration does not invalidate old taste.
    const before = context(args.state, args.audible);
    if (before.predicted > P.supportedPrediction && before.information > P.supportedInformation) {
      const similar = unexpectedDislikes.find((observation) => distance(observation.x, x) < P.recoveryBlendDistance);
      if (similar) similar.weight = Math.min(1, similar.weight + w);
      else unexpectedDislikes.push({ x, weight: Math.min(1, w) });
      // Bounded policy memory, separate from the full learned sufficient statistics.
      unexpectedDislikes = unexpectedDislikes.slice(-6);
      recover = unexpectedDislikes.length >= 2
        && unexpectedDislikes.reduce((total, observation) => total + observation.weight, 0) >= P.recoveryEvidence;
      if (recover) {
        unexpectedDislikes = [];
        recoveryArmed = false;
      }
    }
  }
  // Discount OLD evidence toward lambda I, then add the latest observation intact.
  const discount = gamma * (recover ? P.recoveryRetention : 1);
  const A = args.state.A.map((row, i) => row.map((value, j) =>
    discount * value + (i === j ? (1 - discount) * P.ridge : 0) + absoluteWeight * x[i]! * x[j]!
      + (pairWeight > 0 ? pairWeight * difference![i]! * difference![j]! : 0),
  ));
  const b = args.state.b.map((value, i) => discount * value + absoluteWeight * reward * x[i]!
    + (pairWeight > 0 ? pairWeight * P.comparisonMargin * difference![i]! : 0));
  const state: LearnerState = {
    ...args.state, A, b, scores: coefficients(solve(factor(A), b)), votes: args.state.votes + 1,
    evidence: discount * args.state.evidence + w,
    pairwiseEvidence: discount * args.state.pairwiseEvidence + pairWeight,
    positiveEvidence: discount * args.state.positiveEvidence + (reward > 0 ? w : 0),
    negativeEvidence: discount * args.state.negativeEvidence + (reward < 0 ? w : 0),
    lastVote: args.vote,
    recentRejections: w === 0 ? args.state.recentRejections : reward < 0 ? args.state.recentRejections * 0.9 + w : 0,
    rejectedBlends,
    unexpectedDislikes, recoveryArmed,
    recoveries: args.state.recoveries + (recover ? 1 : 0),
    lastRecoveryVote: recover ? args.state.votes + 1 : args.state.lastRecoveryVote,
  };
  const rng = createRng(state.seed);
  rng.next();
  const salt = phrasingSalt(args.currentTarget, state);
  // A stable salt restores an outgoing feature's wording even when a mid-ramp
  // like brings it back after it disappeared from the pending destination.
  const base = renderTarget(args.audible, args.currentTarget.features, { keep: retainedPhrasing(args.currentTarget, state, intent), salt }, intent ? 'explore' : state.purpose);
  const step = args.currentTarget.lastDecision?.step ?? 0;
  // Learn from what was actually heard, but a Like during a request transition
  // must not restore outgoing forbidden ingredients to the new destination.
  const compatibleHold = matchesIntent(args.audible, intent) && matchesIntent(base.features, intent);
  const target = args.vote === 'up' && !compatibleHold
    ? matchesIntent(args.currentTarget.features, intent)
      ? withDecision(args.currentTarget, 'hold', 'Keeping the active request target; the liked outgoing blend is outside its constraints.', state, step, salt, args.currentTarget.prompts, false, intent)
      : choose(state, base, args.currentTarget, 'apply', step, rng, undefined, intent)
    : args.vote === 'up'
    ? withDecision(base, 'hold', pairWeight > 0
      ? 'Keeping the liked heard blend and learning its change from the recent rejected blend; this compares prompt mixtures, not measured tempo.'
      : 'Keeping the liked heard blend now; scheduled variations will continue without inventing more votes.', state, step, salt, base.prompts, false, intent)
    : choose(state, base, args.currentTarget, 'down', step, rng, w > 0 && rejectedBlends.length >= P.styleEscapeRejections ? args.audible : undefined, intent);
  return { state: { ...state, seed: rng.seed }, target };
}

/** Controller schedules exposure and owns step. This function changes no evidence. */
export function evolveNoVote(args: { state: LearnerState; target: Target; step?: number; intent?: MusicIntent }): Target {
  const fallbackStep = (args.target.lastDecision?.step ?? 0) + 1;
  const step = Number.isFinite(args.step) ? Math.max(0, Math.trunc(args.step!)) : fallbackStep;
  const rng = createRng(hashText(`${fingerprint(args.target.features)}:${step}`, args.state.seed));
  return choose(args.state, args.target, args.target, 'variation', step, rng, undefined, validatedIntent(args.intent));
}

/**
 * Steer one step toward a feature the listener picked. Not a vote: no evidence
 * changes, and the target keeps its decision and wording for retained features.
 */
export function nudge(args: { state: LearnerState; target: Target; feature: FeatureId }): Target {
  const salt = phrasingSalt(args.target, args.state);
  const features = nudgeFeatures(args.target.features, args.feature);
  return {
    ...args.target,
    ...renderTarget(features, {}, { keep: args.target.prompts, salt }, args.state.purpose),
    phrasingSalt: salt,
  };
}

export function inspect(state: LearnerState, target: Target) {
  const current = context(state, target.features);
  const marginalVariance = FEATURE_IDS.map((_, i) => {
    const axis = FEATURE_IDS.map((__, j) => i === j ? 1 : 0);
    return uncertainty(current.L, axis) ** 2;
  });
  // Average marginal information reduction, NOT confidence in the listener's taste.
  const coverage = marginalVariance.reduce((total, variance) => total + clamp01(1 - P.ridge * variance), 0) / FEATURE_IDS.length;
  return {
    phase: current.phase,
    reason: target.lastDecision?.reason ?? 'Waiting for explicit feedback and adequate listening exposure.',
    evidence: state.evidence,
    pairwiseEvidence: state.pairwiseEvidence,
    rejectedBlendCount: state.rejectedBlends.length,
    styleEscape: target.lastDecision?.styleEscape ?? false,
    rankedFeatures: FEATURE_IDS.map((id, i) => ({ id, score: current.theta[i]! })).sort((a, b) => b.score - a.score),
    prediction: current.predicted,
    uncertainty: current.uncertain,
    information: current.information,
    coverage,
    purpose: state.purpose,
    recipeCount: RECIPES.length,
    recoveries: state.recoveries,
    lastRecoveryVote: state.lastRecoveryVote,
    uncertaintyMeaning: 'Regularized model uncertainty for this prompt blend; not a probability or a measurement of audible taste.',
  };
}
