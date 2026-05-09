import {
  Boxes,
  Folder,
  GitBranch,
  Globe,
  Network,
  Settings,
  Sparkles,
  Terminal,
  Wand2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppState, type RoomId } from '@/renderer/app/state';

interface NavItem {
  id: RoomId;
  label: string;
  icon: typeof Folder;
  hint?: string;
  phase?: number;
}

const ITEMS: NavItem[] = [
  { id: 'workspaces', label: 'Workspaces', icon: Folder },
  { id: 'command', label: 'Command Room', icon: Terminal },
  { id: 'swarm', label: 'Swarm Room', icon: Network },
  { id: 'review', label: 'Review Room', icon: GitBranch, phase: 4 },
  { id: 'memory', label: 'Memory', icon: Sparkles },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'skills', label: 'Skills', icon: Wand2 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const { state, dispatch } = useAppState();
  const activeWorkspace = state.activeWorkspace;
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <Boxes className="h-5 w-5 text-primary" />
        <div className="text-sm font-semibold tracking-wide">SigmaLink</div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = state.room === item.id;
          const disabled =
            (item.id !== 'workspaces' &&
              item.id !== 'settings' &&
              item.id !== 'skills' &&
              !activeWorkspace) ||
            !!item.phase;
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => dispatch({ type: 'SET_ROOM', room: item.id })}
              className={cn(
                'group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.phase ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  P{item.phase}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <div className="border-t border-border p-3 text-xs">
        {activeWorkspace ? (
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
