// C-10b — Renderer → main focused-session push.
//
// Subscribes to the renderer's `activeSessionId` and fire-and-forgets
// `window.sigma.eventSend('voice:focused-session', { sessionId })` on every
// change, debounced ~50 ms to absorb rapid workspace/room switches.
//
// Main wires an `ipcMain.on('voice:focused-session', ...)` listener that
// stores the latest `focusedSessionId` so the global-capture pipeline can
// `pty.write()` into the pane when the "Dictate into the focused pane" toggle
// is on (C-10b T2).
//
// This hook must be mounted once inside `AppStateProvider` next to the other
// state-hook mounts (use-live-events, use-session-restore, etc.).

import { useEffect, useRef } from 'react';
import { useAppStateSelector } from '@/renderer/app/state.hook';

const DEBOUNCE_MS = 50;

export function useVoiceFocusSync(): void {
  const activeSessionId = useAppStateSelector((s) => s.activeSessionId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('sigma' in window)) return;

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      window.sigma.eventSend('voice:focused-session', { sessionId: activeSessionId });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [activeSessionId]);
}
