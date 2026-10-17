// Composition root. Owned by B (src/App.tsx); controller wiring by D.
// The session controller is created lazily once per app lifetime via a ref (not state):
// StrictMode's dev-only render/effect replay reuses the same ref, so exactly one
// controller — and no audio — is constructed per mount.

import { useRef, useEffect } from 'react';
import { PlayerScreen, MockMusicSessionController } from './ui/index.ts';
import { createPCMPlayer, MockPcmGenerator } from './audio/index.ts';
import type { MusicSessionController } from './ui/index.ts';
import { createBrowserController } from './controller/browser.ts';

export default function App() {
  const controllerRef = useRef<MusicSessionController | null>(null);
  if (controllerRef.current === null) {
    // `?mock` keeps the app standalone (no relay) for local UI work.
    if (new URLSearchParams(window.location.search).has('mock')) {
      controllerRef.current = new MockMusicSessionController({
        playerFactory: () => createPCMPlayer(),
        generatorFactory: () => new MockPcmGenerator(),
      });
    } else {
      controllerRef.current = createBrowserController();
    }
  }

  // Mount-only cleanup. StrictMode replays effects in dev, so stop() must stay a
  // no-op before start() — the ref above survives the replay untouched.
  useEffect(() => () => {
    controllerRef.current?.stop();
  }, []);

  return <PlayerScreen controller={controllerRef.current} />;
}
