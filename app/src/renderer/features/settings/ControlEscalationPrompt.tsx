// ControlEscalationPrompt — global overlay that queues and displays dangerous-
// tool escalation requests from the External Control MCP.
//
// Mount once at the app root (App.tsx). It subscribes to `control:escalation`
// IPC events via `useControlEscalation`, shows one card at a time (oldest
// first), and calls `rpc.control.respondEscalation` on Approve/Deny.

import { useCallback, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { Button } from '@/components/ui/button';
import { useControlEscalation } from './use-control-escalation';

export function ControlEscalationPrompt() {
  const { queue, dismiss } = useControlEscalation();
  const [busy, setBusy] = useState(false);

  const respond = useCallback(
    async (id: string, approved: boolean) => {
      setBusy(true);
      try {
        await rpc.control.respondEscalation({ id, approved });
      } catch {
        // Best-effort — the main process will time out the escalation if we
        // fail to respond. Don't block the UI on this.
      } finally {
        dismiss(id);
        setBusy(false);
      }
    },
    [dismiss],
  );

  // Show the oldest pending request first.
  const current = queue[0];
  if (!current) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="External control permission request"
      data-testid="control-escalation-prompt"
      className="fixed bottom-4 right-4 z-[9998] w-80 rounded-lg border border-amber-500/40 bg-popover shadow-xl"
    >
      <div className="flex items-start gap-3 p-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold leading-snug">
            External agent permission request
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{current.clientLabel}</span> wants to
            run <span className="font-mono font-medium text-foreground">{current.toolName}</span>
          </p>
          {current.summary && (
            <p className="text-xs text-muted-foreground">{current.summary}</p>
          )}
          {queue.length > 1 && (
            <p className="text-[11px] text-muted-foreground">
              +{queue.length - 1} more pending
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button
          data-testid="control-escalation-deny"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void respond(current.id, false)}
        >
          <X className="mr-1 h-3 w-3" />
          Deny
        </Button>
        <Button
          data-testid="control-escalation-approve"
          size="sm"
          disabled={busy}
          onClick={() => void respond(current.id, true)}
        >
          <Check className="mr-1 h-3 w-3" />
          Approve
        </Button>
      </div>
    </div>
  );
}
