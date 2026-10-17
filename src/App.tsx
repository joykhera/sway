// Composition root. Owned by B (src/App.tsx).
// The session controller is created lazily once per app lifetime via a ref (not state):
// StrictMode's dev-only render/effect replay reuses the same ref, so exactly one
// controller — and no audio — is constructed per mount.

import { useRef, useEffect } from 'react';
import { PlayerScreen, MockMusicSessionController } from './ui/index.ts';
import { createPCMPlayer, MockPcmGenerator } from './audio/index.ts';
import type { MusicSessionController } from './ui/index.ts';

export default function App() {
  const controllerRef = useRef<MusicSessionController | null>(null);
  if (controllerRef.current === null) {
    // ── Developer D: replace MockMusicSessionController with the real session controller from src/controller/index.ts
    controllerRef.current = new MockMusicSessionController({
      playerFactory: () => createPCMPlayer(),
      generatorFactory: () => new MockPcmGenerator(),
    });
  }

  // Mount-only cleanup. StrictMode replays effects in dev, so stop() must stay a
  // no-op before start() — the ref above survives the replay untouched.
  useEffect(() => () => {
    controllerRef.current?.stop();
  }, []);

  return <PlayerScreen controller={controllerRef.current} />;
}
