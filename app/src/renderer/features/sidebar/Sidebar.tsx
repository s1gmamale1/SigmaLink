// SigmaLink sidebar — V3 SigmaMind layout.
// The rail is now a pure workspaces panel. The 12-item room nav moved to a
// top-bar dropdown (Step 2). The Cmd+K command-palette card was dropped
// from the rail too — the keyboard shortcut still works app-wide. Header
// keeps the Σ monogram + wordmark + collapse chevron; the footer still
// shows the active-workspace summary so users can see at a glance which
// repo they're operating on.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Monogram } from '@/renderer/components/Monogram';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { PLATFORM_IS_MAC } from '@/renderer/lib/shortcuts';
import { isMainWindow } from '@/renderer/lib/window-context';
import { dragStyle, noDragStyle } from '@/renderer/lib/drag-region';
import { useBelowBreakpoint } from '@/renderer/lib/use-breakpoint';
import { DEV_WORKSPACE_KV_KEY, DEV_WORKSPACE_MAX_PANES } from '@/shared/special-workspace';
import type { GridPreset, Workspace } from '@/shared/types';
import { WorkspacesPanel } from './WorkspacesPanel';
import { DevWorkspaceDialog } from './DevWorkspaceDialog';

const APP_SIDEBAR_DEFAULT = 240;
const APP_SIDEBAR_MIN = 180;
const APP_SIDEBAR_MAX = 480;
// Sidebar width is a GLOBAL preference (universal across workspaces). The
// sidebar renders only in the main window, so a single global key is used.
const APP_SIDEBAR_WIDTH_KEY = 'app.sidebar.width';
const APP_SIDEBAR_COLLAPSED_KEY = 'app.sidebar.collapsed';
// SigmaLink Dev — grid preset snap steps for the launch plan. Preset is a UI
// hint only (panes[] drives the real pane count); hoisted to module scope so
// it isn't re-allocated on every launch.
const DEV_PRESET_STEPS: GridPreset[] = [1, 2, 4, 6, 8, 10, 12];

