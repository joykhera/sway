/** Fixed controls, not measurements of the generated audio. */
export const FEATURE_GROUPS = {
  genre: ['ambient', 'lofi', 'jazz', 'electronic', 'classical'],
  instrument: ['piano', 'synth', 'guitar', 'strings', 'percussion'],
  mood: ['calm', 'dreamy', 'hopeful', 'melancholic', 'energetic'],
  texture: ['sparse', 'layered', 'rhythmic'],
} as const;

export type FeatureGroup = keyof typeof FEATURE_GROUPS;
export type FeatureId = (typeof FEATURE_GROUPS)[FeatureGroup][number];
export const GROUP_IDS = Object.keys(FEATURE_GROUPS) as FeatureGroup[];
export const FEATURE_IDS: readonly FeatureId[] = GROUP_IDS.flatMap(
  (group) => [...FEATURE_GROUPS[group]],
);

export const PROMPT_TEXT: Readonly<Record<FeatureId, string>> = {
  ambient: 'ambient instrumental soundscape',
  lofi: 'lo-fi instrumental hip-hop groove',
  jazz: 'instrumental jazz',
  electronic: 'instrumental electronic music',
  classical: 'instrumental classical music',
  piano: 'soft felt piano',
  synth: 'warm synthesizer pads',
  guitar: 'gentle guitar',
  strings: 'expressive string ensemble',
  percussion: 'textured percussion',
  calm: 'calm atmosphere',
  dreamy: 'dreamy atmosphere',
  hopeful: 'hopeful mood',
  melancholic: 'melancholic mood',
  energetic: 'energetic mood',
  sparse: 'sparse arrangement with space between notes',
  layered: 'layered instrumental arrangement',
  rhythmic: 'rhythmic instrumental texture',
};
