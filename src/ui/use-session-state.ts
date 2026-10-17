import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { MusicSessionController, SessionUiState } from './contracts.ts';

/**
 * Subscribe to a session controller and render its latest SessionUiState.
 *
 * The controller emits synchronously inside `subscribe` (and on every change), so a ref
 * caches the last emission for `getSnapshot`. Re-subscribing — e.g. StrictMode's
 * double-mount or a new controller — re-emits synchronously, keeping the cache honest.
 */
export function useSessionState(controller: MusicSessionController): SessionUiState {
  const cache = useRef<SessionUiState>({ status: 'idle' });

  const subscribe = useCallback(
    (onChange: () => void) =>
      controller.subscribe((state) => {
        cache.current = state;
        onChange();
      }),
    [controller],
  );
  const getSnapshot = useCallback(() => cache.current, []);

  return useSyncExternalStore(subscribe, getSnapshot);
}