export function Sidebar() {
  // V1.1.10 perf — slice subscriptions instead of full AppState. Sidebar
  // previously re-rendered on every dispatch (notifications, chat events,
  // browser state) because it consumed the entire context.
  const dispatch = useAppDispatch();
  const activeWorkspace = useAppStateSelector((s) => s.activeWorkspace);
  const collapsed = useAppStateSelector((s) => s.sidebarCollapsed);
  const openWorkspaces = useAppStateSelector((s) => s.openWorkspaces);
  const workspaces = useAppStateSelector((s) => s.workspaces);
  const sessions = useAppStateSelector((s) => s.sessions);
  const attentionWorkspaces = useAppStateSelector((s) => s.attentionWorkspaces);

  // SigmaLink Dev (Phase 14) — terminal-count dialog visibility + the KV
  // pointer to the singleton dev workspace (used for the DEV badge / `~`
  // subtitle on its row). The pointer is read once on mount and refreshed
  // whenever the flow opens-or-creates the workspace.
  const [devDialogOpen, setDevDialogOpen] = useState(false);
  const [devWorkspaceId, setDevWorkspaceId] = useState<string | null>(null);
  // In-flight launch guard. workspaces.launch is ADDITIVE server-side — a
  // double-fire would spawn 2N panes. The REF is the actual re-entrancy gate
  // (state lags a render, so a second click queued in the same tick would
  // still read launching=false); the STATE mirrors it to disable the dialog's
  // Launch button.
  const [devLaunching, setDevLaunching] = useState(false);
  const devLaunchingRef = useRef(false);
  useEffect(() => {
    void rpc.kv
      .get(DEV_WORKSPACE_KV_KEY)
      .then((v) => setDevWorkspaceId(v ?? null))
      .catch(() => undefined);
  }, []);

  // v1.4.8 packet-02 — stateful expanded width with kv persistence.
  const [sidebarWidth, setSidebarWidth] = useState<number>(APP_SIDEBAR_DEFAULT);
  // Track dragging with a ref (not state) to avoid spurious re-renders in the
  // hot pointermove path. A React state boolean is used for the transition
  // suppression since it needs to affect the className.
  const [isDraggingState, setIsDraggingState] = useState(false);
  const isDragging = useRef(false);
  const rafHandle = useRef<number | null>(null);

  // Sidebar width is universal across workspaces — read the global key once on
  // mount (no per-workspace re-hydrate). Detached windows have no Sidebar.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const v = await rpc.kv.get(APP_SIDEBAR_WIDTH_KEY).catch(() => null);
      if (!alive) return;
      const n = Number(v);
      if (Number.isFinite(n) && n >= APP_SIDEBAR_MIN && n <= APP_SIDEBAR_MAX) {
        setSidebarWidth(n);
      } else {
        setSidebarWidth(APP_SIDEBAR_DEFAULT);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Persist under the single global key (best-effort; layout is non-critical).
  const persistWidth = useCallback((value: number) => {
    void rpc.kv.set(APP_SIDEBAR_WIDTH_KEY, String(value)).catch(() => undefined);
  }, []);

  const startSidebarDrag = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const startWidth = sidebarWidth;
      isDragging.current = true;
      setIsDraggingState(true);
      document.body.dataset.dragging = 'true';

      // `pending` holds the next value waiting for a rAF tick.
      // `committed` holds the last value we actually applied (for kv persist on up).
      let pending: number | null = null;
      let committed = startWidth;

      const flush = () => {
        if (pending !== null) {
          committed = pending;
          setSidebarWidth(pending);
        }
        pending = null;
        rafHandle.current = null;
      };

      const move = (e: PointerEvent) => {
        pending = Math.max(
          APP_SIDEBAR_MIN,
          Math.min(APP_SIDEBAR_MAX, startWidth + (e.clientX - startX)),
        );
        if (rafHandle.current === null) {
          rafHandle.current = requestAnimationFrame(flush);
        }
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        isDragging.current = false;
        setIsDraggingState(false);
        delete document.body.dataset.dragging;
        // Flush any pending rAF synchronously on pointerup.
        if (rafHandle.current !== null) {
          cancelAnimationFrame(rafHandle.current);
          rafHandle.current = null;
          if (pending !== null) {
            committed = pending;
            setSidebarWidth(pending);
          }
        }
        pending = null;
        // Persist the final committed width to the per-workspace kv key.
        persistWidth(committed);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [sidebarWidth, persistWidth],
  );

  // RSP-1 — auto-collapse on narrow windows via the shared breakpoint hook
  // (`compact` = 1100px), replacing the bespoke window.innerWidth listener.
  // One-way semantics preserved: collapse when the viewport is below the
  // breakpoint, but widening does NOT auto-re-expand — the user's explicit
  // toggle on a wide monitor wins.
  const belowCompact = useBelowBreakpoint('compact');
  useEffect(() => {
    if (belowCompact && !collapsed) {
      dispatch({ type: 'SET_SIDEBAR_COLLAPSED', collapsed: true });
    }
  }, [belowCompact, collapsed, dispatch]);

  function setCollapsed(next: boolean) {
    dispatch({ type: 'SET_SIDEBAR_COLLAPSED', collapsed: next });
    // review M1 — collapse is a GLOBAL preference: session-restore reads
    // `app.sidebar.collapsed` on boot to seed BOOT_UI. (Only the WIDTH is
    // per-workspace.) Always write the global key so collapse survives restart.
    void rpc.kv.set(APP_SIDEBAR_COLLAPSED_KEY, next ? '1' : '0').catch(() => undefined);
  }

  async function openPersistedWorkspace(ws: Workspace) {
    // SigmaLink Dev (2026-06-11) — belt: if somehow the dev row leaks through
    // to this handler (e.g. a stale persisted-closed list), intercept it and
    // route to the proper dev flow instead of re-opening by path.
    if (devWorkspaceId && ws.id === devWorkspaceId) {
      await openDevWorkspaceFlow();
      return;
    }
    try {
      const reopened = await rpc.workspaces.open(ws.rootPath);
      dispatch({ type: 'WORKSPACE_OPEN', workspace: reopened });
      dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
      // v1.4.3 (#02) — Rehydrate persisted pane sessions into state before
      // routing to Command Room so CommandRoom renders existing panes instead
      // of EmptyState. ADD_SESSIONS dispatches BEFORE the room switch so the
      // terminal-cache GC never sees the sessions as absent.
      // v1.5.3-hotfix — also hydrate swarms; without UPSERT_SWARM the
      // renderer's activeSwarm stays null and AddPaneButton shows misleading
      // "Open or create a workspace first" even with panes visible.
      const [sessions, swarms] = await Promise.all([
        rpc.panes.listForWorkspace(reopened.id),
        rpc.swarms.list(reopened.id),
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
      // v1.3.3 — route into the Command Room where the panes are visible.
      // Without this the user lands on the Launcher's Start step even though
      // the workspace already has running panes.
      dispatch({ type: 'SET_ROOM', room: 'command' });
    } catch (err) {
      console.error('Failed to open workspace:', err);
    }
  }

  // SigmaLink Dev — menu entry. Open-or-create the singleton; if it already has
  // pane rows, mirror the boot-restore path (resume → hydrate → route) so dead
  // shells respawn fresh; otherwise ask for a terminal count first. The dev
  // workspace never owns swarms, so we skip the swarms.list hydration that
  // openPersistedWorkspace does.
  async function openDevWorkspaceFlow() {
    try {
      const ws = await rpc.workspaces.openDev();
      setDevWorkspaceId(ws.id);
      dispatch({ type: 'WORKSPACE_OPEN', workspace: ws });
      dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
      const sessions = await rpc.panes.listForWorkspace(ws.id);
      if (sessions.length === 0) {
        // Fresh (or fully reaped) dev workspace — ask how many terminals.
        dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
        setDevDialogOpen(true);
        return;
      }
      // Path A — existing panes: respawn dead shells fresh, then hydrate.
      await rpc.panes.resume(ws.id).catch(() => undefined);
      const refreshed = await rpc.panes.listForWorkspace(ws.id);
      if (refreshed.length > 0) dispatch({ type: 'ADD_SESSIONS', sessions: refreshed });
      dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
      dispatch({ type: 'SET_ROOM', room: 'command' });
    } catch (err) {
      console.error('Failed to open SigmaLink Dev workspace:', err);
    }
  }

  // SigmaLink Dev — launch N plain shell panes after the count dialog commits.
  async function launchDevTerminals(paneCount: number) {
    // Re-entrancy guard — see devLaunchingRef. A second fire while the rpc is
    // in flight would queue a second ADDITIVE plan → 2N panes.
    if (devLaunchingRef.current) return;
    devLaunchingRef.current = true;
    setDevLaunching(true);
    setDevDialogOpen(false);
    try {
      const ws = await rpc.workspaces.openDev(); // idempotent — returns the singleton
      // Preset is a UI hint; the launcher iterates `panes` for the real count.
      // Snap to the smallest preset step that fits paneCount.
      const preset = DEV_PRESET_STEPS.find((p) => p >= paneCount) ?? DEV_WORKSPACE_MAX_PANES;
      const { sessions } = await rpc.workspaces.launch({
        workspaceRoot: ws.rootPath,
        workspaceId: ws.id,
        preset,
        panes: Array.from({ length: paneCount }, (_, i) => ({
          paneIndex: i,
          providerId: 'shell',
        })),
      });
      if (sessions.length > 0) dispatch({ type: 'ADD_SESSIONS', sessions });
      dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
      dispatch({ type: 'SET_ROOM', room: 'command' });
    } catch (err) {
      console.error('Failed to launch SigmaLink Dev terminals:', err);
    } finally {
      devLaunchingRef.current = false;
      setDevLaunching(false);
    }
  }

  return (
    <>
    <aside
      aria-label="Sidebar"
      data-testid="sidebar"
      className={cn(
        // BSP-T4 — `sl-chrome-tint` opts THIS chrome surface (only) into the
        // per-workspace --surface-tint wash. Other `bg-sidebar` surfaces
        // (EditorTab, browser TabStrip/recents, right-rail) stay untinted.
        'relative flex shrink-0 flex-col bg-sidebar sl-chrome-tint text-sidebar-foreground sl-glass-heavy',
        // Collapsed state retains the border-r since no drag divider is rendered.
        // Expanded state: border-r lives on the drag divider div (see below).
        collapsed && 'border-r border-border w-14',
        // Suppress the CSS transition while dragging — it creates ~200ms lag
        // that makes the handle feel broken (HIGH-RISK drift note, v1.4.8).
        !isDraggingState && !collapsed && 'transition-[width] duration-200 ease-out',
      )}
      style={collapsed ? undefined : { width: sidebarWidth }}
    >
      {PLATFORM_IS_MAC ? (
        <div
          className="h-8 shrink-0 border-b border-border bg-sidebar"
          style={dragStyle()}
          aria-hidden
        />
      ) : null}
      <div
        className={cn(
          'flex h-12 items-center gap-2 border-b border-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
        style={dragStyle()}
      >
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-primary rounded transition hover:opacity-80"
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          style={noDragStyle()}
        >
          <Monogram size={collapsed ? 22 : 24} />
        </button>
        {collapsed ? null : (
          <div className="flex-1 text-[13px] font-semibold uppercase tracking-[0.18em]">
            SigmaLink
          </div>
        )}
        {collapsed ? null : (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            style={noDragStyle()}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* V3 SigmaMind: pure workspaces panel — no room nav, no palette card. */}
      {!collapsed ? (
        <WorkspacesPanel
          workspaces={openWorkspaces}
          persistedWorkspaces={workspaces}
          sessions={sessions}
          activeId={activeWorkspace?.id ?? null}
          onPick={(ws) => {
            dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
          }}
          onClose={(workspaceId) => dispatch({ type: 'WORKSPACE_CLOSE', workspaceId })}
          onDetach={
            isMainWindow()
              ? (workspaceId) => {
                  void rpc.windows
                    .detachWorkspace({ workspaceId })
                    .catch(() => undefined);
                }
              : undefined
          }
          onOpenPersisted={openPersistedWorkspace}
          onOpenDev={() => void openDevWorkspaceFlow()}
          devWorkspaceId={devWorkspaceId}
          onBrowseWorkspaces={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}
          onReorder={(orderedIds) =>
            dispatch({ type: 'REORDER_OPEN_WORKSPACES', orderedIds })
          }
          attentionWorkspaces={attentionWorkspaces}
          onRename={async (workspaceId, newName) => {
            // DEV-W2 — optimistic update first so the UI is instant.
            dispatch({ type: 'RENAME_WORKSPACE', id: workspaceId, name: newName });
            try {
              await rpc.workspaces.rename({ id: workspaceId, name: newName });
            } catch (err) {
              // On failure, reload the full list so the UI reverts to the DB
              // value rather than keeping a stale optimistic name.
              console.error('[WorkspacesPanel] rename failed:', err);
              try {
                dispatch({ type: 'SET_WORKSPACES', workspaces: await rpc.workspaces.list() });
              } catch {
                /* best-effort */
              }
            }
          }}
        />
      ) : (
        // Collapsed rail leaves a flex spacer so the footer expand button
        // pins to the bottom. The workspaces themselves disappear with the
        // panel; the user expands the sidebar to address them.
        <div className="flex-1" aria-hidden />
      )}

      <div className={cn('border-t border-border', collapsed ? 'p-2' : 'p-3 text-xs')}>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex h-8 w-full items-center justify-center rounded text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : activeWorkspace ? (
          // Footer "active workspace" readout. The bare `.sl-nav-active` fill was
          // a hard-edged, edge-to-edge square — on glass themes its translucent
          // `--primary` wash read as an oversaturated rectangle butting the rounded
          // sidebar wall (looked unnatural). Round + pad it into a real card; a
          // faint neutral `bg-sidebar-accent` gives flat themes (where
          // `.sl-nav-active` paints nothing) the same inset card, and on glass the
          // themed `.sl-nav-active` rule overrides the fill with its accent wash.
          <div className="sl-nav-active rounded-lg bg-sidebar-accent/40 px-2.5 py-2">
            <div className="font-medium text-sidebar-foreground">{activeWorkspace.name}</div>
            <div className="truncate text-muted-foreground" title={activeWorkspace.rootPath}>
              {activeWorkspace.rootPath}
            </div>
            <div className="mt-1 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {activeWorkspace.repoMode === 'git' ? 'Git repo' : 'Plain folder'}
              </div>
              {activeWorkspace.repoMode === 'git' ? (
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'SET_ROOM', room: 'git' })}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  title="Open Git panel"
                  data-testid="sidebar-git-button"
                >
                  <GitBranch className="h-3 w-3" />
                  Git
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground">No workspace open.</div>
        )}
      </div>
    </aside>
    {/* v1.4.8 packet-02 — drag divider, shown only in expanded state.
        The border-r separating the sidebar from main content lives here so
        it doesn't shift when the aside width changes. */}
    {!collapsed ? (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        data-testid="sidebar-resize-handle"
        className="w-1 shrink-0 cursor-col-resize border-r border-border hover:bg-accent active:bg-accent/70"
        onPointerDown={startSidebarDrag}
        onDoubleClick={() => {
          setSidebarWidth(APP_SIDEBAR_DEFAULT);
          persistWidth(APP_SIDEBAR_DEFAULT);
        }}
      />
    ) : null}
    {/* SigmaLink Dev — terminal-count dialog (portal; placement is cosmetic). */}
    <DevWorkspaceDialog
      open={devDialogOpen}
      onOpenChange={setDevDialogOpen}
      onLaunch={(n) => void launchDevTerminals(n)}
      launching={devLaunching}
    />
    </>
  );
}
