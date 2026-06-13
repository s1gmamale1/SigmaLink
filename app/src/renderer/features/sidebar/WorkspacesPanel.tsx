// V3 SigmaMind sidebar — pure workspaces panel.
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
// The colour dot is driven by `useWorkspaceColors` — a KV-persisted per-workspace
// hex chosen from a 15-slot palette. Users can right-click to change their workspace
// colour via a swatch picker (context menu). No `color` column needed in the DB.

import { useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AppWindow,
  Check,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderPlus,
  Plus,
  RotateCcw,
  Terminal,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import {
  defaultWorkspaceColor,
  WORKSPACE_DOT_HEX_PALETTE,
  WORKSPACE_DOT_COLOR_NAMES,
} from '@/renderer/lib/workspace-color';
import type { AgentSession, Workspace } from '@/shared/types';
import { summarizeWorkspaces, type WorkspaceStatusKind } from './workspaces-summary';
import { useWorkspaceColors } from './use-workspace-colors';

export interface WorkspacesPanelProps {
  workspaces: Workspace[];
  persistedWorkspaces: Workspace[];
  sessions: AgentSession[];
  activeId: string | null;
  onPick: (ws: Workspace) => void;
  onClose: (workspaceId: string) => void;
  onOpenPersisted: (ws: Workspace) => void;
  onBrowseWorkspaces: () => void;
  /** DEV-W2 — called when the user commits an inline rename. */
  onRename?: (workspaceId: string, newName: string) => Promise<void>;
  /**
   * Called with the full new ordered id list when the user drags a workspace
   * row to a new position (or uses the Move up/down context-menu items). When
   * omitted, drag-to-reorder is disabled.
   */
  onReorder?: (orderedIds: string[]) => void;
  /**
   * SigmaLink Dev (Phase 14) — called when the user picks the "SigmaLink Dev"
   * item from the open-workspace menu. Opens (or creates) the singleton plain-
   * terminal dev workspace at ~.
   */
  onOpenDev?: () => void;
  /**
   * SigmaLink Dev — id of the singleton dev workspace (from the KV pointer), or
   * null when it hasn't been created yet. Used to render the DEV badge + `~`
   * subtitle on its row.
   */
  devWorkspaceId?: string | null;
  /**
   * Multi-window B5 — called when the user clicks "Open in new window" on an
   * open-workspace row. Rendered only in the main window (scoped windows have
   * no sidebar to show this action from). When omitted the button is hidden.
   */
  onDetach?: (workspaceId: string) => void;
  /** Agent-attention: workspaceId → ts. A row glows while its id is present. */
  attentionWorkspaces?: Record<string, number>;
}

// Drag mime distinct from the skills DnD mime so the workspace-header skill
// drop target never mistakes a row drag for a skill drag.
const WORKSPACE_REORDER_MIME = 'application/x-sigma-workspace-reorder';

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
  onRename,
  onReorder,
  onOpenDev,
  devWorkspaceId,
  onDetach,
  attentionWorkspaces = {},
}: WorkspacesPanelProps) {
  // DEV-W2 — inline rename state. `editingId` is the workspace being renamed;
  // `editValue` mirrors the input value.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Drag-to-reorder state. `draggingId` is the row being dragged; `dropIndex`
  // is the insertion gap (0..N) the drop would land in, computed across the
  // WHOLE list from the pointer's Y — so a drop sticks to any slot, not just
  // the end. Container-level (not per-row) so the gap between rows and the
  // empty area below the last row are all valid drop targets.
  const reorderEnabled = Boolean(onReorder);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function clearDrag() {
    setDraggingId(null);
    setDropIndex(null);
  }

  // Map a pointer Y to an insertion index: the first row whose vertical midpoint
  // is below the pointer, else the end (append). Rows are read from the live DOM
  // so the math matches what the user sees regardless of scroll.
  function insertionIndexFromPointer(listEl: HTMLElement, clientY: number): number {
    const rows = Array.from(
      listEl.querySelectorAll<HTMLElement>('[data-workspace-id]'),
    );
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i]!.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length;
  }

  // Apply an insertion index: remove the dragged id, reinsert it at the gap
  // (adjusting for its own removal when it sat before the gap), dispatch if the
  // order actually changed.
  function commitReorderToIndex(insertIndex: number) {
    if (!onReorder || !draggingId) return;
    const ids = workspaces.map((w) => w.id);
    const from = ids.indexOf(draggingId);
    if (from === -1) return;
    let target = insertIndex;
    if (from < target) target -= 1;
    const without = ids.filter((id) => id !== draggingId);
    target = Math.max(0, Math.min(target, without.length));
    without.splice(target, 0, draggingId);
    if (without.every((id, i) => id === ids[i])) return; // no-op
    onReorder(without);
  }

  // Context-menu fallback (keyboard-accessible): shift a workspace one slot.
  function moveBy(workspaceId: string, delta: -1 | 1) {
    if (!onReorder) return;
    const ids = workspaces.map((w) => w.id);
    const from = ids.indexOf(workspaceId);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onReorder(next);
  }

  function handleRowDragStart(e: DragEvent<HTMLDivElement>, ws: Workspace) {
    if (!reorderEnabled) return;
    setDraggingId(ws.id);
    e.dataTransfer.effectAllowed = 'move';
    // Set data so Firefox/Electron actually initiates the drag.
    try {
      e.dataTransfer.setData(WORKSPACE_REORDER_MIME, ws.id);
      e.dataTransfer.setData('text/plain', ws.id);
    } catch {
      /* setData can throw in odd DnD states — drag still works via state */
    }
  }

  function handleListDragOver(e: DragEvent<HTMLDivElement>) {
    if (!reorderEnabled || !draggingId) return;
    e.preventDefault(); // mark the whole list as a valid drop target
    e.dataTransfer.dropEffect = 'move';
    const next = insertionIndexFromPointer(e.currentTarget, e.clientY);
    if (next !== dropIndex) setDropIndex(next);
  }

  function handleListDrop(e: DragEvent<HTMLDivElement>) {
    if (!reorderEnabled || !draggingId) return;
    e.preventDefault();
    const insertIndex = insertionIndexFromPointer(e.currentTarget, e.clientY);
    commitReorderToIndex(insertIndex);
    clearDrag();
  }

  function handleListDragLeave(e: DragEvent<HTMLDivElement>) {
    // Clear the indicator only when the pointer leaves the list entirely.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropIndex(null);
    }
  }
  // DEV-W2 — start editing a workspace name.
  function startEdit(ws: Workspace) {
    setEditingId(ws.id);
    setEditValue(ws.name?.trim() || '');
    // Focus runs after React flushes the render that shows the input.
    setTimeout(() => inputRef.current?.select(), 0);
  }

  // Commit the rename; cancel silently on empty input (don't submit garbage).
  function commitEdit(wsId: string) {
    const trimmed = editValue.trim();
    if (trimmed && onRename) {
      void onRename(wsId, trimmed).catch(() => {
        // Revert optimistic update on error — the parent is responsible for
        // rolling back (or the user will see the DB name on next list refresh).
      });
    }
    setEditingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  // Per-workspace hex colours (KV-persisted, user-overridable).
  const openWorkspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  const { colorFor, setColor } = useWorkspaceColors(openWorkspaceIds);

  // O(N) projection of sessions onto their workspace. Memoised because the
  // sidebar re-renders on every dispatch and we'd otherwise rebucket a few
  // dozen sessions × every render.
  const byWorkspace = useMemo(() => summarizeWorkspaces(sessions), [sessions]);
  const openIds = useMemo(() => new Set(workspaces.map((w) => w.id)), [workspaces]);
  // SigmaLink Dev (2026-06-11) — exclude the dev singleton from persistedClosed
  // so it never appears as a generic "reopen" entry in the + menu. The dedicated
  // "SigmaLink Dev" menu item (onOpenDev) is the sole reopen affordance for it.
  const persistedClosed = useMemo(
    () =>
      persistedWorkspaces.filter(
        (w) => !openIds.has(w.id) && w.id !== devWorkspaceId,
      ),
    [openIds, persistedWorkspaces, devWorkspaceId],
  );

  const pickerMenu = (
    <DropdownMenuContent side="right" align="start" className="w-72">
      <DropdownMenuLabel>Open Workspace</DropdownMenuLabel>
      <DropdownMenuItem onClick={() => onOpenDev?.()}>
        <Terminal className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">SigmaLink Dev</span>
          <span className="block truncate text-xs text-muted-foreground">Plain terminals at ~</span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
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
              aria-label="Add or open workspace"
              title="Add or open workspace"
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
        onDragOver={reorderEnabled ? handleListDragOver : undefined}
        onDrop={reorderEnabled ? handleListDrop : undefined}
        onDragLeave={reorderEnabled ? handleListDragLeave : undefined}
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
          workspaces.map((ws, wsIndex) => {
            const status = byWorkspace.get(ws.id) ?? {
              running: 0,
              kind: 'idle' as WorkspaceStatusKind,
            };
            const isActive = ws.id === activeId;
            const wsColor = colorFor(ws.id);
            const isDefault = wsColor === defaultWorkspaceColor(ws.id);
            // Fall back to a deterministic placeholder when the workspace
            // record has no name set — without this, rows can render as a
            // single dot + count badge with no readable label, which looks
            // like an empty sidebar to the user (v1.2.5 regression report).
            const displayName = ws.name?.trim() ? ws.name : 'Untitled workspace';
            // SigmaLink Dev — the singleton dev workspace lives at ~; show a
            // literal `~` subtitle (its rootPath basename is the homedir name,
            // which reads as noise) plus a DEV badge next to the name.
            const isDevWorkspace = devWorkspaceId != null && ws.id === devWorkspaceId;
            // Subtitle = basename of the root path. Tolerates trailing slash.
            const subtitle = isDevWorkspace ? '~' : basenameOf(ws.rootPath);

            // Subtle left-border row accent: full alpha on active, ~33% on inactive.
            const borderColor = isActive ? wsColor : `${wsColor}55`;

            const needsAttention = attentionWorkspaces[ws.id] !== undefined;
            const isDragging = draggingId === ws.id;
            // Insertion line: above this row when the gap == its index; below the
            // last row when the gap == list length (append). Hidden once the
            // drag ends (dropIndex === null).
            const showDropAbove = draggingId !== null && dropIndex === wsIndex;
            const showDropBelow =
              draggingId !== null &&
              dropIndex === workspaces.length &&
              wsIndex === workspaces.length - 1;
            const canDrag = reorderEnabled && editingId !== ws.id;

            return (
              <ContextMenu key={ws.id}>
                <ContextMenuTrigger asChild>
                  <div
                    data-testid="workspace-row"
                    data-workspace-id={ws.id}
                    data-active={isActive ? 'true' : undefined}
                    data-dragging={isDragging ? 'true' : undefined}
                    draggable={canDrag}
                    onDragStart={(e) => handleRowDragStart(e, ws)}
                    onDragEnd={clearDrag}
                    style={{ borderLeft: `2px solid ${borderColor}` }}
                    className={cn(
                      'group flex min-h-9 items-center rounded-md text-sm transition',
                      canDrag && 'cursor-grab active:cursor-grabbing',
                      isDragging && 'opacity-50',
                      showDropAbove && 'shadow-[inset_0_2px_0_0_hsl(var(--ring))]',
                      showDropBelow && 'shadow-[inset_0_-2px_0_0_hsl(var(--ring))]',
                      isActive
                        ? 'sl-nav-active bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                      needsAttention && 'sl-attention',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        // Don't trigger onPick while the rename input is active.
                        if (editingId !== ws.id) onPick(ws);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
                      title={ws.rootPath}
                    >
                      <span
                        aria-hidden
                        data-testid="workspace-dot"
                        data-status={status.kind}
                        style={{ backgroundColor: wsColor }}
                        className={cn(
                          'inline-block h-2 w-2 shrink-0 rounded-full ring-1',
                          STATUS_RING[status.kind],
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col text-left">
                        {editingId === ws.id ? (
                          <input
                            ref={inputRef}
                            data-testid="workspace-rename-input"
                            className="w-full truncate rounded bg-background px-1 text-[13px] leading-tight text-foreground ring-1 ring-accent outline-none"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitEdit(ws.id);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEdit();
                              }
                              // Prevent keyboard events from bubbling to the row's
                              // click/key handler while the input is active.
                              e.stopPropagation();
                            }}
                            onBlur={() => commitEdit(ws.id)}
                            // Stop click inside the input from bubbling up to the
                            // outer button (which would call onPick or close the editor).
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Rename workspace ${displayName}`}
                          />
                        ) : (
                          <span className="flex min-w-0 items-center">
                            <span
                              data-testid="workspace-name"
                              className="truncate text-[13px] leading-tight"
                              onDoubleClick={(e) => {
                                if (!onRename) return;
                                e.stopPropagation();
                                startEdit(ws);
                              }}
                              title="Double-click to rename"
                            >
                              {displayName}
                            </span>
                            {isDevWorkspace ? (
                              <span
                                data-testid="workspace-dev-badge"
                                className="ml-1 shrink-0 rounded bg-primary/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-primary"
                              >
                                dev
                              </span>
                            ) : null}
                          </span>
                        )}
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
                    {onDetach ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDetach(ws.id);
                        }}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Open ${displayName} in a new window`}
                        title="Open in new window"
                        data-testid="workspace-detach"
                      >
                        <AppWindow className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
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
                </ContextMenuTrigger>

                {/* Right-click menu — reorder (a11y fallback for drag) + colour */}
                <ContextMenuContent
                  className="w-auto min-w-[9rem]"
                  data-testid="workspace-color-menu"
                >
                  {reorderEnabled ? (
                    <>
                      <ContextMenuItem
                        disabled={wsIndex === 0}
                        onClick={() => moveBy(ws.id, -1)}
                        data-testid="workspace-move-up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                        Move up
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={wsIndex === workspaces.length - 1}
                        onClick={() => moveBy(ws.id, 1)}
                        data-testid="workspace-move-down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                        Move down
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  ) : null}
                  <ContextMenuLabel className="text-xs">Workspace colour</ContextMenuLabel>
                  <div className="grid grid-cols-5 gap-1 px-2 py-1.5">
                    {WORKSPACE_DOT_HEX_PALETTE.map((hex, i) => (
                      <button
                        key={hex}
                        type="button"
                        aria-label={`Set colour ${WORKSPACE_DOT_COLOR_NAMES[i] ?? hex}`}
                        aria-pressed={wsColor === hex}
                        data-testid={`color-swatch-${hex}`}
                        onClick={() => setColor(ws.id, hex)}
                        style={{ backgroundColor: hex }}
                        className={cn(
                          'h-5 w-5 rounded-full transition hover:scale-110',
                          wsColor === hex
                            ? 'ring-2 ring-white ring-offset-1 ring-offset-popover'
                            : '',
                        )}
                      >
                        {wsColor === hex ? (
                          <Check className="h-3 w-3 text-white/80 mx-auto" aria-hidden />
                        ) : null}
                      </button>
                    ))}
                  </div>
                  {!isDefault && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onClick={() => setColor(ws.id, null)}
                        data-testid="color-reset"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Reset to default colour
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
      </div>
    </div>
  );
}
