// SigmaLink sidebar. Phase 7 polish: a Σ monogram + uppercase wordmark in the
// header, an explicit collapse toggle (mirrored to kv['app.sidebar.collapsed']),
// auto-collapse below 1100px width, and Radix tooltips on collapsed items so
// the user still sees the room name on hover.

import { useEffect, type CSSProperties } from 'react';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Command as CommandIcon,
  Folder,
  GitBranch,
  Globe,
  LayoutGrid,
  Network,
  Settings,
  Sparkles,
  Terminal,
  Wand2,
} from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Monogram } from '@/renderer/components/Monogram';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState, type RoomId } from '@/renderer/app/state';
import { MOD_KEY_LABEL, PLATFORM_IS_MAC } from '@/renderer/lib/shortcuts';
import type { AgentSession, Workspace } from '@/shared/types';

interface NavItem {
  id: RoomId;
  label: string;
  icon: typeof Folder;
}

const ITEMS: NavItem[] = [
  { id: 'workspaces', label: 'Workspaces', icon: Folder },
  { id: 'command', label: 'Command Room', icon: Terminal },
  { id: 'swarm', label: 'Swarm Room', icon: Network },
  // P3-S2 — Operator Console is the swarm-scoped supervisor view (constellation
  // graph + activity feed). Requires an active workspace; renders a friendly
  // empty-state when no swarm exists yet.
  { id: 'operator', label: 'Operator Console', icon: Network },
  { id: 'review', label: 'Review Room', icon: GitBranch },
  // BUG-W7-009: Was `ListChecks` whose checkmark glyph rendered visually lighter
  // than its peers. `LayoutGrid` shares the simple-square stroke profile of
  // `Folder`/`Globe`/`Settings` so the row reads in rhythm with the rest.
  { id: 'tasks', label: 'Tasks', icon: LayoutGrid },
  { id: 'memory', label: 'Memory', icon: Sparkles },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'skills', label: 'Skills', icon: Wand2 },
  // V3-W13-012 — Bridge Assistant standalone room (fallback when the
  // right-rail is gated off; otherwise lives in the right-rail tab).
  { id: 'bridge', label: 'Bridge Assistant', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const COLLAPSE_BREAKPOINT_PX = 1100;

export function Sidebar() {
  const { state, dispatch } = useAppState();
  const activeWorkspace = state.activeWorkspace;
  const collapsed = state.sidebarCollapsed;

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

  function openPalette() {
    dispatch({ type: 'SET_COMMAND_PALETTE', open: true });
  }

  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        {PLATFORM_IS_MAC ? (
          <div
            className="h-7 shrink-0 border-b border-border bg-sidebar"
            style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            aria-hidden
          />
        ) : null}
        <div
          className={cn(
            'flex h-12 items-center gap-2 border-b border-border',
            collapsed ? 'justify-center px-2' : 'px-4',
          )}
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
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Command palette launcher */}
        <button
          type="button"
          onClick={openPalette}
          className={cn(
            'group mx-2 mt-2 flex items-center gap-2 rounded-md border border-border/60 bg-card/40 text-xs text-muted-foreground transition hover:bg-card hover:text-foreground',
            collapsed ? 'justify-center px-0 py-2' : 'px-2 py-1.5',
          )}
          title="Command palette"
        >
          <CommandIcon className="h-3.5 w-3.5" />
          {collapsed ? null : (
            <>
              <span className="flex-1 text-left">Command palette</span>
              <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {MOD_KEY_LABEL}+K
              </span>
            </>
          )}
        </button>

        <nav className={cn('flex-1 overflow-y-auto', collapsed ? 'px-1.5 py-2' : 'p-2')}>
          {ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = state.room === item.id;
            const disabled =
              item.id !== 'workspaces' &&
              item.id !== 'settings' &&
              item.id !== 'skills' &&
              item.id !== 'bridge' &&
              !activeWorkspace;
            // BUG-W7-002 / W7-013: when disabled, skip from the focus order and
            // dim the row with `cursor-not-allowed`. The tooltip explains why.
            const tooltipLabel = disabled
              ? `${item.label} — Open a workspace to enable`
              : item.label;
            const button = (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                tabIndex={disabled ? -1 : 0}
                aria-disabled={disabled || undefined}
                onClick={() => dispatch({ type: 'SET_ROOM', room: item.id })}
                className={cn(
                  'group relative flex w-full items-center rounded-md text-sm transition',
                  collapsed ? 'h-9 justify-center' : 'gap-2 px-2 py-1.5',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                  disabled &&
                    'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:ring-0',
                )}
                aria-label={item.label}
                title={disabled ? 'Open a workspace to enable' : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {collapsed ? null : <span className="flex-1 text-left">{item.label}</span>}
              </button>
            );
            // Always wrap in a tooltip so users get the disabled rationale —
            // not only the collapsed state. Radix Tooltip works on disabled
            // buttons because they're rendered in a wrapper.
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  {disabled ? (
                    <span className="block w-full">{button}</span>
                  ) : (
                    button
                  )}
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {tooltipLabel}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* V3-W12-008: workspace tabs with status dot + agent-count pill.
            Hidden when collapsed to keep the rail at 56px width. */}
        {!collapsed && state.workspaces.length > 0 ? (
          <WorkspaceTabs
            workspaces={state.workspaces}
            sessions={state.sessions}
            activeId={activeWorkspace?.id ?? null}
            onPick={(ws) => dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: ws })}
          />
        ) : null}

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
    </TooltipProvider>
  );
}

