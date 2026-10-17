// Output tap for the visualizer. Both players route their output through an
// AnalyserNode (a pass-through) so the UI can read the spectrum of what is playing.

/** The slice of a context needed to build the tap. Test fakes may omit `createAnalyser`. */
export interface AnalyserContextLike {
  readonly destination: AudioNode;
  createAnalyser?(): AnalyserNode;
}

export type OutputTap = { output: AudioNode; analyser: AnalyserNode | null };

/** Returns the node sources should connect to: an analyser wired to the destination, or the destination itself. */
export function createOutputTap(ctx: AnalyserContextLike): OutputTap {
  if (typeof ctx.createAnalyser !== 'function') return { output: ctx.destination, analyser: null };
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.5;
  analyser.connect(ctx.destination);
  return { output: analyser, analyser };
}
