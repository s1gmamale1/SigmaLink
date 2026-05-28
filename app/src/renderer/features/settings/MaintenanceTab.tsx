// SF-13 — Settings → Maintenance tab.
//
// Operator-facing cleanup actions:
//   1. Remove workspace + all its sessions + GC orphan worktree dirs.
//   2. Close/clear all panes (sessions) for a workspace.
//   3. Prune orphan worktree dirs for a workspace (manual trigger).
//
// SAFETY model:
//   - Every destructive action shows a browser confirm() before executing.
//   - Dry-run preview is shown BEFORE the confirm so the operator knows
//     what will be deleted.
//   - Live sessions (starting/running) are never touched for worktree GC.
//   - Errors are surfaced via toast; partial failures are shown inline.

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Trash2, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

/**
 * SF-13 — side-band invoker for the `cleanup.<method>` channels. The typed `rpc`
 * proxy only knows the flat AppRouter namespaces; 2-segment side-band channels
 * (registered via ipcMain.handle, like `voice.diagnostics.*`) must call
 * `window.sigma.invoke` directly and unwrap the `{ok,data}` envelope. Mirrors
 * VoiceTab's `invokeVoiceDiagnostics`.
 */
async function invokeCleanup<T>(
  channel: string,
  arg: { workspaceId: string; dryRun: boolean },
): Promise<T> {
  if (!('sigma' in window)) {
    throw new Error('Preload bridge missing — restart the app.');
  }
  const env = (await window.sigma.invoke(channel, arg)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!env || typeof env !== 'object' || !('ok' in env)) {
    throw new Error(`Bad RPC response from ${channel}`);
  }
  if (env.ok) return env.data;
  throw new Error(env.error);
}

// ---------------------------------------------------------------------------
// Types mirroring the cleanup.* RPC shapes (no shared types file needed here
// as these are internal to the cleanup feature).
// ---------------------------------------------------------------------------

interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  repoRoot?: string | null;
  repoMode: 'git' | 'plain';
}

interface DryRunPreview {
  sessionCount: number;
  worktreeCount: number;
  liveBlockedWorktrees: string[];
}

interface PruneDryRunPreview {
  wouldRemove: string[];
  liveBlocked: string[];
}

type BusyAction =
  | { type: 'remove-dry'; workspaceId: string }
  | { type: 'remove'; workspaceId: string }
  | { type: 'clear-dry'; workspaceId: string }
  | { type: 'clear'; workspaceId: string }
  | { type: 'prune-dry'; workspaceId: string }
  | { type: 'prune'; workspaceId: string };

function isBusy(busy: BusyAction | null, workspaceId: string): boolean {
  return busy !== null && busy.workspaceId === workspaceId;
}

// ---------------------------------------------------------------------------
// MaintenanceTab
// ---------------------------------------------------------------------------

