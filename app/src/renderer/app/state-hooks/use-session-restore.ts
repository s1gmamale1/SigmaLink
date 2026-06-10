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

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { toast } from 'sonner';
import { rpc } from '../../lib/rpc';
import type { Workspace } from '../../../shared/types';
import { isGlobalRoom, type Action, type AppState } from '../state.types';
import { isRoomId, normalizeRoomId, parseSessionRestore, type PendingRestore } from './parsers';

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
  // The ref above buffers an EARLY-arriving payload (event fires before the
  // drain effect first runs). But a ref update does NOT re-run the drain
  // effect, so a LATE-arriving payload (event fires AFTER the drain already ran
  // with `state.ready === true`) would never be processed — resume never fires,
  // panes stay black. (Phase-0 `d384b0e` awaits the boot worktree-sweep before
  // opening the window, which delays this IPC past workspaces-ready, making the
  // late case the common one on any install with worktrees.) Bump this nonce
  // when the payload lands so the drain effect re-runs in BOTH orderings.
  const [restoreTick, setRestoreTick] = useState(0);
  useEffect(() => {
    const off = window.sigma.eventOn('app:session-restore', (raw: unknown) => {
      const parsed = parseSessionRestore(raw);
      if (parsed) {
        pendingRestoreRef.current = parsed;
        setRestoreTick((t) => t + 1);
      }
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
      const normalizedRoom = normalizeRoomId(item.entry.room);
      if (isRoomId(normalizedRoom)) {
        dispatch({
          type: 'SET_ROOM_FOR_WORKSPACE',
          workspaceId: item.workspace.id,
          room: normalizedRoom,
        });
      }
    }
    const normalizedActiveRoom = normalizeRoomId(active.entry.room);
    if (isRoomId(normalizedActiveRoom)) {
      dispatch({ type: 'SET_ROOM', room: normalizedActiveRoom });
    }
    // v1.2.8 / R-1.2.7-5 — aggregate per-workspace resume results into ONE
    // toast per restart. Previously this fired one toast per failing
    // workspace, which spammed the operator on a cold boot where multiple
    // workspaces could not resume. With v1.2.8's `--continue` universal
    // fallback, hitting failures here is rare and almost always recoverable
    // by a fresh respawn, so the toast carries an action button that wires
    // through `panes.respawnFailed(workspaceId)` per affected workspace.
    void Promise.all(
      restored.map((item) =>
        rpc.panes
          .resume(item.workspace.id)
          .then(async (result) => {
            // v1.4.3 (#02) — Rehydrate persisted pane sessions into state
            // immediately after resume resolves. Dispatching ADD_SESSIONS here
            // (before the toast / GC effects run) ensures CommandRoom sees the
            // sessions and terminal-cache GC doesn't dispose them unnecessarily.
            // v1.5.3-hotfix — also hydrate swarms; without this `activeSwarm`
            // stays null in CommandRoom even after panes appear, so
            // AddPaneButton shows the misleading "Open or create a workspace
            // first" disabledReason even with a workspace + 6 panes visible.
            // Same hydration-gap class as the v1.5.3 Sigma dispatch fix.
            try {
              const [sessions, swarms] = await Promise.all([
                rpc.panes.listForWorkspace(item.workspace.id),
                rpc.swarms.list(item.workspace.id),
              ]);
              if (sessions.length > 0) {
                dispatch({ type: 'ADD_SESSIONS', sessions });
              }
              if (swarms.length > 0) {
                for (const swarm of swarms) {
                  dispatch({ type: 'UPSERT_SWARM', swarm });
                }
                const running = swarms.find((s) => s.status === 'running');
                if (running) {
                  dispatch({ type: 'SET_ACTIVE_SWARM', id: running.id });
                }
              }
            } catch {
              // Best-effort — rehydration failure does not break resume flow.
            }
            return { workspace: item.workspace, result, error: null as string | null };
          })
          .catch((err: unknown) => ({
            workspace: item.workspace,
            result: null as null | Awaited<ReturnType<typeof rpc.panes.resume>>,
            error: err instanceof Error ? err.message : String(err),
          })),
      ),
    ).then((outcomes) => {
      let resumedTotal = 0;
      let failedTotal = 0;
      const failedWorkspaces: Array<{ id: string; name: string }> = [];
      for (const o of outcomes) {
        if (o.result) {
          resumedTotal += o.result.resumed.length;
          if (o.result.failed.length > 0) {
            failedTotal += o.result.failed.length;
            failedWorkspaces.push({ id: o.workspace.id, name: o.workspace.name });
          }
        } else if (o.error) {
          // RPC-level failure (e.g. preload bridge gone) — surface as a
          // single workspace failure with an unknown pane count of 1.
          failedTotal += 1;
          failedWorkspaces.push({ id: o.workspace.id, name: o.workspace.name });
        }
      }
      if (failedTotal === 0) return;
      const failedNoun = failedTotal === 1 ? 'pane needs' : 'panes need';
      const summary =
        resumedTotal > 0
          ? `Resumed ${resumedTotal} pane${resumedTotal === 1 ? '' : 's'}. ${failedTotal} ${failedNoun} to be respawned.`
          : `${failedTotal} ${failedNoun} to be respawned.`;
      const description =
        failedWorkspaces.length === 1
          ? failedWorkspaces[0]?.name
          : `${failedWorkspaces.length} workspaces affected`;
      toast.error(summary, {
        description,
        // The action button routes through `panes.respawnFailed` for every
        // workspace that reported a failure. Fire-and-forget — the followup
        // toast confirms the aggregate spawn/fail count from main.
        action: {
          label: 'Respawn fresh',
          onClick: () => {
            void Promise.all(
              failedWorkspaces.map((w) =>
                rpc.panes
                  .respawnFailed(w.id)
                  .catch((err: unknown) => ({
                    workspaceId: w.id,
                    spawned: 0,
                    failed: 1,
                    error: err instanceof Error ? err.message : String(err),
                  })),
              ),
            ).then((results) => {
              let spawned = 0;
              let stillFailed = 0;
              for (const r of results) {
                spawned += r.spawned;
                stillFailed += r.failed;
              }
              if (stillFailed === 0 && spawned > 0) {
                toast.success(
                  `Respawned ${spawned} pane${spawned === 1 ? '' : 's'}`,
                );
              } else if (stillFailed > 0) {
                toast.error(
                  `Respawned ${spawned} pane${spawned === 1 ? '' : 's'}; ${stillFailed} still failing`,
                );
              }
            });
          },
        },
      });
    });
    pendingRestoreRef.current = null;
  }, [state.ready, state.workspaces, dispatch, restoreTick]);

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
  //
  // v1.3.3 — compute the snapshot key outside the effect so we can detect
  // no-op re-renders. The effect cleanup always runs before the new effect
  // body (React contract), which previously cancelled the debounce timer
  // even when the key hadn't changed — the early-return path then never
  // rescheduled. By tracking the previous key in a ref and only cancelling
  // when it differs, we preserve the pending timer across no-op updates.
  const wsId = state.activeWorkspace?.id;
  // 2026-06-10 — global rooms (workspaces/settings/automations) must never be
  // serialized as a workspace's room; fall back to 'command'. Shares
  // isGlobalRoom with the reducer's three guard sites (anti-drift).
  const fallbackRoom = !isGlobalRoom(state.room) ? state.room : 'command';
  // v1.5.5 A5 — wrap in useMemo so the array reference is stable across
  // re-renders where the content hasn't changed.  Without this the deps
  // array of the snapshot effect below would see a new array on every render,
  // causing the exhaustive-deps rule to flag it as a potentially-changing
  // conditional dep.  useMemo ties the reference identity to the primitives
  // that actually govern the content.
  const snapshotEntries = useMemo(
    () =>
      wsId
        ? state.openWorkspaces.map((workspace) => ({
            workspaceId: workspace.id,
            room:
              state.roomByWorkspace[workspace.id] ??
              (workspace.id === wsId ? fallbackRoom : 'command'),
          }))
        : [],
    [wsId, state.openWorkspaces, state.roomByWorkspace, fallbackRoom],
  );
  const snapshotKey = wsId
    ? `${wsId}::${snapshotEntries.map((e) => `${e.workspaceId}=${e.room}`).join('|')}`
    : '';

  // 2026-06-10 finding 4 — mark-on-write + flush-on-teardown.
  //
  // The old shape marked `lastSnapshotKeyRef` BEFORE the 250ms debounce fired
  // and the unmount cleanup cancelled the timer — an unmount/quit inside the
  // window silently dropped the FINAL snapshot (the key was already "written"
  // so it could never be retried). Now:
  //   • `pendingSnapshotRef` holds the payload of the scheduled write;
  //   • `lastSentKeyRef` is set only when the write actually EXECUTES;
  //   • unmount and `beforeunload` FLUSH the pending write instead of
  //     dropping it.
  // The v1.3.3 no-op-re-render guarantee is preserved: a re-render with an
  // unchanged key early-returns on the pending-key compare and never touches
  // the timer.
  const lastSentKeyRef = useRef<string>('');
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSnapshotRef = useRef<{
    key: string;
    activeWorkspaceId: string;
    openWorkspaces: Array<{ workspaceId: string; room: string }>;
  } | null>(null);

  // Send the pending snapshot NOW (if any) and mark its key as written.
  // Stable identity (no deps) so the teardown effect never re-subscribes.
  const flushSnapshot = useCallback(() => {
    const pending = pendingSnapshotRef.current;
    if (!pending) return;
    pendingSnapshotRef.current = null;
    if (snapshotTimerRef.current) {
      clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    lastSentKeyRef.current = pending.key;
    try {
      window.sigma.eventSend('app:session-snapshot', {
        activeWorkspaceId: pending.activeWorkspaceId,
        openWorkspaces: pending.openWorkspaces,
      });
    } catch {
      /* preload bridge gone — nothing actionable on the renderer side */
    }
  }, []);

  // Flush (not drop) on unmount AND on window unload, so a quit/reload inside
  // the debounce window still persists the final snapshot.
  useEffect(() => {
    window.addEventListener('beforeunload', flushSnapshot);
    return () => {
      window.removeEventListener('beforeunload', flushSnapshot);
      flushSnapshot();
    };
  }, [flushSnapshot]);

  useEffect(() => {
    if (!state.ready) return;
    if (!snapshotKey) return;
    const pending = pendingSnapshotRef.current;
    // No-op when this exact content is already scheduled, or already written
    // with nothing newer pending.
    if (snapshotKey === (pending?.key ?? lastSentKeyRef.current)) return;
    if (snapshotKey === lastSentKeyRef.current && pending) {
      // State changed BACK to the last-written key while a DIFFERENT write
      // was pending (A → B → A inside the window): cancel the stale B write
      // instead of letting it persist over the already-correct A.
      pendingSnapshotRef.current = null;
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      return;
    }
    pendingSnapshotRef.current = {
      key: snapshotKey,
      activeWorkspaceId: wsId!,
      openWorkspaces: snapshotEntries,
    };
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      snapshotTimerRef.current = null;
      flushSnapshot();
    }, 250);
  }, [state.ready, snapshotKey, snapshotEntries, wsId, flushSnapshot]);
}
