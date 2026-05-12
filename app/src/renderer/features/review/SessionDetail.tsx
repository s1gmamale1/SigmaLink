// Right pane of the Review Room: tabs Diff/Tests/Notes/Conflicts plus the
// per-session toolbar (mark passed/failed, commit & merge, drop changes).

import { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  GitMerge,
  Trash2,
  X,
} from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ReviewDiff, ReviewSession } from '@/shared/types';
import { DiffView } from './DiffView';
import { TestsTab } from './TestsTab';
import { NotesTab } from './NotesTab';
import { ConflictsTab } from './ConflictsTab';

type TabId = 'diff' | 'tests' | 'notes' | 'conflicts';

interface Props {
  session: ReviewSession;
}

export function SessionDetail({ session }: Props) {
  const [tab, setTab] = useState<TabId>('diff');
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Load diff whenever session changes (only when on Diff tab to keep things
  // light, but cache once loaded).
  useEffect(() => {
    let alive = true;
    if (!session.worktreePath) {
      queueMicrotask(() => {
        if (alive) setDiff(null);
      });
      return;
    }
    queueMicrotask(() => {
      if (!alive) return;
      setDiffLoading(true);
      void (async () => {
        try {
          const d = await rpc.review.getDiff(session.sessionId);
          if (!alive) return;
          setDiff(d);
        } catch {
          if (alive) setDiff(null);
        } finally {
          if (alive) setDiffLoading(false);
        }
      })();
    });
    return () => {
      alive = false;
    };
  }, [session.sessionId, session.worktreePath]);

  const refreshDiff = async () => {
    setDiffLoading(true);
    try {
      const d = await rpc.review.getDiff(session.sessionId);
      setDiff(d);
    } finally {
      setDiffLoading(false);
    }
  };

  const handleCommitMerge = async () => {
    setActionErr(null);
    setActionMsg('Committing & merging…');
    try {
      const r = await rpc.review.commitAndMerge({
        sessionId: session.sessionId,
        message: `sigmalink: merge ${session.branch ?? 'session'}\n\nSigma-Agent: ${session.providerId}:${session.sessionId}`,
      });
      if (r.code === 0) {
        setActionMsg('Merged. Worktree pruned.');
      } else {
        setActionMsg(null);
        setActionErr(r.stderr || `merge failed (exit ${r.code})`);
      }
    } catch (e) {
      setActionMsg(null);
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDrop = async () => {
    setActionErr(null);
    setActionMsg('Dropping changes…');
    try {
      const r = await rpc.review.dropChanges(session.sessionId);
      if (r.code === 0) {
        setActionMsg('Dropped uncommitted changes.');
        await refreshDiff();
      } else {
        setActionMsg(null);
        setActionErr(r.stderr || `drop failed (${r.code})`);
      }
    } catch (e) {
      setActionMsg(null);
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  const handleMarkPassed = async () => {
    try {
      await rpc.review.markPassed(session.sessionId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };
  const handleMarkFailed = async () => {
    try {
      await rpc.review.markFailed(session.sessionId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };
  const handleOpenInEditor = () => {
    if (!session.worktreePath) return;
    // Trigger the OS default file:// open. The renderer can't shell out, so we
    // synthesize an anchor click; if there's no protocol handler it's a no-op.
    const a = document.createElement('a');
    a.href = `file://${session.worktreePath.replace(/\\/g, '/')}`;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.click();
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {session.providerId}{' '}
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {session.branch ?? '(no branch)'}
            </span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground" title={session.worktreePath ?? ''}>
            {session.worktreePath ?? '— merged —'}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button onClick={handleMarkPassed} size="sm" variant="ghost" title="Mark passed">
            <Check className="mr-1 h-3.5 w-3.5 text-emerald-500" /> Pass
          </Button>
          <Button onClick={handleMarkFailed} size="sm" variant="ghost" title="Mark failed">
            <X className="mr-1 h-3.5 w-3.5 text-red-500" /> Fail
          </Button>
          <Button
            onClick={handleCommitMerge}
            size="sm"
            disabled={!session.worktreePath}
            title="Commit and merge"
          >
            <GitMerge className="mr-1 h-3.5 w-3.5" /> Commit & merge
          </Button>
          <Button
            onClick={handleDrop}
            size="sm"
            variant="destructive"
            disabled={!session.worktreePath}
            title="Discard uncommitted changes"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Drop
          </Button>
          <Button onClick={handleOpenInEditor} size="sm" variant="outline" disabled={!session.worktreePath}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open
          </Button>
        </div>
      </header>
      {actionMsg ? (
        <div className="border-b border-emerald-500/40 bg-emerald-500/5 px-3 py-1 text-[11px] text-emerald-500">
          {actionMsg}
        </div>
      ) : null}
      {actionErr ? (
        <div className="border-b border-red-500/40 bg-red-500/5 px-3 py-1 text-[11px] text-red-500">
          {actionErr}
        </div>
      ) : null}
      <div className="flex items-center gap-1 border-b border-border bg-background px-2 text-xs">
        {(['diff', 'tests', 'notes', 'conflicts'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'border-b-2 px-3 py-2 capitalize transition',
              tab === t
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'diff' ? (
          <DiffView diff={diff} loading={diffLoading} />
        ) : tab === 'tests' ? (
          <TestsTab session={session} />
        ) : tab === 'notes' ? (
          <NotesTab session={session} />
        ) : (
          <ConflictsTab session={session} />
        )}
      </div>
    </div>
  );
}
