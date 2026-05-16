// v1.4.2-06 — First-launch info banner explaining where pane worktrees live.
// Dismissed state is persisted via kv so it only shows once.

import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Info, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';

interface Props {
  onDismiss: () => void;
}

export function WorktreeInfoBanner({ onDismiss }: Props) {
  const [userDataPath, setUserDataPath] = useState<string>('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      rpc.app.getUserDataPath().catch(() => ''),
      rpc.app.dismissedWorktreeBanner().catch(() => false),
    ]).then(([path, wasDismissed]) => {
      if (alive) {
        setUserDataPath(path);
        setDismissed(wasDismissed);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    void rpc.kv.set('ui.dismissedWorktreeBanner', '1').catch(() => undefined);
    onDismiss();
  }, [onDismiss]);

  const handleReveal = useCallback(() => {
    const wtDir = userDataPath ? `${userDataPath}/worktrees` : '';
    if (wtDir) void rpc.app.revealInFolder(wtDir).catch(() => undefined);
  }, [userDataPath]);

  if (dismissed || !userDataPath) return null;

  return (
    <div className="flex items-start gap-2 border-b border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground">
      <Info className="mt-[1px] h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Where pane worktrees live</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Each pane gets an isolated git worktree under{' '}
          <code className="rounded bg-muted/50 px-1 text-[11px]">{userDataPath}/worktrees</code>.
          Right-click a pane to reveal its worktree or open a terminal there.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs"
          onClick={handleReveal}
        >
          <FolderOpen className="h-3 w-3" />
          Open folder
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