// V3-W12-008: per-workspace tab rendering. The status dot rolls up the
// statuses of every live session in that workspace into a single colour
// (running=green, error=amber, exited=grey). The pill counts running
// sessions only — exited sessions are exempted so the user does not get
// an inflated number when sessions auto-clear.
interface WorkspaceTabsProps {
  workspaces: Workspace[];
  sessions: AgentSession[];
  activeId: string | null;
  onPick: (ws: Workspace) => void;
}

function WorkspaceTabs({ workspaces, sessions, activeId, onPick }: WorkspaceTabsProps) {
  // Project sessions onto the workspace id so each tab can compute its own
  // counters in O(1). Memoised because the sidebar re-renders on every
  // dispatch and bucketing 100 sessions × N workspaces is wasteful.
  const byWorkspace = useMemo(() => {
    const map = new Map<string, AgentSession[]>();
    for (const s of sessions) {
      const list = map.get(s.workspaceId) ?? [];
      list.push(s);
      map.set(s.workspaceId, list);
    }
    return map;
  }, [sessions]);

  // Cap to the most recently opened 6 — anything further makes the rail
  // scroll, which we already do in the nav above.
  const top = workspaces.slice(0, 6);

  return (
    <div className="flex flex-col gap-0.5 border-t border-border px-2 py-2">
      <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Workspaces
      </div>
      {top.map((ws) => {
        const sessionsForWs = byWorkspace.get(ws.id) ?? [];
        const running = sessionsForWs.filter((s) => s.status === 'running').length;
        const hasError = sessionsForWs.some((s) => s.status === 'error');
        const hasRunning = running > 0;
        const dotClass = hasError
          ? 'bg-amber-500'
          : hasRunning
            ? 'bg-emerald-500'
            : 'bg-zinc-500';
        const isActive = ws.id === activeId;
        return (
          <button
            key={ws.id}
            type="button"
            onClick={() => onPick(ws)}
            className={cn(
              'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition',
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
            )}
            title={ws.rootPath}
          >
            <span
              aria-hidden
              className={cn('inline-block h-2 w-2 shrink-0 rounded-full', dotClass)}
            />
            <span className="flex-1 truncate text-left text-[13px]">{ws.name}</span>
            <span
              className={cn(
                'rounded-full px-1.5 py-0 text-[10px] font-mono tabular-nums',
                hasRunning
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-muted/50 text-muted-foreground',
              )}
              aria-label={`${running} running ${running === 1 ? 'agent' : 'agents'}`}
            >
              {running}
            </span>
          </button>
        );
      })}
    </div>
  );
}
