// v1.1.9 file-size split — extracted from `state.tsx`.
//
// Owns the boot-time UI hydration + session-restore wiring:
//   1. BOOT_UI: hydrates persisted UI flags (onboarded, sidebarCollapsed) from kv.
//   2. `app:session-restore` listener: receives the snapshot from main and
//      stashes it on a ref until the workspace list is ready.
//   3. Drain effect: once `state.ready` is true and `state.workspaces` is
//      hydrated, dispatches WORKSPACE_OPEN / SET_ACTIVE_WORKSPACE_ID / SET_ROOM
//      from the pending payload, resumes panes, and clears the ref.
//   4. `app:session-snapshot` emitter: debounced 250ms snapshot writer that
//      fires whenever the active workspace or room actually changes.

import { useEffect, useRef, type Dispatch } from 'react';
import { rpc } from '../../lib/rpc';
import type { Workspace } from '../../../shared/types';
import type { Action, AppState } from '../state.types';
import { isRoomId, parseSessionRestore, type PendingRestore } from './parsers';

export function useSessionRestore(state: AppState, dispatch: Dispatch<Action>): void {
  // Hydrate persisted UI flags (onboarded, sidebar collapse) from the kv
  // table. Runs once on mount; the theme is loaded by ThemeProvider.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [onboardedRaw, sidebarRaw] = await Promise.all([
          rpc.kv.get('app.onboarded').catch(() => null),
          rpc.kv.get('app.sidebar.collapsed').catch(() => null),
        ]);
        if (!alive) return;
        dispatch({
          type: 'BOOT_UI',
          onboarded: onboardedRaw === '1',
          sidebarCollapsed: sidebarRaw === '1',
        });
      } catch {
        if (alive) dispatch({ type: 'BOOT_UI', onboarded: false, sidebarCollapsed: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [dispatch]);

  // BUG-V1.1.2-02 — Session restore on boot. The main process emits
  // `app:session-restore` once `did-finish-load` fires; we wait until the
  // workspace list has hydrated (`state.ready === true`) before activating
  // the workspace so the WORKSPACE_OPEN dispatch can use a verified row
  // still exists. A missing row (deleted/moved workspace) falls back to the
  // picker — no crash, no toast. The room dispatch only fires if the
  // restored room is a known `RoomId`; an unknown room from a downgrade
  // path keeps the user on 'workspaces' (the default for a fresh boot).
  //
  // We hold the payload across a possibly-not-yet-ready render in a ref so
  // the listener can attach immediately (don't miss the event if main
  // pushes before our effect runs).
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  useEffect(() => {
    const off = window.sigma.eventOn('app:session-restore', (raw: unknown) => {
      const parsed = parseSessionRestore(raw);
      if (parsed) pendingRestoreRef.current = parsed;
    });
    return off;
  }, []);

  // Drain the pending restore once the workspace list has loaded so we can
  // safely look up the workspace by id. Runs whenever `state.ready` flips
  // (cold boot) or whenever the workspace list re-syncs (a deleted workspace
  // shows up here as a no-op). Idempotent — clearing the ref guarantees a
  // single dispatch per snapshot.
  useEffect(() => {
    if (!state.ready) return;
    const pending = pendingRestoreRef.current;
    if (!pending) return;
    const workspaceById = new Map(state.workspaces.map((w) => [w.id, w]));
    const restored = pending.openWorkspaces
      .map((entry) => ({ entry, workspace: workspaceById.get(entry.workspaceId) }))
      .filter((item): item is { entry: { workspaceId: string; room: string }; workspace: Workspace } =>
        Boolean(item.workspace),
      );
    if (restored.length === 0) {
      // Workspaces were deleted/moved between sessions; fall back to picker.
      pendingRestoreRef.current = null;
      return;
    }
    for (const item of [...restored].reverse()) {
      dispatch({ type: 'WORKSPACE_OPEN', workspace: item.workspace });
    }
    const active =
      restored.find((item) => item.workspace.id === pending.activeWorkspaceId) ?? restored[0];
    dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: active.workspace.id });
    // v1.1.10 — seed per-workspace rooms for EVERY restored entry so the
    // next snapshot doesn't lose state for inactive workspaces. The active
    // workspace's room rides on the visible SET_ROOM below as well.
    for (const item of restored) {
      if (isRoomId(item.entry.room)) {
        dispatch({
          type: 'SET_ROOM_FOR_WORKSPACE',
          workspaceId: item.workspace.id,
          room: item.entry.room,
        });
      }
    }
    if (isRoomId(active.entry.room)) {
      dispatch({ type: 'SET_ROOM', room: active.entry.room });
    }
    for (const item of restored) {
      void rpc.panes.resume(item.workspace.id).catch(() => {
        /* pane resume failures are reported by main; restore should continue */
      });
    }
    pendingRestoreRef.current = null;
  }, [state.ready, state.workspaces, dispatch]);

  // BUG-V1.1.2-02 — Persist on change. Every time the active workspace or
  // room actually changes, fire-and-forget `app:session-snapshot` so the
  // main process can flush it to kv on the next quit. Throttled to ≤ 1
  // event/sec so a rapid sequence of room toggles doesn't spam IPC; the
  // trailing-edge timer guarantees the final state still lands.
  //
  // We deliberately skip emission while the boot flow is still hydrating
  // (`state.ready === false`) so the persisted row doesn't get overwritten
  // by the initial 'workspaces' default before the restore effect runs.
  //
  // v1.1.10 — serialise the room PER workspace via `state.roomByWorkspace`
  // instead of stamping the active room onto every entry. Two workspaces
  // sitting in different rooms (e.g. A in 'command', B in 'swarm') now
  // round-trip through restore without forcing both into a single room.
  // Workspaces with no entry fall back to the current active room (newly
  // opened mid-session, never moved) and ultimately to 'command' so the
  // schema's `room: string().min(1)` requirement is satisfied.
  const lastSnapshotRef = useRef<string>('');
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state.ready) return;
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    const fallbackRoom = state.room !== 'workspaces' ? state.room : 'command';
    const entries = state.openWorkspaces.map((workspace) => ({
      workspaceId: workspace.id,
      room: state.roomByWorkspace[workspace.id] ?? (workspace.id === wsId ? fallbackRoom : 'command'),
    }));
    const key = `${wsId}::${entries.map((e) => `${e.workspaceId}=${e.room}`).join('|')}`;
    if (key === lastSnapshotRef.current) return;
    lastSnapshotRef.current = key;
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      try {
        window.sigma.eventSend('app:session-snapshot', {
          activeWorkspaceId: wsId,
          openWorkspaces: entries,
        });
      } catch {
        /* preload bridge gone — nothing actionable on the renderer side */
      }
    }, 250);
    return () => {
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
    };
  }, [
    state.ready,
    state.activeWorkspace?.id,
    state.openWorkspaces,
    state.room,
    state.roomByWorkspace,
  ]);
}
