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

/**
 * Several phrasings per feature: the learner still learns per feature, while the
 * wording varies the sound. Descriptive only (no artist names, nothing vocal).
 * The first entry is the canonical phrasing.
 */
export const PROMPT_VARIANTS: Readonly<Record<FeatureId, readonly string[]>> = {
  ambient: [
    'ambient instrumental soundscape',
    'slow-evolving ambient drones with long reverb tails',
    'cinematic ambient textures, vast and weightless',
    'field-recording ambience blended with soft tonal swells',
  ],
  lofi: [
    'lo-fi instrumental hip-hop groove',
    'dusty lo-fi beats with vinyl crackle and tape wobble',
    'late-night lo-fi chillhop with mellow swung drums',
    'warm lo-fi boom-bap with detuned keys',
  ],
  jazz: [
    'instrumental jazz',
    'smoky late-night jazz trio with brushed drums',
    'bossa nova jazz with nylon-string comping',
    'modal jazz with walking upright bass',
  ],
  electronic: [
    'instrumental electronic music',
    'analog synthwave with pulsing arpeggios',
    'glitchy IDM with intricate micro-edits',
    'deep house groove with warm sub bass',
  ],
  classical: [
    'instrumental classical music',
    'minimalist neoclassical with repeating motifs',
    'romantic-era chamber music',
    'baroque counterpoint with harpsichord',
  ],
  piano: [
    'soft felt piano',
    'Rhodes electric piano with gentle tremolo',
    'prepared piano with muted, percussive notes',
    'grand piano with rich sustain',
  ],
  synth: [
    'warm synthesizer pads',
    'shimmering analog polysynth chords',
    'bubbling modular synth sequences',
    'lush detuned supersaw pads',
  ],
  guitar: [
    'gentle guitar',
    'fingerpicked nylon-string guitar',
    'clean electric guitar with chorus and delay',
    'shoegaze guitar wash with heavy reverb',
  ],
  strings: [
    'expressive string ensemble',
    'intimate string quartet',
    'sweeping cinematic orchestral strings',
    'solo cello with warm vibrato',
  ],
  percussion: [
    'textured percussion',
    'hand percussion with congas and shakers',
    'crisp 808 drum machine',
    'kalimba and mallet percussion',
  ],
  calm: [
    'calm atmosphere',
    'serene and unhurried',
    'peaceful early-morning stillness',
    'soothing, gently breathing pace',
  ],
  dreamy: [
    'dreamy atmosphere',
    'hazy, floating dreamlike textures',
    'nostalgic dreamy warmth',
    'ethereal and weightless',
  ],
  hopeful: [
    'hopeful mood',
    'uplifting and bright',
    'warm optimistic glow',
    'gently triumphant and rising',
  ],
  melancholic: [
    'melancholic mood',
    'bittersweet and wistful',
    'rainy-day introspective melancholy',
    'lonely late-night longing',
  ],
  energetic: [
    'energetic mood',
    'driving and propulsive',
    'bouncy, upbeat energy',
    'urgent, high-momentum pulse',
  ],
  sparse: [
    'sparse arrangement with space between notes',
    'minimal arrangement with lots of silence',
    'delicate, stripped-back arrangement',
    'few instruments, wide open space',
  ],
  layered: [
    'layered instrumental arrangement',
    'dense, richly layered arrangement',
    'interlocking melodic layers',
    'wall-of-sound layering',
  ],
  rhythmic: [
    'rhythmic instrumental texture',
    'syncopated rhythmic patterns',
    'polyrhythmic interlocking grooves',
    'steady hypnotic pulse',
  ],
};

/** Canonical phrasing per feature (first variant). */
export const PROMPT_TEXT: Readonly<Record<FeatureId, string>> = Object.fromEntries(
  Object.entries(PROMPT_VARIANTS).map(([id, variants]) => [id, variants[0]!]),
) as Record<FeatureId, string>;

/** Reverse lookup so a target's prompts reveal which phrasing each feature uses. */
export const FEATURE_OF_TEXT: ReadonlyMap<string, FeatureId> = new Map(
  (Object.entries(PROMPT_VARIANTS) as [FeatureId, readonly string[]][]).flatMap(
    ([id, variants]) => variants.map((text) => [text, id] as const),
  ),
);
