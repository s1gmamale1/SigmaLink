// BSP-G2 — Branch list panel.
// Lists all local branches; non-current branch click → confirm → git.switchBranch.
// Disabled when working tree is dirty (tooltip explains why).

import { useEffect, useState } from 'react';
import { GitBranch, RefreshCw, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { GitBranchList, GitStatus } from '@/shared/types';

interface Props {
  repoRoot: string;
  status: GitStatus | null;
  /** Called after a successful branch switch so the parent can refresh status. */
  onSwitched: () => void;
}

export function BranchSelector({ repoRoot, status, onSwitched }: Props) {
  const [branchList, setBranchList] = useState<GitBranchList | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isDirty = status ? !status.clean : false;

  async function loadBranches() {
    setLoading(true);
    setError(null);
    try {
      const bl = await rpc.git.listBranches(repoRoot);
      setBranchList(bl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load branches.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const bl = await rpc.git.listBranches(repoRoot);
        if (alive) setBranchList(bl);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load branches.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [repoRoot]);

  async function handleSwitch(branch: string) {
    if (isDirty) return;
    if (!window.confirm(`Switch to branch "${branch}"?`)) return;
    setSwitching(branch);
    setError(null);
    try {
      const result = await rpc.git.switchBranch({ cwd: repoRoot, branch });
      if (result.ok) {
        onSwitched();
        await loadBranches();
      } else {
        setError(result.error ?? 'Switch failed.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Switch failed.');
    } finally {
      setSwitching(null);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Loading branches…
      </div>
    );
  }

  if (!branchList || branchList.branches.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        No branches found.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {error ? (
        <div className="px-3 py-1 text-[10px] text-destructive">{error}</div>
      ) : null}
      {isDirty ? (
        <div className="mx-3 my-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600 dark:text-amber-400">
          Commit or stash changes before switching branches.
        </div>
      ) : null}
      {branchList.branches.map((b) => {
        const isSwitching = switching === b.name;
        const row = (
          <button
            key={b.name}
            type="button"
            disabled={b.current || isDirty || isSwitching}
            onClick={() => void handleSwitch(b.name)}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
              b.current
                ? 'cursor-default text-foreground'
                : isDirty
                ? 'cursor-not-allowed text-muted-foreground/50'
                : 'hover:bg-accent/20 text-muted-foreground hover:text-foreground',
            )}
          >
            <GitBranch
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                b.current ? 'text-primary' : 'text-muted-foreground',
              )}
            />
            <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
            {b.upstream ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">{b.upstream}</span>
            ) : null}
            {b.current ? (
              <Check className="h-3 w-3 shrink-0 text-primary" aria-label="current branch" />
            ) : null}
            {isSwitching ? (
              <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : null}
          </button>
        );

        if (isDirty && !b.current) {
          return (
            <Tooltip key={b.name}>
              <TooltipTrigger asChild>{row}</TooltipTrigger>
              <TooltipContent side="right">Commit or stash first</TooltipContent>
            </Tooltip>
          );
        }
        return row;
      })}
    </div>
  );
}
