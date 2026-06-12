// Multi-window B4 — scoped-window self-hydration.
//
// `main.ts` only pushes `app:session-restore` to the MAIN window, so a scoped
// (secondary / detached-workspace) window receives nothing on boot and would
// render empty. This hook is that window's boot path: it loads its ONE
// workspace and hydrates its panes by MIRRORING use-session-restore's
// per-workspace pane-hydration dispatches verbatim (same RPCs, same actions,
// same payload shape, no status filtering — the restore path applies none).
//
// Runs ONCE per process and ONLY in a scoped window — the main window keeps
// using useSessionRestore (which is now gated to skip scoped windows). The two
// must never both hydrate the same workspace (double-resume / racing dispatch).
//
// Resume behaviour is identical to the main restore path: `rpc.panes.resume`
// re-attaches live PTYs (they snapshot in via the terminal cache) and resumes
// dead-but-eligible sessions, then `rpc.panes.listForWorkspace` + `rpc.swarms.list`
// rehydrate state so CommandRoom sees the panes + swarms.

import { useEffect, useRef, type Dispatch } from 'react';
import { toast } from 'sonner';
import { rpc } from '../../lib/rpc';
import { getWorkspaceScope } from '../../lib/window-context';
import type { Action, AppState } from '../state.types';

// `_state` is unused — the hook fetches its workspace list directly via RPC and
// never reads renderer state. It keeps the `(state, dispatch)` shape of its
// sibling state-hooks so the mount in state.tsx stays uniform.
export function useWindowScopeBoot(_state: AppState, dispatch: Dispatch<Action>): void {
  // Run-once guard — flipped only AFTER the boot dispatches actually COMMIT.
  // Flipping it at effect entry broke StrictMode's dev mount→cleanup→mount:
  // run 1 marked itself booted, the cleanup cancelled it (alive=false), and
  // run 2 early-returned → the scoped window never hydrated in dev. A
  // cancelled run now leaves the ref false so the remount restarts the boot.
  const bootedRef = useRef(false);
  // In-flight guard: set at effect entry, cleared on cancellation (cleanup)
  // or completion, so two simultaneously-proceeding mounts can't double-boot.
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Main window no-op — it uses useSessionRestore. Read scope at call time
    // (window-context.ts is preload-injected, static per process).
    const scope = getWorkspaceScope();
    if (!scope) return;
    if (bootedRef.current || inFlightRef.current) return;
    inFlightRef.current = true;

    let alive = true;
    void (async () => {
      let workspaces: AppState['workspaces'];
      try {
        workspaces = await rpc.workspaces.list();
      } catch (err) {
        console.warn('[useWindowScopeBoot] rpc.workspaces.list failed', err);
        // Not booted — release the in-flight guard so a remount can retry.
        if (alive) inFlightRef.current = false;
        return;
      }
      if (!alive) return; // cancelled — cleanup already released in-flight
      const workspace = workspaces.find((w) => w.id === scope);
      if (!workspace) {
        // The operator closed/deleted this workspace between sessions. Show
        // empty — acceptable for a scoped window (it can't fall back to a
        // picker; that's a main-window surface, a design non-goal here).
        console.warn(
          '[useWindowScopeBoot] scoped workspace not found; window stays empty:',
          scope,
        );
        // A committed terminal outcome — mark booted so remounts don't
        // refetch+rewarn forever.
        bootedRef.current = true;
        inFlightRef.current = false;
        return;
      }

      // Open + activate this ONE workspace. SET_WORKSPACES first so
      // WORKSPACE_OPEN's upsert + SET_ACTIVE_WORKSPACE_ID's openWorkspaces
      // lookup operate on a known list.
      dispatch({ type: 'SET_WORKSPACES', workspaces });
      dispatch({ type: 'WORKSPACE_OPEN', workspace });
      dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: workspace.id });
      // Dispatches committed while still mounted — NOW mark booted (run-once)
      // and release the in-flight guard.
      bootedRef.current = true;
      inFlightRef.current = false;

      // ---- Pane hydration: VERBATIM mirror of use-session-restore's
      // per-workspace block (resume → listForWorkspace + swarms.list →
      // ADD_SESSIONS / UPSERT_SWARM / SET_ACTIVE_SWARM), scoped to this one
      // workspace. Keep the two read-paths identical (two-read-paths drift
      // class) — change them together if the restore path changes.
      try {
        const result = await rpc.panes.resume(workspace.id);
        if (!alive) return;
        try {
          const [sessions, swarms] = await Promise.all([
            rpc.panes.listForWorkspace(workspace.id),
            rpc.swarms.list(workspace.id),
          ]);
          if (!alive) return;
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
        // Surface resume failures the same way the main restore path does: a
        // single toast with a "Respawn fresh" action wired to
        // panes.respawnFailed for this workspace.
        if (result.failed.length > 0) {
          const failedTotal = result.failed.length;
          const resumedTotal = result.resumed.length;
          const failedNoun = failedTotal === 1 ? 'pane needs' : 'panes need';
          const summary =
            resumedTotal > 0
              ? `Resumed ${resumedTotal} pane${resumedTotal === 1 ? '' : 's'}. ${failedTotal} ${failedNoun} to be respawned.`
              : `${failedTotal} ${failedNoun} to be respawned.`;
          toast.error(summary, {
            description: workspace.name,
            action: {
              label: 'Respawn fresh',
              onClick: () => {
                void rpc.panes
                  .respawnFailed(workspace.id)
                  .then((r) => {
                    if (r.failed === 0 && r.spawned > 0) {
                      toast.success(`Respawned ${r.spawned} pane${r.spawned === 1 ? '' : 's'}`);
                    } else if (r.failed > 0) {
                      toast.error(
                        `Respawned ${r.spawned} pane${r.spawned === 1 ? '' : 's'}; ${r.failed} still failing`,
                      );
                    }
                  })
                  .catch(() => undefined);
              },
            },
          });
        }
      } catch (err) {
        // RPC-level resume failure (preload gone, main crash). Surface a single
        // failure toast — same posture as the main path's per-workspace catch.
        toast.error('1 pane needs to be respawned.', {
          description: workspace.name,
        });
        console.warn('[useWindowScopeBoot] rpc.panes.resume failed', err);
      }
    })();

    return () => {
      alive = false;
      // StrictMode mount→cleanup→mount: a CANCELLED run must not poison the
      // remount — release the in-flight guard so the second mount restarts.
      // (If the boot already committed, bootedRef gates the re-run instead.)
      inFlightRef.current = false;
    };
  }, [dispatch]);
}
