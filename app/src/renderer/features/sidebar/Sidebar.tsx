// SigmaLink sidebar — V3 SigmaMind layout.
// The rail is now a pure workspaces panel. The 12-item room nav moved to a
// top-bar dropdown (Step 2). The Cmd+K command-palette card was dropped
// from the rail too — the keyboard shortcut still works app-wide. Header
// keeps the Σ monogram + wordmark + collapse chevron; the footer still
// shows the active-workspace summary so users can see at a glance which
// repo they're operating on.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Monogram } from '@/renderer/components/Monogram';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { PLATFORM_IS_MAC } from '@/renderer/lib/shortcuts';
import { dragStyle, noDragStyle } from '@/renderer/lib/drag-region';
import { useBelowBreakpoint } from '@/renderer/lib/use-breakpoint';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import type { Workspace } from '@/shared/types';
import { WorkspacesPanel } from './WorkspacesPanel';

const APP_SIDEBAR_DEFAULT = 240;
const APP_SIDEBAR_MIN = 180;
const APP_SIDEBAR_MAX = 480;
// Legacy GLOBAL kv keys — read-through fallback so pre-RSP-1 widths/collapse
// state aren't lost on first run after the migration to per-workspace keying.
const APP_SIDEBAR_LEGACY_WIDTH_KEY = 'app.sidebar.width';
const APP_SIDEBAR_LEGACY_COLLAPSED_KEY = 'app.sidebar.collapsed';
// Per-workspace panel id (combined with the active workspace id into
// `ui.<wsId>.<panel>` by workspace-ui-kv). Only the WIDTH is per-workspace;
// collapse stays a global preference (see setCollapsed / session-restore).
const SIDEBAR_WIDTH_PANEL = 'sidebar.width';

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
  // RSP-1 — per-workspace width keying. When no workspace is open, `wsId` is
  // null and we fall back to the legacy global key (see read/write helpers).
  const wsId = activeWorkspace?.id ?? null;

  // v1.4.8 packet-02 — stateful expanded width with kv persistence.
  const [sidebarWidth, setSidebarWidth] = useState<number>(APP_SIDEBAR_DEFAULT);
  // Track dragging with a ref (not state) to avoid spurious re-renders in the
  // hot pointermove path. A React state boolean is used for the transition
  // suppression since it needs to affect the className.
  const [isDraggingState, setIsDraggingState] = useState(false);
  const isDragging = useRef(false);
  const rafHandle = useRef<number | null>(null);

  // RSP-1 — hydrate width from the per-workspace key (`ui.<wsId>.sidebar.width`)
  // with read-through fallback to the legacy global key. Re-runs when `wsId`
  // changes since a different workspace can persist a different width. When no
  // workspace is open we read the global key directly so we don't crash.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const v = wsId
        ? await readWorkspaceUi(wsId, SIDEBAR_WIDTH_PANEL, APP_SIDEBAR_LEGACY_WIDTH_KEY)
        : await rpc.kv.get(APP_SIDEBAR_LEGACY_WIDTH_KEY).catch(() => null);
      if (!alive) return;
      const n = Number(v);
      if (Number.isFinite(n) && n >= APP_SIDEBAR_MIN && n <= APP_SIDEBAR_MAX) {
        setSidebarWidth(n);
      } else {
        // A workspace with no persisted width falls back to the default so a
        // wide previous workspace doesn't bleed into a fresh one.
        setSidebarWidth(APP_SIDEBAR_DEFAULT);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wsId]);

  // Persist the sidebar width under the active workspace's key (or the legacy
  // global key when no workspace is open). Best-effort; layout is non-critical.
  const persistWidth = useCallback(
    (value: number) => {
      const str = String(value);
      if (wsId) {
        void writeWorkspaceUi(wsId, SIDEBAR_WIDTH_PANEL, str);
      } else {
        void rpc.kv.set(APP_SIDEBAR_LEGACY_WIDTH_KEY, str).catch(() => undefined);
      }
    },
    [wsId],
  );

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
    void rpc.kv.set(APP_SIDEBAR_LEGACY_COLLAPSED_KEY, next ? '1' : '0').catch(() => undefined);
  }

  async function openPersistedWorkspace(ws: Workspace) {
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

  return (
    <>
    <aside
      aria-label="Sidebar"
      className={cn(
        'relative flex shrink-0 flex-col bg-sidebar text-sidebar-foreground sl-glass-heavy',
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
        <span className="text-primary">
          <Monogram size={collapsed ? 22 : 24} />
        </span>
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
          onOpenPersisted={openPersistedWorkspace}
          onBrowseWorkspaces={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}
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
          <div className="sl-nav-active">
            <div className="font-medium text-sidebar-foreground">{activeWorkspace.name}</div>
            <div className="truncate text-muted-foreground" title={activeWorkspace.rootPath}>
              {activeWorkspace.rootPath}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {activeWorkspace.repoMode === 'git' ? 'Git repo' : 'Plain folder'}
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
        className="w-1 shrink-0 cursor-col-resize border-r border-border hover:bg-accent active:bg-accent/70"
        onPointerDown={startSidebarDrag}
        onDoubleClick={() => {
          setSidebarWidth(APP_SIDEBAR_DEFAULT);
          persistWidth(APP_SIDEBAR_DEFAULT);
        }}
      />
    ) : null}
    </>
  );
}
