// BSP-O4 — Artifacts panel: per-session read-only view of outputs.
//
// Reuses EXISTING channels only — no new RPC or table:
//   • git.status(worktreePath) → changed file counts + lists.
//   • git.listCheckpoints(sessionId) → checkpoint/savepoint timeline.
//   • git:checkpoints-changed event → live refresh on create/restore.
//
// Mounted from PaneGearPopover under an "Artifacts" section (details/summary)
// next to the existing "Rewind…" section. Read-only — no mutations here.

import { useCallback, useEffect, useState } from 'react';
import { Archive, GitCommitVertical, Loader2 } from 'lucide-react';
import { rpc, onEvent } from '@/renderer/lib/rpc';
import type { GitStatus, SessionCheckpoint } from '@/shared/types';

interface Props {
  sessionId: string;
  /** Worktree path used for git.status. Null = no worktree (in-place session). */
  worktreePath: string | null;
}

/** Relative "time ago" — mirrors CheckpointPanel (avoids adding a shared dep). */
function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function ArtifactsPanel({ sessionId, worktreePath }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [checkpoints, setCheckpoints] = useState<SessionCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, cps] = await Promise.all([
        worktreePath ? rpc.git.status(worktreePath) : Promise.resolve(null),
        rpc.git.listCheckpoints(sessionId),
      ]);
      setStatus(s);
      setCheckpoints(cps);
    } catch {
      /* surfaced via the global RPC error toast */
    } finally {
      setLoading(false);
    }
  }, [sessionId, worktreePath]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, cps] = await Promise.all([
          worktreePath ? rpc.git.status(worktreePath) : Promise.resolve(null),
          rpc.git.listCheckpoints(sessionId),
        ]);
        if (alive) { setStatus(s); setCheckpoints(cps); }
      } catch {
        /* no-op */
      } finally {
        if (alive) setLoading(false);
      }
    })();

    // Refresh when any surface creates / restores a checkpoint for this session.
    const off = onEvent<{ sessionId: string }>('git:checkpoints-changed', (p) => {
      if (p.sessionId === sessionId) void refresh();
    });

    return () => {
      alive = false;
      off();
    };
  }, [sessionId, worktreePath, refresh]);

  if (loading) {
    return (
      <div
        className="flex items-center gap-1.5 py-2 text-[11px] text-muted-foreground"
        data-testid="artifacts-panel-loading"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Loading artifacts…
      </div>
    );
  }

  const hasGitStatus = worktreePath !== null;
  const changedCount =
    (status?.staged.length ?? 0) +
    (status?.unstaged.length ?? 0) +
    (status?.untracked.length ?? 0);

  return (
    <div className="flex flex-col gap-2" data-testid="artifacts-panel">
      {/* Changed files section (only when there is a worktree) */}
      {hasGitStatus ? (
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium">
            <Archive className="h-3 w-3" aria-hidden />
            Changed files
            {changedCount > 0 ? (
              <span className="rounded bg-amber-500/15 px-1 text-[9px] text-amber-600">
                {changedCount}
              </span>
            ) : null}
          </p>
          {status && !status.clean ? (
            <ul
              className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-[10px] text-muted-foreground"
              data-testid="artifacts-changed-files"
            >
              {status.staged.map((f) => (
                <li key={`staged-${f}`} className="flex items-center gap-1 truncate">
                  <span className="text-emerald-500">S</span>
                  <span className="truncate">{f}</span>
                </li>
              ))}
              {status.unstaged.map((f) => (
                <li key={`unstaged-${f}`} className="flex items-center gap-1 truncate">
                  <span className="text-amber-500">M</span>
                  <span className="truncate">{f}</span>
                </li>
              ))}
              {status.untracked.map((f) => (
                <li key={`untracked-${f}`} className="flex items-center gap-1 truncate">
                  <span className="text-slate-400">?</span>
                  <span className="truncate">{f}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p
              className="text-[10px] text-muted-foreground"
              data-testid="artifacts-clean"
            >
              Working tree clean
            </p>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground" data-testid="artifacts-no-worktree">
          No worktree — running in-place
        </p>
      )}

      {/* Checkpoint timeline */}
      {checkpoints.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-medium">Checkpoints</p>
          <ul
            className="flex max-h-40 flex-col gap-1 overflow-y-auto"
            data-testid="artifacts-checkpoints"
          >
            {checkpoints.map((cp) => (
              <li
                key={cp.id}
                className="flex items-center gap-2 rounded border border-border px-2 py-1"
                data-testid="artifacts-checkpoint-row"
              >
                <GitCommitVertical
                  className={`h-3 w-3 shrink-0 ${cp.kind === 'auto' ? 'text-amber-500' : 'text-muted-foreground'}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-[10px] font-medium">
                      {cp.label ?? 'Checkpoint'}
                    </span>
                    {cp.kind === 'auto' ? (
                      <span className="rounded bg-amber-500/15 px-0.5 text-[8px] uppercase tracking-wide text-amber-600">
                        auto
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                    <code className="font-mono">{cp.sha.slice(0, 8)}</code>
                    <span>·</span>
                    <span>{relativeTime(cp.createdAt)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p
          className="text-[10px] text-muted-foreground"
          data-testid="artifacts-no-checkpoints"
        >
          No checkpoints yet
        </p>
      )}
    </div>
  );
}
