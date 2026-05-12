// SigmaLink sidebar — V3 BridgeMind layout.
// The rail is now a pure workspaces panel. The 12-item room nav moved to a
// top-bar dropdown (Step 2). The Cmd+K command-palette card was dropped
// from the rail too — the keyboard shortcut still works app-wide. Header
// keeps the Σ monogram + wordmark + collapse chevron; the footer still
// shows the active-workspace summary so users can see at a glance which
// repo they're operating on.

import { useEffect } from 'react';
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
    } catch (err) {
      console.error('Failed to open workspace:', err);
    }
  }

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out',
        collapsed ? 'w-14' : 'w-60',
      )}
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

      {/* V3 BridgeMind: pure workspaces panel — no room nav, no palette card. */}
      {!collapsed ? (
        <WorkspacesPanel
          workspaces={openWorkspaces}
          persistedWorkspaces={workspaces}
          sessions={sessions}
          activeId={activeWorkspace?.id ?? null}
          onPick={(ws) => dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id })}
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
  );
}
