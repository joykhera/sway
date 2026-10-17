import { parseMusicIntent, type MusicIntent } from '../../shared/intent';
import { FEATURE_GROUPS, GROUP_IDS } from '../vocabulary';
import { activeIds } from '../targets';
import { purposePrior } from './recipes';
import type { FeatureBlend, LearnerState, Target } from './types';

/** Validate at the pure API boundary too; a bad request must never relax itself. */
export function validatedIntent(intent: MusicIntent | undefined): MusicIntent | undefined {
  if (intent === undefined) return undefined;
  const parsed = parseMusicIntent(intent);
  if (!parsed) throw new TypeError('Music intent is invalid or its feature constraints are infeasible.');
  return parsed;
}

/** A required ID owns its group, e.g. jazz means jazz-only, including held blends. */
export function matchesIntent(features: FeatureBlend, intent?: MusicIntent): boolean {
  if (!intent) return true;
  if (intent.excludedFeatures.some(id => (features[id] ?? 0) > 0)) return false;
  return GROUP_IDS.every(group => {
    const required = intent.requiredFeatures.find(id => (FEATURE_GROUPS[group] as readonly string[]).includes(id));
    const ids = activeIds(features, group);
    return !required || (ids.length === 1 && ids[0] === required);
  });
}

/** At most 0.22 utility, fading with actual evidence; never modifies the model. */
export function intentPrior(state: LearnerState, target: Target, intent?: MusicIntent): number {
  if (!intent) return 0;
  const parts: number[] = [];
  if (intent.featureHints.length) {
    parts.push(intent.featureHints.filter(id => (target.features[id] ?? 0) > 0).length / intent.featureHints.length);
  }
  if (intent.purposeHint) {
    // The largest existing purpose prior is Crazy (< 2 at recipe intensities).
    parts.push(Math.min(1, purposePrior(intent.purposeHint, target) / 2));
  }
  return parts.length ? 0.22 * parts.reduce((a, b) => a + b, 0) / parts.length / (1 + state.evidence / 12) : 0;
}

/** Free descriptions stay separate from the 18 learned controls. Rebuild, don't retain stale text. */
export function withIntentPrompts(target: Target, intent?: MusicIntent): Target {
  if (!intent) return target;
  const prompts = [...target.prompts];
  if (intent.contextPrompt) prompts.push({ text: intent.contextPrompt, weight: 0.5 });
  // Relay limits are 200 characters and 10 prompts. A held blend has at most
  // six feature prompts; one context plus three pairs of <=80-char exclusions fit.
  for (let i = 0; i < intent.avoid.length; i += 2) {
    prompts.push({ text: `Avoid: ${intent.avoid.slice(i, i + 2).join('; ')}.`,
      weight: Math.max(0.1, 0.3 / Math.ceil(intent.avoid.length / 2)) });
  }
  // A context identical to a feature phrase should not duplicate its contribution.
  return { ...target, prompts: prompts.filter((prompt, i) => prompts.findIndex(other => other.text === prompt.text) === i) };
}
