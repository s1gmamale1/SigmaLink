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
import type { Workspace } from '@/shared/types';
import { WorkspacesPanel } from './WorkspacesPanel';

const COLLAPSE_BREAKPOINT_PX = 1100;

const APP_SIDEBAR_DEFAULT = 240;
const APP_SIDEBAR_MIN = 180;
const APP_SIDEBAR_MAX = 480;
const APP_SIDEBAR_KV_KEY = 'app.sidebar.width';

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

  // v1.4.8 packet-02 — stateful expanded width with kv persistence.
  const [sidebarWidth, setSidebarWidth] = useState<number>(APP_SIDEBAR_DEFAULT);
  // Track dragging with a ref (not state) to avoid spurious re-renders in the
  // hot pointermove path. A React state boolean is used for the transition
  // suppression since it needs to affect the className.
  const [isDraggingState, setIsDraggingState] = useState(false);
  const isDragging = useRef(false);
  const rafHandle = useRef<number | null>(null);

  useEffect(() => {
    void rpc.kv.get(APP_SIDEBAR_KV_KEY).then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= APP_SIDEBAR_MIN && n <= APP_SIDEBAR_MAX) {
        setSidebarWidth(n);
      }
    });
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
        // Persist the final committed width to kv.
        void rpc.kv.set(APP_SIDEBAR_KV_KEY, String(committed));
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [sidebarWidth],
  );

  // Auto-collapse on narrow windows. The user can still toggle manually; the
  // resize listener only forces collapse when the viewport actually crosses
  // below the breakpoint (it does not re-expand the sidebar on widening so
  // the user's explicit choice on a wide monitor wins).
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      if (w < COLLAPSE_BREAKPOINT_PX && !collapsed) {
        dispatch({ type: 'SET_SIDEBAR_COLLAPSED', collapsed: true });
      }
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed, dispatch]);

  function setCollapsed(next: boolean) {
    dispatch({ type: 'SET_SIDEBAR_COLLAPSED', collapsed: next });
    void rpc.kv.set('app.sidebar.collapsed', next ? '1' : '0').catch(() => undefined);
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
      const sessions = await rpc.panes.listForWorkspace(reopened.id);
      if (sessions.length > 0) {
        dispatch({ type: 'ADD_SESSIONS', sessions });
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
      className={cn(
        'flex shrink-0 flex-col bg-sidebar text-sidebar-foreground',
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
          className="h-7 shrink-0 border-b border-border bg-sidebar"
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
          <div>
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
          void rpc.kv.set(APP_SIDEBAR_KV_KEY, String(APP_SIDEBAR_DEFAULT));
        }}
      />
    ) : null}
    </>
  );
}
