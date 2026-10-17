import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { MusicSessionController, StreamLevels } from './contracts.ts';

const ZERO: StreamLevels = { energy: 0, brightnessHz: 0, pitchHz: null, bufferedMs: 0, underruns: 0 };

/**
 * Subscribe to a controller's ~10 Hz rendered-signal telemetry.
 * Zeros when the controller exposes no stats feed. React re-renders per tick —
 * keep usage to tiny text leaves (TelemetryStrip), never the stage.
 */
export function useStreamLevels(controller: MusicSessionController): StreamLevels {
  const cache = useRef<StreamLevels>(ZERO);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!controller.subscribeStats) return () => { };
      return controller.subscribeStats((levels) => {
        cache.current = levels;
        onChange();
      });
    },
    [controller],
  );
  const getSnapshot = useCallback(() => cache.current, []);

  return useSyncExternalStore(subscribe, getSnapshot);
}
