// Conflicts tab: lists files predicted to conflict on merge with the
// workspace's base branch.

import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import type { ReviewConflict, ReviewSession } from '@/shared/types';

interface Props {
  session: ReviewSession;
}

export function ConflictsTab({ session }: Props) {
  const [conflicts, setConflicts] = useState<ReviewConflict[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const c = await rpc.review.getConflicts(session.sessionId);
      setConflicts(c);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      setConflicts(null);
      void refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          Predicted via <code className="rounded bg-muted px-1">git merge-tree</code> vs the workspace base branch.
        </span>
        <Button onClick={refresh} variant="ghost" size="sm" disabled={loading}>
          <RefreshCw className="mr-1 h-3 w-3" />
          Refresh
        </Button>
      </div>
      {err ? (
        <div className="border-b border-red-500/40 bg-red-500/5 px-3 py-1 text-xs text-red-500">
          {err}
        </div>
      ) : null}
      <div className="flex-1 overflow-auto p-3 text-sm">
        {loading && conflicts === null ? (
          <div className="text-xs text-muted-foreground">Computing…</div>
        ) : conflicts && conflicts.length === 0 ? (
          <div className="flex items-center gap-2 text-emerald-500">
            <ShieldCheck className="h-4 w-4" />
            <span>No predicted conflicts.</span>
          </div>
        ) : conflicts ? (
          <ul className="space-y-1">
            {conflicts.map((c) => (
              <li
                key={c.path}
                className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-xs"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="flex-1 truncate font-mono">{c.path}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {c.method}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
