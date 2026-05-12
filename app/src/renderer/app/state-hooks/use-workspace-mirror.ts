// v1.1.9 file-size split — extracted from `state.tsx`.
//
// Owns the renderer↔main mirror of which workspaces are currently open.
// Two complementary effects:
//   1. Listens to `app:open-workspaces-changed` from main and reconciles the
//      renderer's `state.workspaces` + `openWorkspaces` to match.
//   2. Emits the same event back to main whenever the local open-workspaces
//      list changes so main can persist the snapshot for next launch.
//
// The `workspacesRef` cache lives here (the only consumer) so the listener
// can read the latest workspace list synchronously without re-creating the
// subscription on every state change.

import { useEffect, useRef, type Dispatch } from 'react';
import { rpc } from '../../lib/rpc';
import type { Workspace } from '../../../shared/types';
import type { Action, AppState } from '../state.types';
import { parseOpenWorkspacesChanged } from './parsers';

export function useWorkspaceMirror(state: AppState, dispatch: Dispatch<Action>): void {
  const workspacesRef = useRef<Workspace[]>([]);

  useEffect(() => {
    workspacesRef.current = state.workspaces;
  }, [state.workspaces]);

  // v1.1.3 Step 2 — main-process workspace lifecycle mirror. `workspaces.open`
  // emits the event after it marks a workspace opened, and local close/open
  // state sends the current id list back so the main process can keep one
  // runtime list for Step 6 persistence.
  useEffect(() => {
    const off = window.sigma.eventOn('app:open-workspaces-changed', (raw: unknown) => {
      const workspaceIds = parseOpenWorkspacesChanged(raw);
      if (!workspaceIds) return;
      void (async () => {
        // BUG-C2 — never bail out before SYNC_OPEN_WORKSPACES. Main has already
        // changed openWorkspaces; if we return early on RPC failure the
        // renderer state stays permanently stale. Fall through to dispatch
        // with whatever cached workspaces we have — the reducer filters out
        // unknown ids gracefully (see SYNC_OPEN_WORKSPACES handler).
        let workspaces = workspacesRef.current;
        if (workspaceIds.some((id) => !workspaces.some((w) => w.id === id))) {
          try {
            workspaces = await rpc.workspaces.list();
            dispatch({ type: 'SET_WORKSPACES', workspaces });
          } catch (err) {
            console.warn('[useWorkspaceMirror] rpc.workspaces.list failed', err);
            workspaces = workspacesRef.current;
          }
        }
        dispatch({ type: 'SYNC_OPEN_WORKSPACES', workspaceIds, workspaces });
      })();
    });
    return off;
  }, [dispatch]);

  const lastOpenWorkspaceIdsRef = useRef<string>('');
  useEffect(() => {
    if (!state.ready) return;
    const workspaceIds = state.openWorkspaces.map((w) => w.id);
    const key = workspaceIds.join('\0');
    if (!key && !lastOpenWorkspaceIdsRef.current) return;
    if (key === lastOpenWorkspaceIdsRef.current) return;
    lastOpenWorkspaceIdsRef.current = key;
    try {
      window.sigma.eventSend('app:open-workspaces-changed', { workspaceIds });
    } catch {
      /* preload bridge gone — nothing actionable on the renderer side */
    }
  }, [state.ready, state.openWorkspaces]);
}
