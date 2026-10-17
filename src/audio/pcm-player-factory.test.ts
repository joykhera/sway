import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./worklet-url.ts', () => ({ workletUrl: 'mock://pcm-worklet.js' }));

import { BufferedPCMPlayer } from './buffered-player.ts';
import { WorkletPCMPlayer, createPCMPlayer, type AudioContextLike, type WorkletNodeLike } from './pcm-player.ts';

afterEach(() => vi.unstubAllGlobals());

function browserCapabilities(options: { secure?: boolean; workletNode?: boolean; workletProperty?: boolean } = {}) {
  const constructed = vi.fn();
  class Context {
    constructor() { constructed(); }
  }
  if (options.workletProperty ?? true) Object.defineProperty(Context.prototype, 'audioWorklet', {
    // Capability probing must use property existence, not invoke this receiver-bound getter.
    get() { throw new Error('AudioContext getter accessed without an instance'); },
  });
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', (options.workletNode ?? true) ? class {} : undefined);
  vi.stubGlobal('isSecureContext', options.secure ?? true);
  return constructed;
}

describe('PCM player factory capability selection', () => {
  it('keeps AudioWorklet on capable secure contexts, including trustworthy HTTP localhost', () => {
    const constructed = browserCapabilities();
    expect(createPCMPlayer()).toBeInstanceOf(WorkletPCMPlayer);
    expect(constructed).not.toHaveBeenCalled();
  });

  it('uses scheduled buffers on insecure HTTP even if worklet globals are exposed', () => {
    const constructed = browserCapabilities({ secure: false });
    expect(createPCMPlayer()).toBeInstanceOf(BufferedPCMPlayer);
    expect(constructed).not.toHaveBeenCalled();
  });

  it('uses scheduled buffers when a secure browser lacks AudioWorkletNode', () => {
    const constructed = browserCapabilities({ workletNode: false });
    expect(createPCMPlayer()).toBeInstanceOf(BufferedPCMPlayer);
    expect(constructed).not.toHaveBeenCalled();
  });

  it('requires AudioContext.audioWorklet capability without invoking its getter', () => {
    browserCapabilities({ workletProperty: false });
    expect(createPCMPlayer()).toBeInstanceOf(BufferedPCMPlayer);
  });

  it('does not assume a secure context when its flag is unavailable', () => {
    browserCapabilities();
    vi.stubGlobal('isSecureContext', undefined);
    expect(createPCMPlayer()).toBeInstanceOf(BufferedPCMPlayer);
  });

  it('does not try to construct an unavailable AudioContext during factory selection', () => {
    browserCapabilities();
    vi.stubGlobal('AudioContext', undefined);
    expect(createPCMPlayer()).toBeInstanceOf(BufferedPCMPlayer);
  });

  it('preserves explicit context/node injection and the custom module URL outside a secure browser', async () => {
    browserCapabilities({ secure: false, workletNode: false, workletProperty: false });
    const addModule = vi.fn(async () => {});
    const context: AudioContextLike = {
      sampleRate: 48_000, state: 'running', destination: {} as AudioNode,
      audioWorklet: { addModule }, onstatechange: null,
      resume: async () => {}, close: async () => {},
    };
    const node: WorkletNodeLike = {
      port: { onmessage: null, postMessage: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(),
    };
    const createAudioContext = vi.fn(() => context);
    const createWorkletNode = vi.fn(() => node);
    const player = createPCMPlayer({ createAudioContext, createWorkletNode, workletUrl: 'mock://injected-worklet.js' });
    expect(player).toBeInstanceOf(WorkletPCMPlayer);
    expect(createAudioContext).not.toHaveBeenCalled();
    await player.initializeFromUserGesture();
    expect(createAudioContext).toHaveBeenCalledTimes(1);
    expect(createWorkletNode).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith('mock://injected-worklet.js');
    await player.close();
  });

  it.each(['context', 'node'] as const)('preserves a custom %s factory on its own without invoking it early', (kind) => {
    browserCapabilities({ secure: false });
    const factory = vi.fn(() => { throw new Error('Must wait for a user gesture'); });
    const opts = kind === 'context' ? { createAudioContext: factory } : { createWorkletNode: factory };
    expect(createPCMPlayer(opts)).toBeInstanceOf(WorkletPCMPlayer);
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not let a custom module URL override an insecure browser capability decision', () => {
    browserCapabilities({ secure: false });
    expect(createPCMPlayer({ workletUrl: 'mock://custom.js' })).toBeInstanceOf(BufferedPCMPlayer);
  });
});
