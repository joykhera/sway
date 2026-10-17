// Worklet module URL shim. Vite resolves `?worker&url` at dev/build time to the
// URL of the bundled `pcm-worklet.ts` entry. AudioWorklet modules are classic
// scripts, so the default `worker.format` ('iife') is the correct bundle shape.
// `pcm-worklet.ts` is owned by the sibling audio-agent task.
import workletUrl from './pcm-worklet.ts?worker&url';

export { workletUrl };
