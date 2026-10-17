/** Starting hypotheses. Change one at a time and replay the same votes/seeds. */
export const LEARNER_PARAMETERS = Object.freeze({
  learningRate: 0.15,
  scoreLimit: 2,
  broadMoveProbability: 0.15,
  candidateCount: 12,
  twoFeatureMoveProbability: 0.5,
  explorationNoise: 0.05,
  // Feature intensities are 0..1; emitted prompt weights are 2 * intensity.
  likeBoost: 0.05,
  passiveDrift: 0.02,
  /** Chance a no-vote evolution also rewords one active feature (see PROMPT_VARIANTS). */
  phrasingDriftProbability: 0.35,
  minActiveIntensity: 0.1,
  maxIntensity: 1,
  promptScale: 2,
  initialJitter: 0.05,
});

export const INITIAL_INTENSITY = Object.freeze({
  genre: 0.4,
  instrument: 0.35,
  mood: 0.3,
  texture: 0.2,
});
