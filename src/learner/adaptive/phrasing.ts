import { toTarget, type Phrasing } from '../targets';
import { FEATURE_OF_TEXT, type FeatureId } from '../vocabulary';
import { hashText } from '../rng';
import type { FeatureBlend, Purpose, Target } from './types';

/** Crazy is expressive wording for existing controls, never gain or a BPM reset. */
export const CRAZY_VARIANTS: Readonly<Partial<Record<FeatureId, readonly string[]>>> = {
  electronic: [
    'wild experimental instrumental electronica with fractured rhythms and unexpected turns',
    'restless instrumental glitch electronics with daring rhythmic twists',
  ],
  synth: [
    'agile modular synthesizer runs with jagged arpeggios and strange timbres',
    'playful experimental synth sequences with abrupt melodic leaps',
  ],
  percussion: [
    'rapid intricate instrumental percussion with unpredictable syncopated fills',
    'adventurous drum patterns with tumbling polyrhythmic breaks',
  ],
  energetic: [
    'fast, feverish instrumental energy with sudden rhythmic twists',
    'frenetic high-momentum instrumental motion with playful surprises',
  ],
  rhythmic: [
    'fast interlocking polyrhythms and asymmetric instrumental grooves',
    'restless syncopated rhythms with intricate shifting accents',
  ],
  layered: [
    'densely interlocking experimental instrumental layers with surprising counterpoint',
    'unusual instrumental layers weaving through restless rhythmic patterns',
  ],
};
const CRAZY_FEATURE_OF_TEXT = new Map<string, FeatureId>(
  (Object.entries(CRAZY_VARIANTS) as [FeatureId, readonly string[]][])
    .flatMap(([id, variants]) => variants.map((text) => [text, id] as const)),
);

/** Identify only the feature vocabulary, including profile-specific variants. */
export function featureOfPrompt(text: string): FeatureId | undefined {
  return CRAZY_FEATURE_OF_TEXT.get(text) ?? FEATURE_OF_TEXT.get(text);
}

export function renderTarget(features: FeatureBlend, fallback: FeatureBlend, phrasing: Phrasing, purpose: Purpose): Target {
  const target = toTarget(features, fallback, phrasing);
  if (purpose !== 'crazy') return target; // Preserve every teammate phrasing elsewhere.
  return {
    ...target,
    prompts: target.prompts.map((prompt) => {
      const id = FEATURE_OF_TEXT.get(prompt.text)!;
      const kept = phrasing.keep?.find(({ text }) => (CRAZY_FEATURE_OF_TEXT.get(text) ?? FEATURE_OF_TEXT.get(text)) === id);
      const variants = CRAZY_VARIANTS[id];
      return {
        ...prompt,
        text: kept?.text ?? (variants ? variants[hashText(id, phrasing.salt ?? 0) % variants.length]! : prompt.text),
      };
    }),
  };
}
