// AudioWorkletGlobalScope entry point. Loaded via `audioWorklet.addModule()`.
// Constraints: NO DOM, NO timers (stats use render-frame counting), and imports
// only from the pure DSP files in this directory (all node-testable).

import { RENDER_QUANTUM_FRAMES, STATS_INTERVAL_MS } from './constants.ts';
import {
  PCM_WORKLET_PROCESSOR_NAME,
  type WorkletInbound,
  type WorkletOutbound,
} from './types.ts';
import { PcmWorkletCore } from './worklet-core.ts';

// --- Ambient AudioWorkletGlobalScope declarations ----------------------------
// lib.dom lacks these globals/processor types; declared locally (module scope)
// so this file typechecks under the app's DOM lib without @types/webaudio.
declare const sampleRate: number;
declare const currentFrame: number;

type WorkletParams = Record<string, Float32Array>;

// MUST keep the real global name: `extends AudioWorkletProcessor` is evaluated at
// runtime inside AudioWorkletGlobalScope. A renamed placeholder would emit an
// unresolved reference — and Chrome still resolves addModule() on eval errors,
// so the failure only surfaces as "node name not defined" at node construction.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: WorkletParams,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;
// ----------------------------------------------------------------------------

class SwayPcmProcessor extends AudioWorkletProcessor {
  private readonly core = new PcmWorkletCore({ outputSampleRateHz: sampleRate });
  private readonly statsEveryFrames = Math.max(
    RENDER_QUANTUM_FRAMES,
    Math.round((sampleRate * STATS_INTERVAL_MS) / 1000),
  );
  private framesSinceStats = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as WorkletInbound;
      switch (msg.type) {
        case 'configure':
          this.core.configure(msg.sourceSampleRateHz);
          break;
        case 'pcm':
          this.core.pushPcm(new Uint8Array(msg.bytes));
          break;
        case 'reset':
          this.core.reset();
          break;
      }
    };
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: WorkletParams,
  ): boolean {
    const output = outputs[0];
    const left = output?.[0];
    const frames = left?.length ?? 0;
    if (left !== undefined && frames > 0) {
      const rendered = this.core.render(frames); // interleaved L,R,L,R...
      for (let i = 0; i < frames; i++) left[i] = rendered[i * 2] ?? 0;
      const right = output?.[1];
      if (right !== undefined) {
        for (let i = 0; i < frames; i++) right[i] = rendered[i * 2 + 1] ?? 0;
      }
    }
    this.framesSinceStats += frames;
    if (this.framesSinceStats >= this.statsEveryFrames) {
      this.framesSinceStats = 0;
      const stats: WorkletOutbound = { type: 'stats', ...this.core.getStats() };
      this.port.postMessage(stats);
    }
    return true;
  }
}

registerProcessor(PCM_WORKLET_PROCESSOR_NAME, SwayPcmProcessor);