export function MaintenanceTab() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyAction | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const ws = await rpc.workspaces.list();
      setWorkspaces(ws as Workspace[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const ws = await rpc.workspaces.list();
        if (alive) setWorkspaces(ws as Workspace[]);
      } catch (err) {
        if (alive) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => { alive = false; };
  }, []);

  // -------------------------------------------------------------------------
  // Action: Remove workspace + sessions + GC worktrees
  // -------------------------------------------------------------------------

  const onRemoveWorkspace = useCallback(
    async (ws: Workspace) => {
      setBusy({ type: 'remove-dry', workspaceId: ws.id });
      let preview: DryRunPreview;
      try {
        const res = await invokeCleanup<DryRunPreview>('cleanup.removeWorkspace', { workspaceId: ws.id, dryRun: true });
        preview = res as DryRunPreview;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setBusy(null);
        return;
      }
      setBusy(null);

      const liveWarn =
        preview.liveBlockedWorktrees.length > 0
          ? `\n\n⚠ ${preview.liveBlockedWorktrees.length} worktree(s) with live sessions will be KEPT.`
          : '';
      const confirmed = window.confirm(
        `Remove workspace "${ws.name}"?\n\n` +
          `This will permanently delete:\n` +
          `  • ${preview.sessionCount} session record(s)\n` +
          `  • ${preview.worktreeCount} orphan worktree dir(s)` +
          liveWarn +
          `\n\nThis action cannot be undone.`,
      );
      if (!confirmed) return;

      setBusy({ type: 'remove', workspaceId: ws.id });
      try {
        await invokeCleanup<unknown>('cleanup.removeWorkspace', { workspaceId: ws.id, dryRun: false });
        toast.success(`Workspace "${ws.name}" removed`);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  // -------------------------------------------------------------------------
  // Action: Clear all panes (sessions) for a workspace
  // -------------------------------------------------------------------------

  const onClearPanes = useCallback(
    async (ws: Workspace) => {
      setBusy({ type: 'clear-dry', workspaceId: ws.id });
      let sessionCount = 0;
      try {
        const res = await invokeCleanup<{ sessionIds: string[]; deleted: number }>('cleanup.clearPanes', { workspaceId: ws.id, dryRun: true });
        sessionCount = (res as { sessionIds: string[]; deleted: number }).sessionIds.length;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setBusy(null);
        return;
      }
      setBusy(null);

      if (sessionCount === 0) {
        toast.success(`No pane sessions found for "${ws.name}"`);
        return;
      }

      const confirmed = window.confirm(
        `Clear all panes for "${ws.name}"?\n\n` +
          `This will delete ${sessionCount} session record(s) from the database.\n` +
          `Active (running/starting) panes will stop appearing in the UI.\n\n` +
          `This action cannot be undone.`,
      );
      if (!confirmed) return;

      setBusy({ type: 'clear', workspaceId: ws.id });
      try {
        const res = await invokeCleanup<{ sessionIds: string[]; deleted: number }>('cleanup.clearPanes', { workspaceId: ws.id, dryRun: false });
        const deleted = (res as { deleted: number }).deleted;
        toast.success(`Cleared ${deleted} pane session(s) for "${ws.name}"`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Action: Prune orphan worktree dirs
  // -------------------------------------------------------------------------

  const onPruneWorktrees = useCallback(
    async (ws: Workspace) => {
      if (ws.repoMode !== 'git') {
        toast.error(`"${ws.name}" is a plain (non-git) workspace — no worktrees to prune`);
        return;
      }

      setBusy({ type: 'prune-dry', workspaceId: ws.id });
      let prunePreview: PruneDryRunPreview;
      try {
        const res = await invokeCleanup<PruneDryRunPreview>('cleanup.pruneWorktrees', { workspaceId: ws.id, dryRun: true });
        prunePreview = res as PruneDryRunPreview;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setBusy(null);
        return;
      }
      setBusy(null);

      if (prunePreview.wouldRemove.length === 0) {
        toast.success(`No orphan worktrees found for "${ws.name}"`);
        return;
      }

      const liveNote =
        prunePreview.liveBlocked.length > 0
          ? `\n\n${prunePreview.liveBlocked.length} dir(s) with live sessions will be KEPT.`
          : '';

      const confirmed = window.confirm(
        `Prune orphan worktrees for "${ws.name}"?\n\n` +
          `Will remove ${prunePreview.wouldRemove.length} orphan dir(s):` +
          prunePreview.wouldRemove.slice(0, 5).map((p) => `\n  ${p}`).join('') +
          (prunePreview.wouldRemove.length > 5
            ? `\n  … and ${prunePreview.wouldRemove.length - 5} more`
            : '') +
          liveNote +
          `\n\nThis action cannot be undone.`,
      );
      if (!confirmed) return;

      setBusy({ type: 'prune', workspaceId: ws.id });
      try {
        const res = await invokeCleanup<{ removed: number; liveBlocked: string[]; errors: number }>('cleanup.pruneWorktrees', { workspaceId: ws.id, dryRun: false });
        const pruneResult = res as { removed: number; liveBlocked: string[]; errors: number };
        if (pruneResult.errors > 0) {
          toast.warning(
            `Pruned ${pruneResult.removed} dir(s) for "${ws.name}" — ${pruneResult.errors} failed (check logs)`,
          );
        } else {
          toast.success(`Pruned ${pruneResult.removed} orphan worktree dir(s) for "${ws.name}"`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const sectionLabel = 'mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground';

  return (
    <div className="flex flex-col gap-6">
      {/* Header note */}
      <section>
        <div className={sectionLabel}>Maintenance</div>
        <div className="rounded-md border border-amber-300/30 bg-amber-100/5 p-3 text-xs text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              These actions are destructive and cannot be undone. Each action shows a preview
              dialog before proceeding. Live (starting/running) pane worktrees are never deleted.
            </span>
          </div>
        </div>
      </section>

      {/* Workspace list */}
      <section>
        <div className={sectionLabel}>Workspaces</div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading workspaces…
          </div>
        ) : workspaces.length === 0 ? (
          <div className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
            No workspaces found.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {workspaces.map((ws) => (
              <WorkspaceCleanupRow
                key={ws.id}
                workspace={ws}
                busy={isBusy(busy, ws.id) ? busy! : null}
                onRemove={() => void onRemoveWorkspace(ws)}
                onClearPanes={() => void onClearPanes(ws)}
                onPruneWorktrees={() => void onPruneWorktrees(ws)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkspaceCleanupRow
// ---------------------------------------------------------------------------

interface WorkspaceCleanupRowProps {
  workspace: Workspace;
  busy: BusyAction | null;
  onRemove: () => void;
  onClearPanes: () => void;
  onPruneWorktrees: () => void;
}

function WorkspaceCleanupRow({
  workspace,
  busy,
  onRemove,
  onClearPanes,
  onPruneWorktrees,
}: WorkspaceCleanupRowProps) {
  const isBusyNow = busy !== null;

  return (
    <div
      className="rounded-md border border-border bg-card/40 p-3"
      data-testid={`maintenance-ws-row-${workspace.id}`}
    >
      <div className="mb-2">
        <div className="text-sm font-medium">{workspace.name}</div>
        <div
          className="truncate text-[11px] text-muted-foreground"
          title={workspace.rootPath}
        >
          {workspace.rootPath}
        </div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {workspace.repoMode === 'git' ? 'Git repo' : 'Plain directory'}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Clear panes */}
        <ActionButton
          icon={
            busy?.type === 'clear-dry' || busy?.type === 'clear' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <X className="h-3 w-3" />
            )
          }
          label="Clear panes"
          disabled={isBusyNow}
          onClick={onClearPanes}
          variant="ghost"
          testId={`maintenance-clear-panes-${workspace.id}`}
        />
        {/* Prune worktrees — only shown for git repos */}
        {workspace.repoMode === 'git' && (
          <ActionButton
            icon={
              busy?.type === 'prune-dry' || busy?.type === 'prune' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )
            }
            label="Prune orphan worktrees"
            disabled={isBusyNow}
            onClick={onPruneWorktrees}
            variant="ghost"
            testId={`maintenance-prune-worktrees-${workspace.id}`}
          />
        )}
        {/* Remove workspace — always destructive */}
        <ActionButton
          icon={
            busy?.type === 'remove-dry' || busy?.type === 'remove' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )
          }
          label="Remove workspace"
          disabled={isBusyNow}
          onClick={onRemove}
          variant="destructive-ghost"
          testId={`maintenance-remove-ws-${workspace.id}`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionButton helper
// ---------------------------------------------------------------------------

interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
  variant: 'ghost' | 'destructive-ghost';
  testId?: string;
}

function ActionButton({ icon, label, disabled, onClick, variant, testId }: ActionButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'h-7 gap-1.5 px-2 text-[11px]',
        variant === 'destructive-ghost' &&
          'text-destructive hover:bg-destructive/10 hover:text-destructive',
      )}
    >
      {icon}
      {label}
    </Button>
  );
}
