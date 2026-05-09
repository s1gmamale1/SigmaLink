// SigmaLink sidebar. Phase 7 polish: a Σ monogram + uppercase wordmark in the
// header, an explicit collapse toggle (mirrored to kv['app.sidebar.collapsed']),
// auto-collapse below 1100px width, and Radix tooltips on collapsed items so
// the user still sees the room name on hover.

import { useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Command as CommandIcon,
  Folder,
  GitBranch,
  Globe,
  ListChecks,
  Network,
  Settings,
  Sparkles,
  Terminal,
  Wand2,
} from 'lucide-react';
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
import { MOD_KEY_LABEL } from '@/renderer/lib/shortcuts';

interface NavItem {
  id: RoomId;
  label: string;
  icon: typeof Folder;
}

const ITEMS: NavItem[] = [
  { id: 'workspaces', label: 'Workspaces', icon: Folder },
  { id: 'command', label: 'Command Room', icon: Terminal },
  { id: 'swarm', label: 'Swarm Room', icon: Network },
  { id: 'review', label: 'Review Room', icon: GitBranch },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'memory', label: 'Memory', icon: Sparkles },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'skills', label: 'Skills', icon: Wand2 },
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
              !activeWorkspace;
            const button = (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                onClick={() => dispatch({ type: 'SET_ROOM', room: item.id })}
                className={cn(
                  'group relative flex w-full items-center rounded-md text-sm transition',
                  collapsed ? 'h-9 justify-center' : 'gap-2 px-2 py-1.5',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                  disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                )}
                aria-label={item.label}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {collapsed ? null : <span className="flex-1 text-left">{item.label}</span>}
              </button>
            );
            if (!collapsed) return button;
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

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
