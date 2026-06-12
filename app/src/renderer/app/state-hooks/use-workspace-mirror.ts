// v1.1.9 file-size split — extracted from `state.tsx`.
//
// Owns the renderer↔main mirror of which workspaces are currently open.
// Two complementary effects:
//   1. Listens to `app:open-workspaces-changed` from main and reconciles the
//      renderer's `state.workspaces` + `openWorkspaces` to match.
//   2. Emits the same event back to main whenever the local open-workspaces
//      list changes so main can persist the snapshot for next launch.
//
// Multi-window B3 — this hook is now SCOPE-AWARE. The main window subscribes to
// the UNION broadcast but FILTERS OUT workspaces owned by secondary windows
// (`app:window-scope-changed`), so the same PTY never renders an xterm in two
// windows at once. A scoped (secondary) window keeps ONLY its own workspace and
// NEVER echoes outbound (N echoing windows would stomp main's persisted list).
//
// The `workspacesRef` cache lives here (the only consumer) so the listener
// can read the latest workspace list synchronously without re-creating the
// subscription on every state change.

import { useEffect, useRef, type Dispatch } from 'react';
import { rpc } from '../../lib/rpc';
import { getWorkspaceScope, isMainWindow } from '../../lib/window-context';
import type { Workspace } from '../../../shared/types';
import type { Action, AppState } from '../state.types';
import { parseOpenWorkspacesChanged, parseWindowScopeChanged } from './parsers';

// MODULE scope (survives remounts — PaneSplash lesson): the latest scope table
// and the last union broadcast, so a scope flip can re-filter immediately
// without waiting for a fresh open-list event. `secondaryOwned` is the set of
// workspaceIds owned by NON-main windows; the main window subtracts them.
let secondaryOwned = new Set<string>();
let lastUnion: string[] = [];
// Monotonic reconcile token. Two rapid events can race across the
// `await rpc.workspaces.list()` boundary — without this the OLDER reconcile
// dispatches LAST with a stale visible set (re-showing a detached ws /
// dropping a redocked one). Every dispatch after an await first checks it is
// still the newest reconcile; the synchronous no-await path completes in the
// same tick, so its check trivially passes.
let reconcileSeq = 0;

/**
 * The subset of `workspaceIds` THIS window should actually open:
 *   - scoped (secondary) window → only its own workspace id
 *   - main window → the union minus any workspace owned by a secondary window
 */
function visibleSubset(workspaceIds: string[]): string[] {
  const scope = getWorkspaceScope();
  if (scope) return workspaceIds.filter((id) => id === scope);
  return workspaceIds.filter((id) => !secondaryOwned.has(id));
}

/** Test-only — clear the module-scope caches between cases. */
export function __resetWorkspaceMirrorModuleStateForTests(): void {
  secondaryOwned = new Set();
  lastUnion = [];
  reconcileSeq = 0;
}

export function useWorkspaceMirror(state: AppState, dispatch: Dispatch<Action>): void {
  const workspacesRef = useRef<Workspace[]>([]);

  useEffect(() => {
    workspacesRef.current = state.workspaces;
  }, [state.workspaces]);

  // v1.1.3 Step 2 — main-process workspace lifecycle mirror. `workspaces.open`
  // emits the event after it marks a workspace opened, and local close/open
  // state sends the current id list back so the main process can keep one
  // runtime list for Step 6 persistence.
  //
  // Multi-window B3 — the inbound reconcile body is SHARED between the two
  // subscribers (open-list union + scope-table change). Extracted as a local
  // `reconcile` so it closes over dispatch/workspacesRef while the caches stay
  // at module scope. `reconcile` always filters the union through
  // `visibleSubset` before dispatching SYNC.
  useEffect(() => {
    const reconcile = (workspaceIds: string[]) => {
      const seq = ++reconcileSeq;
      void (async () => {
        // BUG-C2 — never bail out before SYNC_OPEN_WORKSPACES. Main has already
        // changed openWorkspaces; if we return early on RPC failure the
        // renderer state stays permanently stale. Fall through to dispatch
        // with whatever cached workspaces we have — the reducer filters out
        // unknown ids gracefully (see SYNC_OPEN_WORKSPACES handler).
        let visible = visibleSubset(workspaceIds);
        let workspaces = workspacesRef.current;
        if (visible.some((id) => !workspaces.some((w) => w.id === id))) {
          try {
            const fetched = await rpc.workspaces.list();
            // A newer event superseded this reconcile while we awaited — its
            // own reconcile already dispatched (or will) with fresher data.
            if (seq !== reconcileSeq) return;
            workspaces = fetched;
            dispatch({ type: 'SET_WORKSPACES', workspaces });
          } catch (err) {
            console.warn('[useWorkspaceMirror] rpc.workspaces.list failed', err);
            if (seq !== reconcileSeq) return;
            workspaces = workspacesRef.current;
          }
          // Re-derive POST-await so a mid-flight scope change is honored even
          // if (defensively) it didn't bump the token itself.
          visible = visibleSubset(workspaceIds);
        }
        if (seq !== reconcileSeq) return;
        dispatch({ type: 'SYNC_OPEN_WORKSPACES', workspaceIds: visible, workspaces });
      })();
    };

    const offOpen = window.sigma.eventOn('app:open-workspaces-changed', (raw: unknown) => {
      const workspaceIds = parseOpenWorkspacesChanged(raw);
      if (!workspaceIds) return;
      lastUnion = workspaceIds;
      reconcile(workspaceIds);
    });

    // Multi-window B3 — ownership changed (detach/redock/window-close). Rebuild
    // the secondary-owned set from the non-main entries, then RE-RUN reconcile
    // with the freshest union so a detach drops the workspace from the main
    // window IMMEDIATELY (no need to wait for a new open-list event).
    const offScope = window.sigma.eventOn('app:window-scope-changed', (raw: unknown) => {
      const scopes = parseWindowScopeChanged(raw);
      if (!scopes) return; // malformed — ignore, no state change
      const next = new Set<string>();
      for (const s of scopes) {
        if (s.isMain) continue;
        for (const id of s.workspaceIds) next.add(id);
      }
      secondaryOwned = next;
      reconcile(lastUnion);
    });

    return () => {
      offOpen();
      offScope();
    };
  }, [dispatch]);

  const lastOpenWorkspaceIdsRef = useRef<string>('');
  useEffect(() => {
    // Multi-window B3 — ONLY the main window echoes outbound. A scoped window
    // echoing its single-workspace list would stomp main's persisted full list.
    if (!isMainWindow()) return;
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
