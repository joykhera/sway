// Output tap wiring: the analyser sits between the player's sources and the
// destination so the visualizer can read the spectrum of what is playing.

import { describe, expect, it } from 'vitest';
import { createOutputTap } from './analyser.ts';

class FakeAnalyser {
  fftSize = 0;
  smoothingTimeConstant = 1;
  readonly connections: unknown[] = [];
  disconnects = 0;
  connect(destination: unknown) { this.connections.push(destination); }
  disconnect() { this.disconnects++; }
}

describe('createOutputTap', () => {
  it('returns the destination itself when the context has no createAnalyser', () => {
    const destination = {} as AudioNode;
    const tap = createOutputTap({ destination });
    expect(tap.output).toBe(destination);
    expect(tap.analyser).toBeNull();
  });

  it('wires an analyser between the sources and the destination', () => {
    const destination = {} as AudioNode;
    const analyser = new FakeAnalyser();
    const tap = createOutputTap({ destination, createAnalyser: () => analyser as unknown as AnalyserNode });
    expect(tap.output).toBe(analyser);
    expect(tap.analyser).toBe(analyser);
    expect(analyser.fftSize).toBe(2048);
    expect(analyser.smoothingTimeConstant).toBe(0.5);
    expect(analyser.connections).toEqual([destination]);
  });
});
