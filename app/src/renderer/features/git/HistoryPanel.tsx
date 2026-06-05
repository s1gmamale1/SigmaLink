// BSP-G2 — Commit history panel: shows git log entries (subject · author · relDate · refs).
// Commit-click diff is deferred (not trivial given GitDiff shape is HEAD-relative).

import { useEffect, useState } from 'react';
import { GitCommit, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/renderer/lib/rpc';
import type { GitLogEntry } from '@/shared/types';

interface Props {
  repoRoot: string;
}

export function HistoryPanel({ repoRoot }: Props) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoRoot) return;
    let alive = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const log = await rpc.git.log(repoRoot, 100);
        if (alive) setEntries(log);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load history.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [repoRoot]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-destructive">
        {error}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        No commits found.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {entries.map((entry) => (
        <div
          key={entry.sha}
          className="group flex items-start gap-2 border-b border-border/40 px-3 py-2 hover:bg-accent/15"
        >
          <GitCommit className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground" title={entry.subject}>
              {entry.subject}
            </p>
            <p className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{entry.shortSha}</span>
              <span>{entry.author}</span>
              <span>{entry.relDate}</span>
              {entry.refs ? (
                <span
                  className={cn(
                    'rounded bg-primary/10 px-1 py-px font-mono text-primary',
                  )}
                >
                  {entry.refs}
                </span>
              ) : null}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
