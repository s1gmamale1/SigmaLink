// v1.4.2-06 — Settings → Storage panel.
// Lists all worktree directories with their disk sizes and a "Reveal" button.

import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, HardDrive, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';

interface WorktreeEntry {
  path: string;
  sizeBytes: number;
  repoHash: string;
  branchSeg: string;
}

function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  return `${(b / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export function StorageTab() {
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [userDataPath, setUserDataPath] = useState('');

  useEffect(() => {
    let alive = true;
    void Promise.all([
      rpc.fs.getWorktreeSizes().catch(() => ({ worktrees: [], totalBytes: 0 })),
      rpc.app.getUserDataPath().catch(() => ''),
    ]).then(([sizes, uPath]) => {
      if (alive) {
        setWorktrees(sizes.worktrees);
        setTotalBytes(sizes.totalBytes);
        setUserDataPath(uPath);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleRevealAll = useCallback(() => {
    const wtDir = userDataPath ? `${userDataPath}/worktrees` : '';
    if (wtDir) void rpc.app.revealInFolder(wtDir).catch(() => undefined);
  }, [userDataPath]);

  const handleRevealOne = useCallback((p: string) => {
    void rpc.app.revealInFolder(p).catch(() => undefined);
  }, []);

  const sectionLabel = 'mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground';
  const cardCls = 'rounded-md border border-border bg-card/40 p-3';

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className={sectionLabel}>Worktree storage</div>
        <div className={cardCls}>
          {loading ? (
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">Scanning worktrees…</span>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2 text-sm">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <span>
                  Total:{' '}
                  <span className="font-medium">{formatBytes(totalBytes)}</span>
                  {' '}across {worktrees.length} worktree{worktrees.length !== 1 ? 's' : ''}
                </span>
                {worktrees.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="ml-auto gap-1"
                    onClick={handleRevealAll}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Reveal folder
                  </Button>
                )}
              </div>
              {worktrees.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No worktrees found. They are created when you launch agent panes in a git repo.
                </div>
              ) : (
                <div className="space-y-1">
                  {worktrees.map((wt) => (
                    <div
                      key={wt.path}
                      className="flex items-center gap-2 rounded border border-border/50 bg-card/20 px-2 py-1.5 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {wt.branchSeg}
                          <span className="ml-1 text-muted-foreground">
                            ({wt.repoHash.slice(0, 8)})
                          </span>
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground" title={wt.path}>
                          {wt.path}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[11px]">{formatBytes(wt.sizeBytes)}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0"
                          onClick={() => handleRevealOne(wt.path)}
                          aria-label="Reveal in Finder"
                        >
                          <FolderOpen className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section>
        <div className={sectionLabel}>About worktrees</div>
        <div className="overflow-hidden rounded-md border border-border bg-card/30">
          <Row label="Location" value={userDataPath ? `${userDataPath}/worktrees` : '—'} mono />
          <Row label="Purpose" value="Isolated git worktrees per pane" />
          <Row label="Cleanup" value="Removed when panes are closed" />
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Worktrees keep each pane&apos;s working directory isolated so agents can commit and push
          independently. They are stored under the app&apos;s data directory following OS conventions.
        </div>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className="w-32 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <code
        className={
          mono
            ? 'flex-1 select-all break-all font-mono text-xs'
            : 'flex-1 select-all break-words text-xs'
        }
      >
        {value}
      </code>
    </div>
  );
}
