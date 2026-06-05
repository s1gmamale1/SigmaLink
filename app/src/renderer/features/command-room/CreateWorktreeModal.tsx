// BSP-G1 — Create Worktree modal.
//
// Opened from the PaneShell context menu ("Create worktree…").
// Collects a branch name (→ hint) and an optional base ref (→ base),
// then calls rpc.git.worktreeCreate({ repoRoot, hint, base }).
// On success shows the returned worktreePath + branch via a toast.

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';

export interface CreateWorktreeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absolute path to the repo root. Sourced from session.worktreePath or workspace root. */
  repoRoot: string;
}

export function CreateWorktreeModal({
  open,
  onOpenChange,
  repoRoot,
}: CreateWorktreeModalProps) {
  const [hint, setHint] = useState('');
  const [base, setBase] = useState('');
  const [loading, setLoading] = useState(false);

  const canSubmit = hint.trim().length > 0 && !loading;

  async function handleSubmit() {
    if (!canSubmit) return;
    setLoading(true);
    try {
      const trimmedBase = base.trim();
      const result = await rpc.git.worktreeCreate({
        repoRoot,
        hint: hint.trim(),
        ...(trimmedBase ? { base: trimmedBase } : {}),
      });
      toast.success('Worktree created', {
        description: `${result.branch} → ${result.worktreePath}`,
      });
      onOpenChange(false);
      setHint('');
      setBase('');
    } catch (err) {
      toast.error('Failed to create worktree', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="create-worktree-modal">
        <DialogHeader>
          <DialogTitle>Create worktree</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="cwt-branch-input" className="text-xs font-medium">
              Branch name
            </label>
            <Input
              id="cwt-branch-input"
              data-testid="cwt-branch"
              placeholder="feature/my-branch"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              autoFocus
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="cwt-base-input" className="text-xs font-medium text-muted-foreground">
              Base ref <span className="font-normal">(optional)</span>
            </label>
            <Input
              id="cwt-base-input"
              data-testid="cwt-base"
              placeholder="main"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              disabled={loading}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            data-testid="cwt-submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {loading ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
