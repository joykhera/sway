// All tunables in one place; these are hypotheses to adjust after manual testing.
export type ControllerConfig = {
  rampMs: number; // duration of a transition toward a new target
  stepMs: number; // interval between intermediate steer messages
  noVoteEvolveMs: number; // fresh-variation cadence; held-target Likes do not defer it (never a score update)
  generationLatencyMs: number; // extra delay between a steer being sent and it being audible, beyond the buffer
  historyRetentionMs: number;
  evidenceWindowMs: number; // repeated judgments of a similar heard blend share one observation
  evidenceBlendDistance: number; // normalized total-variation distance for a fresh blend
  reconnectBackoffMs: number[];
};

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  rampMs: 8000,
  stepMs: 1000,
  noVoteEvolveMs: 45_000,
  // Lyria emits 2 s chunks and applies steers with up to ~2 s control lag; the player buffer is added on top.
  generationLatencyMs: 2500,
  historyRetentionMs: 60_000,
  evidenceWindowMs: 6000,
  evidenceBlendDistance: 0.15,
  reconnectBackoffMs: [1000, 2000, 4000, 8000, 8000],
};
