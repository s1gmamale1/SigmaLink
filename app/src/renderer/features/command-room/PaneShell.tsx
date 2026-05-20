// v1.5.1-A — PaneShell extracted from CommandRoom.tsx.
//
// Renders a single pane cell: PaneHeader strip on top, then a drag-aware body
// (with ring-2 visual + 200 ms flash on drop) that hosts PaneSplash,
// SessionTerminal, and PaneFooter, plus the right-click ContextMenu.
//
// Previously this was the inline `PaneCell` function in CommandRoom.tsx.
// Extracted to keep CommandRoom.tsx under 500 LOC (v1.5.1-A caveat 1).

import { useState, type DragEvent } from 'react';
import { FolderOpen, Square, Terminal as TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { rpc } from '@/renderer/lib/rpc';
import { SessionTerminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import { PaneSplash } from './PaneSplash';
import { PaneFooter } from './PaneFooter';
import { insertMention } from './insertMention';
import { pathRelative } from '@/renderer/lib/path-relative';
import type { AgentSession } from '@/shared/types';

// v1.4.8 — Max number of files allowed in a single Finder multi-drop.
const MAX_DROP_FILES = 10;

export function PaneShell({
  session,
  paneIndex,
  providers,
  workspaceRootPath,
  onFocus,
  onRemove,
  onStop,
  onSplit,
  onToggleMinimise,
  isFullscreen,
  onToggleFullscreen,
  /**
   * v1.4.3 #06 — When the pane is in a split group, the Split-H/V icons are
   * disabled (max 2-level deep in v1.4.x). The CommandRoom passes this true
   * for sub-panes via `SplitGroupCell`. Defaults to false for the standalone
   * pane case.
   */
  inSplitGroup = false,
}: {
  session: AgentSession;
  paneIndex: number;
  providers: { id: string; name: string }[];
  /** v1.4.8 — workspace root used to compute relative paths for Finder drops. */
  workspaceRootPath: string;
  onFocus: () => void;
  onRemove: () => void;
  onStop: () => void;
  onSplit: (direction: 'horizontal' | 'vertical', providerId: string) => void;
  onToggleMinimise: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  inSplitGroup?: boolean;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [flashDrop, setFlashDrop] = useState(false);

  const errored = session.status === 'error';
  const exited = session.status === 'exited';
  const hasWorktree = !!session.worktreePath;

  // v1.4.8 — Accept drags from the IDE file-tree (custom MIME) or Finder (Files).
  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    const hasSigmaFile = e.dataTransfer.types.includes('application/sigmalink-file');
    const hasFiles = e.dataTransfer.types.includes('Files');
    if (hasSigmaFile || hasFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) setIsDragOver(true);
    }
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>): void {
    // Only clear when the pointer leaves the pane body entirely, not just a child.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setIsDragOver(false);
    setFlashDrop(true);
    setTimeout(() => setFlashDrop(false), 200);

    const sigmaRaw = e.dataTransfer.getData('application/sigmalink-file');
    if (sigmaRaw) {
      try {
        const payload = JSON.parse(sigmaRaw) as { absolutePath?: string; relativePath?: string };
        const path = payload.relativePath ?? payload.absolutePath ?? '';
        if (path) {
          void insertMention(session.id, path, session.status);
        }
      } catch {
        /* malformed payload — ignore */
      }
      return;
    }

    // Finder / external drop — use window.sigma.getPathForFile for each File.
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length > MAX_DROP_FILES) {
      toast.warning(`Dropping ${files.length} files — capped at ${MAX_DROP_FILES}`, {
        description: 'Only the first 10 files were inserted.',
      });
    }
    const capped = files.slice(0, MAX_DROP_FILES);
    const paths: string[] = [];
    for (const file of capped) {
      const absPath = window.sigma.getPathForFile(file);
      if (!absPath) continue;
      const rel = pathRelative(absPath, workspaceRootPath);
      paths.push(rel);
    }
    if (paths.length === 0) return;
    const mention = paths.join(' @');
    void insertMention(session.id, mention, session.status);
  }

  function handleReveal() {
    if (!session.worktreePath) return;
    void rpc.app.revealInFolder(session.worktreePath).catch(() => undefined);
  }

  function handleOpenShell() {
    if (!session.worktreePath) return;
    void rpc.app.openShell(session.worktreePath)
      .then(() => toast.success('Terminal opened', { description: session.worktreePath! }))
      .catch((err) =>
        toast.error('Failed to open terminal', {
          description: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  // V1.1.4 Step 4 — Stop functionality lives in the right-click context menu
  // now that PaneStatusStrip is gone and the header only carries Close. The
  // ContextMenu wraps just the body so right-clicks on the header chrome
  // (with its own buttons) don't fight Radix for the event.
  //
  // v1.4.3 #06 — A minimised pane collapses to its header strip only (the
  // body is hidden via display:none). The SessionTerminal stays mounted so
  // the terminal-cache (v1.4.2 #03) preserves scrollback and the PTY keeps
  // emitting bytes — clicking the header restores the body view.
  const minimised = !!session.minimised;
  return (
    <div className="sl-pane-enter flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <PaneHeader
        session={session}
        paneIndex={paneIndex}
        providers={providers}
        onFocus={onFocus}
        onClose={onRemove}
        onSplit={onSplit}
        onToggleMinimise={onToggleMinimise}
        canSplit={!inSplitGroup}
        isMinimised={minimised}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* v1.5.1-A caveat 5: data-testid="pane-body" for stable test selection. */}
          <div
            data-testid="pane-body"
            className={[
              'relative flex min-h-0 flex-1 flex-col',
              isDragOver && 'ring-2 ring-inset ring-[hsl(var(--ring))]',
              flashDrop && 'bg-[hsl(var(--ring)/0.08)]',
            ]
              .filter(Boolean)
              .join(' ')}
            style={minimised ? { display: 'none' } : undefined}
            data-pane-minimised={minimised ? 'true' : undefined}
            data-dragover={isDragOver ? 'true' : undefined}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="relative min-h-0 flex-1">
              {errored ? (
                <div className="flex h-full flex-col items-start justify-start gap-2 p-3 text-xs">
                  <div className="font-medium text-destructive">Failed to launch</div>
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">
                    {session.error ?? 'unknown error'}
                  </div>
                </div>
              ) : (
                <>
                  <PaneSplash session={session} />
                  <SessionTerminal sessionId={session.id} />
                </>
              )}
            </div>
            <PaneFooter session={session} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={handleReveal} disabled={!hasWorktree}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Reveal worktree in Finder</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleOpenShell} disabled={!hasWorktree}>
            <TerminalIcon className="h-3.5 w-3.5" />
            <span>Open shell here</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={onStop}
            disabled={exited || errored}
            variant="destructive"
          >
            <Square className="h-3.5 w-3.5" />
            <span>Stop</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRemove} variant="destructive">
            <span>Close pane</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
