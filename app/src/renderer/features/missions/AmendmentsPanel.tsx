// P2 Task 8 — compact self-amendment review panel inside the Missions room.
// Jorvis's propose_amendment tool writes a 'proposed' row (D5 — inert until
// the operator decides it); this panel IS the operator's decision surface —
// Approve/Deny call `jorvis.amendmentsDecide` directly (a real RPC mutation,
// not a tool round-trip). Renders nothing when the review queue is empty —
// no queue, no clutter.

import { FileEdit } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAmendments } from './use-amendments';

interface Props {
  className?: string;
}

export function AmendmentsPanel({ className }: Props) {
  const { amendments, decidingId, decide } = useAmendments();

  if (amendments.length === 0) return null;

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-2 border-b border-border bg-amber-500/5 px-3 py-2',
        className,
      )}
      data-testid="amendments-panel"
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <FileEdit className="h-3.5 w-3.5 text-amber-500" aria-hidden />
        <span>Self-amendments awaiting approval</span>
        <span
          className="ml-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-mono text-amber-600"
          data-testid="amendments-badge"
        >
          {amendments.length}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {amendments.map((a) => {
          const busy = decidingId === a.id;
          return (
            <div
              key={a.id}
              className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs"
              data-testid="amendment-row"
            >
              <p className="text-foreground">{a.text}</p>
              {a.rationale ? (
                <p className="text-[11px] text-muted-foreground">{a.rationale}</p>
              ) : null}
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void decide(a.id, true)}
                  disabled={busy}
                  className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600 transition hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void decide(a.id, false)}
                  disabled={busy}
                  className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-600 transition hover:bg-red-500/20 disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
