// SigmaLink Dev — "How many terminals?" dialog (Phase 14, Task 8).
//
// Shown when the singleton dev workspace has no pane rows yet. Asks the
// operator for a terminal count (1..DEV_WORKSPACE_MAX_PANES, default 4) and
// hands it back via onLaunch so the Sidebar can spawn that many plain shell
// panes via rpc.workspaces.launch. The stepper mirrors the launcher's
// CounterControls idiom (− / mono count / +, bordered h-7 w-7 buttons).

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DEV_WORKSPACE_MAX_PANES, DEV_WORKSPACE_NAME } from '@/shared/special-workspace';

export interface DevWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (paneCount: number) => void;
  /**
   * True while the Sidebar's launch rpc is in flight. Disables the Launch
   * button so a rapid double-click can't queue a second launch plan —
   * workspaces.launch is ADDITIVE server-side and would spawn 2N panes.
   */
  launching?: boolean;
}

const DEFAULT_TERMINALS = 4;

export function DevWorkspaceDialog({
  open,
  onOpenChange,
  onLaunch,
  launching,
}: DevWorkspaceDialogProps) {
  const [count, setCount] = useState(DEFAULT_TERMINALS);

  // The wrapper stays mounted across open/close (Radix only unmounts the
  // portal content), so reset the stepper each time the dialog opens — a
  // count bumped on a previous visit must not leak into the next one.
  // Render-time prev-prop adjustment (react.dev "You Might Not Need an
  // Effect"); an effect-based reset trips react-hooks/set-state-in-effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setCount(DEFAULT_TERMINALS);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dev-workspace-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{DEV_WORKSPACE_NAME}</DialogTitle>
          <DialogDescription className="sr-only">
            Choose how many plain terminals to launch in your home directory.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-muted-foreground">Terminals</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={count <= 1}
              onClick={() => setCount((c) => Math.max(1, c - 1))}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/60 text-sm transition hover:bg-card disabled:opacity-30"
              aria-label="Decrement"
            >
              −
            </button>
            <span
              data-testid="dev-workspace-count"
              className="w-6 text-center font-mono text-sm tabular-nums"
            >
              {count}
            </span>
            <button
              type="button"
              disabled={count >= DEV_WORKSPACE_MAX_PANES}
              onClick={() => setCount((c) => Math.min(DEV_WORKSPACE_MAX_PANES, c + 1))}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/60 text-sm transition hover:bg-card disabled:opacity-30"
              aria-label="Increment"
            >
              +
            </button>
          </div>
        </div>
        <DialogFooter>
          <Button
            data-testid="dev-workspace-launch"
            onClick={() => onLaunch(count)}
            disabled={launching}
          >
            Launch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
