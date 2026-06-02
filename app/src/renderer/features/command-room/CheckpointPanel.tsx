// P6 FEAT-11 — agent undo/rewind UI.
//
// Lists a pane's git checkpoints (savepoints committed on its own worktree
// branch) and lets the operator:
//   - Create a manual checkpoint (`git.createCheckpoint`).
//   - Restore the pane to an earlier checkpoint (`git.restoreCheckpoint`),
//     which is DESTRUCTIVE (`git reset --hard`) and therefore confirm-gated
//     behind a themed AlertDialog. A safety snapshot is taken automatically
//     before the reset, so the message reassures the operator the rewind is
//     itself undoable.
//
// The panel subscribes to `git:checkpoints-changed` so create/restore from any
// surface refreshes the list. Only meaningful for running/exited sessions that
// have a worktree — the caller (PaneHeader) gates the menu item accordingly.

import { useCallback, useEffect, useState } from 'react';
import { GitCommitVertical, History, Loader2, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { rpc, onEvent } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { SessionCheckpoint } from '@/shared/types';

interface Props {
  sessionId: string;
}

/** Relative "time ago" — coarse but dependency-free. */
function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function CheckpointPanel({ sessionId }: Props) {
  const [checkpoints, setCheckpoints] = useState<SessionCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  /** The checkpoint pending confirmation, or null when the dialog is closed. */
  const [confirmTarget, setConfirmTarget] = useState<SessionCheckpoint | null>(null);

  // Imperative refresh used by the create/restore handlers (always called from
  // an event callback, so it never trips the set-state-in-effect rule there).
  const refresh = useCallback(async () => {
    try {
      const rows = await rpc.git.listCheckpoints(sessionId);
      setCheckpoints(rows);
    } catch {
      /* surfaced via the global RPC error toast */
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    // All setState happens inside the async IIFE (after a microtask boundary),
    // never synchronously in the effect body — satisfies the
    // react-hooks/set-state-in-effect rule. The `alive` guard prevents a stale
    // fetch from writing state after unmount / sessionId change.
    void (async () => {
      try {
        const rows = await rpc.git.listCheckpoints(sessionId);
        if (alive) setCheckpoints(rows);
      } catch {
        /* surfaced via the global RPC error toast */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    // Refresh when ANY surface creates/restores a checkpoint for this session.
    const off = onEvent<{ sessionId: string }>('git:checkpoints-changed', (p) => {
      if (p.sessionId === sessionId) void refresh();
    });
    return () => {
      alive = false;
      off();
    };
  }, [sessionId, refresh]);

  async function handleCreate(): Promise<void> {
    if (creating) return;
    setCreating(true);
    try {
      await rpc.git.createCheckpoint({ sessionId });
      toast.success('Checkpoint saved');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Checkpoint failed');
    } finally {
      setCreating(false);
    }
  }

  async function handleRestore(target: SessionCheckpoint): Promise<void> {
    setConfirmTarget(null);
    setRestoring(target.sha);
    try {
      await rpc.git.restoreCheckpoint({ sessionId, sha: target.sha });
      toast.success('Pane rewound — a safety checkpoint was saved first');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="checkpoint-panel">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <History className="h-3.5 w-3.5" aria-hidden />
          Rewind
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 text-[11px]"
          onClick={() => void handleCreate()}
          disabled={creating}
          data-testid="checkpoint-create"
          aria-label="Create checkpoint"
        >
          {creating ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-3 w-3" aria-hidden />
          )}
          Create checkpoint
        </Button>
      </div>

      {loading ? (
        <p className="py-3 text-center text-[11px] text-muted-foreground">Loading checkpoints…</p>
      ) : checkpoints.length === 0 ? (
        <p
          className="py-3 text-center text-[11px] text-muted-foreground"
          data-testid="checkpoint-empty"
        >
          No checkpoints yet. Create one to save a restore point.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" data-testid="checkpoint-list">
          {checkpoints.map((cp) => (
            <li
              key={cp.id}
              className="flex items-center gap-2 rounded border border-border px-2 py-1.5"
              data-testid="checkpoint-row"
            >
              <GitCommitVertical
                className={`h-3.5 w-3.5 shrink-0 ${cp.kind === 'auto' ? 'text-amber-500' : 'text-muted-foreground'}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[11px] font-medium">
                    {cp.label ?? 'Checkpoint'}
                  </span>
                  {cp.kind === 'auto' ? (
                    <span className="rounded bg-amber-500/15 px-1 text-[9px] uppercase tracking-wide text-amber-600">
                      auto
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <code className="font-mono">{cp.sha.slice(0, 8)}</code>
                  <span>·</span>
                  <span>{relativeTime(cp.createdAt)}</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 gap-1 text-[11px]"
                onClick={() => setConfirmTarget(cp)}
                disabled={restoring !== null}
                data-testid="checkpoint-restore"
                aria-label={`Restore to checkpoint ${cp.sha.slice(0, 8)}`}
              >
                {restoring === cp.sha ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <Undo2 className="h-3 w-3" aria-hidden />
                )}
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Destructive-restore confirmation. The AlertDialog primitive provides
          the focus-trap + Esc-to-cancel. */}
      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent data-testid="checkpoint-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this pane?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget
                ? `Restore this pane to "${confirmTarget.label ?? confirmTarget.sha.slice(0, 8)}" (${confirmTarget.sha.slice(0, 8)})? Uncommitted work after it will be discarded — a safety checkpoint is saved first, so this rewind can itself be undone.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="checkpoint-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="checkpoint-confirm-restore"
              onClick={() => {
                if (confirmTarget) void handleRestore(confirmTarget);
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
