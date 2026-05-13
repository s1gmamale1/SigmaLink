// V3 BridgeMind sidebar — pure workspaces panel.
// Lifted out of `Sidebar.tsx` so the rail can host *just* workspaces now that
// room navigation moved to a top-bar dropdown (Step 2). The header exposes
// the open-workspace picker behind two equivalent affordances (`+` and a
// chevron) per the V3 mockup. The body is a single scrollable list — no
// 8-tab cap, no overflow drawer — so every open workspace is reachable
// without an extra menu.
//
// Status semantics are preserved from the previous `WorkspaceTabs`:
//   • dot ring = rollup of session statuses (running > error > idle)
//   • pane-count pill counts *running* sessions only
//   • close × surfaces on hover for every row
//
// The colour dot itself is derived from the workspace id via
// `workspaceColor()` so users get a stable visual cue per project without us
// needing to add a `color` column to the Workspace record.

import { useMemo } from 'react';
import { ChevronDown, Folder, FolderPlus, Plus, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { workspaceColor } from '@/renderer/lib/workspace-color';
import type { AgentSession, Workspace } from '@/shared/types';
import { summarizeWorkspaces, type WorkspaceStatusKind } from './workspaces-summary';

export interface WorkspacesPanelProps {
  workspaces: Workspace[];
  persistedWorkspaces: Workspace[];
  sessions: AgentSession[];
  activeId: string | null;
  onPick: (ws: Workspace) => void;
  onClose: (workspaceId: string) => void;
  onOpenPersisted: (ws: Workspace) => void;
  onBrowseWorkspaces: () => void;
}

const STATUS_RING: Record<WorkspaceStatusKind, string> = {
  running: 'ring-emerald-500',
  error: 'ring-amber-500',
  idle: 'ring-zinc-600',
};

// Tiny basename helper — avoids pulling `path` into the renderer bundle.
// Handles both POSIX (`/`) and Windows (`\`) separators and strips trailing
// slashes so `/Users/me/projects/sigmalink/` still yields `sigmalink`.
function basenameOf(rootPath: string | null | undefined): string {
  if (!rootPath) return '';
  const trimmed = rootPath.replace(/[\\/]+$/, '');
  const match = trimmed.match(/[^\\/]+$/);
  return match ? match[0] : trimmed;
}

export function WorkspacesPanel({
  workspaces,
  persistedWorkspaces,
  sessions,
  activeId,
  onPick,
  onClose,
  onOpenPersisted,
  onBrowseWorkspaces,
}: WorkspacesPanelProps) {
  // O(N) projection of sessions onto their workspace. Memoised because the
  // sidebar re-renders on every dispatch and we'd otherwise rebucket a few
  // dozen sessions × every render.
  const byWorkspace = useMemo(() => summarizeWorkspaces(sessions), [sessions]);
  const openIds = useMemo(() => new Set(workspaces.map((w) => w.id)), [workspaces]);
  const persistedClosed = useMemo(
    () => persistedWorkspaces.filter((w) => !openIds.has(w.id)),
    [openIds, persistedWorkspaces],
  );

  const pickerMenu = (
    <DropdownMenuContent side="right" align="start" className="w-72">
      <DropdownMenuLabel>Open Workspace</DropdownMenuLabel>
      {persistedClosed.length > 0 ? (
        persistedClosed.map((ws) => (
          <DropdownMenuItem key={ws.id} onClick={() => onOpenPersisted(ws)}>
            <Folder className="h-4 w-4" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{ws.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{ws.rootPath}</span>
            </span>
          </DropdownMenuItem>
        ))
      ) : (
        <DropdownMenuItem onClick={onBrowseWorkspaces}>
          <Folder className="h-4 w-4" />
          <span>Browse workspaces</span>
        </DropdownMenuItem>
      )}
      {persistedClosed.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onBrowseWorkspaces}>
            <Folder className="h-4 w-4" />
            <span>Browse all</span>
          </DropdownMenuItem>
        </>
      ) : null}
    </DropdownMenuContent>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-0.5 border-t border-border px-2 py-2"
      data-testid="workspaces-panel"
    >
      <div className="flex items-center gap-1 px-1 pb-1">
        <div className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Workspaces
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
              aria-label="Open workspace"
              title="Open workspace"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          {pickerMenu}
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-foreground"
              aria-label="Workspace menu"
              title="Workspace menu"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          {pickerMenu}
        </DropdownMenu>
      </div>
      <div
        className="flex-1 overflow-y-auto"
        data-testid="workspaces-list"
      >
        {workspaces.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center"
            data-testid="workspaces-empty"
            role="status"
            aria-live="polite"
          >
            <div className="grid h-9 w-9 place-items-center rounded-full border border-border bg-muted/30">
              <Folder className="h-4 w-4 text-muted-foreground" aria-hidden />
            </div>
            <div className="text-[12px] font-medium text-foreground">No workspaces yet</div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  aria-label="Open workspace"
                  data-testid="workspaces-empty-cta"
                >
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden />
                  Open workspace
                </button>
              </DropdownMenuTrigger>
              {pickerMenu}
            </DropdownMenu>
          </div>
        ) : (
          workspaces.map((ws) => {
            const status = byWorkspace.get(ws.id) ?? {
              running: 0,
              kind: 'idle' as WorkspaceStatusKind,
            };
            const isActive = ws.id === activeId;
            const colour = workspaceColor(ws.id);
            // Fall back to a deterministic placeholder when the workspace
            // record has no name set — without this, rows can render as a
            // single dot + count badge with no readable label, which looks
            // like an empty sidebar to the user (v1.2.5 regression report).
            const displayName = ws.name?.trim() ? ws.name : 'Untitled workspace';
            // Subtitle = basename of the root path. Tolerates trailing slash.
            const subtitle = basenameOf(ws.rootPath);
            return (
              <div
                key={ws.id}
                data-testid="workspace-row"
                data-workspace-id={ws.id}
                data-active={isActive ? 'true' : undefined}
                className={cn(
                  'group flex min-h-9 items-center rounded-md text-sm transition',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <button
                  type="button"
                  onClick={() => onPick(ws)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
                  title={ws.rootPath}
                >
                  <span
                    aria-hidden
                    data-testid="workspace-dot"
                    data-status={status.kind}
                    className={cn(
                      'inline-block h-2 w-2 shrink-0 rounded-full ring-1',
                      colour,
                      STATUS_RING[status.kind],
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col text-left">
                    <span
                      data-testid="workspace-name"
                      className="truncate text-[13px] leading-tight"
                    >
                      {displayName}
                    </span>
                    {subtitle && subtitle !== displayName ? (
                      <span
                        data-testid="workspace-subtitle"
                        className="truncate text-[10px] leading-tight text-muted-foreground/80"
                      >
                        {subtitle}
                      </span>
                    ) : null}
                  </span>
                  <span
                    data-testid="workspace-pane-count"
                    className={cn(
                      'rounded-full px-1.5 py-0 text-[10px] font-mono tabular-nums',
                      status.running > 0
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-muted/50 text-muted-foreground',
                    )}
                    aria-label={`${status.running} running ${status.running === 1 ? 'agent' : 'agents'}`}
                  >
                    {status.running}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(ws.id);
                  }}
                  className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                  aria-label={`Close ${displayName}`}
                  title="Close workspace"
                  data-testid="workspace-close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
