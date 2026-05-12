// v1.1.9 file-size split — extracted from `state.tsx`.
//
// Owns the auto-removal timers for sessions that have entered the `exited`
// status. The user gets a short grace window (EXITED_AUTO_REMOVE_MS) to see
// the final exit code before the pane disappears. A second effect clears
// every pending timer on unmount so we never schedule a dispatch into a
// torn-down provider.

import { useEffect, useRef, type Dispatch } from 'react';
import type { Action, AppState } from '../state.types';

/**
 * Time after which an exited session is auto-removed from the live sessions
 * list. The user can also remove it manually from the Command Room.
 */
const EXITED_AUTO_REMOVE_MS = 5_000;

export function useExitedSessionGc(state: AppState, dispatch: Dispatch<Action>): void {
  // Auto-remove exited sessions after a short grace period so the user can see
  // the final exit code, then the pane disappears.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = timersRef.current;
    for (const session of state.sessions) {
      if (session.status === 'exited' && !timers.has(session.id)) {
        const sessionId = session.id;
        const t = setTimeout(() => {
          // BUG-C3 — guard against firing after unmount or after the session
          // has already been cleared. The unmount cleanup below empties this
          // Map; if our id is no longer present we must not dispatch into a
          // torn-down provider.
          if (!timers.has(sessionId)) return;
          timers.delete(sessionId);
          dispatch({ type: 'REMOVE_SESSION', id: sessionId });
        }, EXITED_AUTO_REMOVE_MS);
        timers.set(sessionId, t);
      }
    }
    // Cancel timers for sessions that are no longer present.
    for (const [id, t] of timers) {
      if (!state.sessions.find((s) => s.id === id)) {
        clearTimeout(t);
        timers.delete(id);
      }
    }
  }, [state.sessions, dispatch]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);
}
