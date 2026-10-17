// All tunables in one place; these are hypotheses to adjust after manual testing.
export type ControllerConfig = {
  rampMs: number; // duration of a transition toward a new target
  stepMs: number; // interval between intermediate steer messages
  noVoteEvolveMs: number; // silence -> small within-style variation (never a score update)
  generationLatencyMs: number; // extra delay between a steer being sent and it being audible, beyond the buffer
  historyRetentionMs: number;
  reconnectBackoffMs: number[];
};

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  rampMs: 8000,
  stepMs: 1000,
  noVoteEvolveMs: 45_000,
  generationLatencyMs: 0,
  historyRetentionMs: 60_000,
  reconnectBackoffMs: [1000, 2000, 4000, 8000, 8000],
};
