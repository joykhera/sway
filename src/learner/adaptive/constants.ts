/** Experimental ranking parameters, not calibrated listener probabilities. */
export const PARAMETERS = Object.freeze({
  ridge: 0.35,
  forgetting: 0.995,
  // A comparison divides one Like budget; it never creates an extra vote.
  comparisonShare: 0.5,
  comparisonMargin: 2, // Like (+1) minus the rejected reference (-1).
  comparisonMinDistance: 1e-6,
  styleEscapeRejections: 3,
  styleEscapeBlendDistance: 0.15,
  uncertaintyBonus: 0.42,
  supportedUncertaintyBonus: 0.2,
  purposePrior: 0.16,
  transitionCost: 0.12,
  supportedTransitionCost: 0.42,
  probeProbability: 0.12,
  earlyVariationProbeProbability: 0.35,
  credibleProbeDrop: 0.25,
  tieNoise: 0.018,
  supportedInformation: 0.6,
  supportedPrediction: 0.2,
  // One bounded reset per rejection episode, rearmed by positive evidence.
  recoveryRetention: 0.25,
  recoveryEvidence: 2,
  recoveryBlendDistance: 0.15,
});
