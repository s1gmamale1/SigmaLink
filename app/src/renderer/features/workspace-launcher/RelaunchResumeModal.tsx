// P6 FEAT-1 — on-demand "Resume agents…" relaunch modal.
//
// ADDITIVE feature: the boot auto-resume (use-session-restore.ts → panes.resume)
// is untouched. This modal lets the operator relaunch a CHOSEN subset of the
// active workspace's panes at any time. On open it lists every pane slot via
// `rpc.panes.listForWorkspace(wsId)`; the operator ticks rows and clicks
// "Relaunch selected (N)" → `rpc.panes.resumeSelected(wsId, ids)` → a toast
// summarises the PaneResumeResult (resumed / failed / skipped) and the modal
// closes. Focus-trap + Escape come for free from the Radix Dialog primitive.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { rpc } from '@/renderer/lib/rpc';
import { findProvider } from '@/shared/providers';
import { toast } from 'sonner';
import type { AgentSession } from '@/shared/types';

export interface RelaunchResumeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
}

/** Coarse relative-time formatter — mirrors SessionStep.tsx's row formatter so
 *  the picker reads consistently with the rest of the launcher. */
function relativeTime(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** A pane row is "exited/crashed" when it is not currently running — i.e. the
 *  rows the operator most often wants to relaunch. */
function isExitedOrCrashed(s: AgentSession): boolean {
  return s.status === 'exited' || s.status === 'error';
}

export function RelaunchResumeModal({
  open,
  onOpenChange,
  workspaceId,
}: RelaunchResumeModalProps) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Load the workspace's pane slots whenever the modal opens for a workspace.
  // The reset + fetch are deferred to a microtask so the effect body does not
  // call setState synchronously (react-hooks/set-state-in-effect); the closed
  // state renders `null` content regardless, so stale rows are never visible.
  useEffect(() => {
    if (!open || !workspaceId) return;
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      setLoading(true);
      setSessions([]);
      setSelected(new Set());
      void rpc.panes
        .listForWorkspace(workspaceId)
        .then((rows) => {
          if (alive) setSessions(rows);
        })
        .catch((err) => {
          if (alive) setSessions([]);
          console.error('listForWorkspace failed', err);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    });
    return () => {
      alive = false;
    };
  }, [open, workspaceId]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectExitedOrCrashed = useCallback(() => {
    setSelected(new Set(sessions.filter(isExitedOrCrashed).map((s) => s.id)));
  }, [sessions]);

  const exitedCount = useMemo(
    () => sessions.filter(isExitedOrCrashed).length,
    [sessions],
  );

  const handleRelaunch = useCallback(() => {
    if (!workspaceId || selected.size === 0) return;
    const ids = [...selected];
    setBusy(true);
    void rpc.panes
      .resumeSelected(workspaceId, ids)
      .then((result) => {
        const { resumed, failed, skipped } = result;
        const summary = `Relaunched ${resumed.length} · ${failed.length} failed · ${skipped.length} skipped`;
        if (failed.length > 0) {
          toast.error(summary);
        } else {
          toast.success(summary);
        }
        onOpenChange(false);
      })
      .catch((err) => {
        toast.error(
          `Relaunch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }, [workspaceId, selected, onOpenChange]);

  const hasSessions = sessions.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        data-testid="relaunch-resume-modal"
      >
        <DialogHeader>
          <DialogTitle>Resume agents</DialogTitle>
          <DialogDescription>
            Relaunch one or more agent panes in this workspace. Boot auto-resume
            is unaffected.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p
            className="py-6 text-center text-sm text-muted-foreground"
            data-testid="relaunch-loading"
          >
            Loading sessions…
          </p>
        ) : !hasSessions ? (
          <p
            className="py-6 text-center text-sm text-muted-foreground"
            data-testid="relaunch-empty"
          >
            No agent panes in this workspace yet.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline disabled:opacity-50"
                onClick={selectExitedOrCrashed}
                disabled={exitedCount === 0}
                data-testid="relaunch-select-exited"
              >
                Select exited/crashed ({exitedCount})
              </button>
              <span className="text-xs text-muted-foreground">
                {selected.size} selected
              </span>
            </div>
            <ul
              className="flex max-h-72 flex-col gap-1 overflow-y-auto"
              data-testid="relaunch-session-list"
            >
              {sessions.map((s) => {
                const provider = findProvider(s.providerId);
                const color = provider?.color ?? '#6b7280';
                const shortId = s.id.slice(0, 6);
                const checked = selected.has(s.id);
                return (
                  <li key={s.id}>
                    <label
                      className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition hover:bg-foreground/[0.05]"
                      data-testid={`relaunch-row-${s.id}`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(s.id)}
                        aria-label={`Select ${provider?.name ?? s.providerId} ${shortId}`}
                        data-testid={`relaunch-checkbox-${s.id}`}
                      />
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      />
                      <span className="flex-1 truncate text-sm">
                        <span className="font-mono text-xs text-muted-foreground">
                          {shortId}
                        </span>
                        <span className="ml-2">
                          {provider?.name ?? s.providerId}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {s.status}
                      </span>
                      <span className="w-16 text-right text-xs text-muted-foreground">
                        {relativeTime(s.startedAt)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="relaunch-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleRelaunch}
            disabled={busy || selected.size === 0}
            data-testid="relaunch-confirm"
          >
            <RotateCw className="mr-2 h-4 w-4" />
            Relaunch selected ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
