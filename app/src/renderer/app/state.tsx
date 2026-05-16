// Global renderer state: current workspace, active room, live agent sessions.
/* eslint-disable react-refresh/only-export-components */
// Plain useReducer + Context. No external store dependency.
//
// This file owns the React component (`AppStateProvider`) and a small set of
// always-on effects (store-mirror, initial workspace load, the test-only
// activation hook). The bulk of the side-effectful IPC wiring lives in
// sibling hook modules so this file stays well under 200 LOC:
//   - state-hooks/use-session-restore.ts  — BOOT_UI + session-restore + snapshot
//   - state-hooks/use-workspace-mirror.ts  — open-workspaces mirror in/out
//   - state-hooks/use-live-events.ts       — pty/swarm/browser/skills/memory/review/tasks
//   - state-hooks/use-exited-session-gc.ts — exited-session auto-removal timers
// Pure pieces continue to live in their own siblings:
//   - state.types.ts    — type union, AppState, Action, initialAppState, selectActiveWorkspace
//   - state.reducer.ts  — appStateReducer + its private helpers
//   - state.hook.ts     — AppStateContext + useAppState + useAppStateSelector
// Public re-exports below keep every existing `@/renderer/app/state` import
// path working unchanged — see the rooms-menu-items.ts / workspaces-summary.ts
// pattern this mirrors.

import { useEffect, useLayoutEffect, useMemo, useReducer, type ReactNode } from 'react';
import { rpc } from '../lib/rpc';
import { initialAppState } from './state.types';
import { appStateReducer } from './state.reducer';
import { AppDispatchContext, AppStateContext, appStateStore } from './state.hook';
import { useSessionRestore } from './state-hooks/use-session-restore';
import { useWorkspaceMirror } from './state-hooks/use-workspace-mirror';
import { useLiveEvents } from './state-hooks/use-live-events';
import { useExitedSessionGc } from './state-hooks/use-exited-session-gc';
import { useTerminalCacheGc } from './state-hooks/use-terminal-cache-gc';

// Re-exports so external callers continue to use `@/renderer/app/state`
// without knowing about the split. DO NOT inline these consumers.
export type { Action, AppState, RoomId } from './state.types';
export { initialAppState, selectActiveWorkspace } from './state.types';
export { appStateReducer } from './state.reducer';
export { useAppDispatch, useAppState, useAppStateSelector } from './state.hook';

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appStateReducer, initialAppState);

  useLayoutEffect(() => {
    appStateStore.setState(state);
  }, [state]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ws = await rpc.workspaces.list();
        if (!alive) return;
        dispatch({ type: 'READY', workspaces: ws });
      } catch (err) {
        console.error('Failed to load workspaces:', err);
        dispatch({ type: 'READY', workspaces: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // P3-S8 — Test-only hook. Playwright drives `workspaces.open` via IPC but
  // the renderer's own AppState is unaware until `workspaces.list` re-fires.
  // Rather than exposing a dispatch handle to window (which would leak
  // implementation details), we listen for a `sigma:test:activate-workspace`
  // CustomEvent and re-read the workspace list, then activate the matching
  // entry. No-op in production: the event is never dispatched outside tests.
  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<{ rootPath?: string; id?: string }>).detail ?? {};
      try {
        const list = await rpc.workspaces.list();
        dispatch({ type: 'SET_WORKSPACES', workspaces: list });
        const match = list.find(
          (w) => (detail.id && w.id === detail.id) || (detail.rootPath && w.rootPath === detail.rootPath),
        );
        if (match) dispatch({ type: 'WORKSPACE_OPEN', workspace: match });
      } catch {
        /* test harness: swallow */
      }
    };
    window.addEventListener('sigma:test:activate-workspace', handler as EventListener);
    return () => window.removeEventListener('sigma:test:activate-workspace', handler as EventListener);
  }, []);

  // V1.4.2 packet-03 — same test-only pattern for room navigation. The e2e
  // suite for room-switch xterm preservation drives this rather than relying
  // on a sidebar click whose data attribute might shift between releases.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ room?: string }>).detail ?? {};
      if (typeof detail.room === 'string') {
        dispatch({ type: 'SET_ROOM', room: detail.room as never });
      }
    };
    window.addEventListener('sigma:test:set-room', handler as EventListener);
    return () => window.removeEventListener('sigma:test:set-room', handler as EventListener);
  }, []);

  useSessionRestore(state, dispatch);
  useWorkspaceMirror(state, dispatch);
  useLiveEvents(state, dispatch);
  useExitedSessionGc(state, dispatch);
  // V1.4.2 packet-03 — destroy cached xterm instances when sessions vanish
  // from state (explicit close OR 5s exited-grace timer fired). Without this
  // the terminal-cache would grow unbounded until LRU evicts at 32 entries.
  useTerminalCacheGc(state);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return (
    <AppDispatchContext.Provider value={dispatch}>
      <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
    </AppDispatchContext.Provider>
  );
}
