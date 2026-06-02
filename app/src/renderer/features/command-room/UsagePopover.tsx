// P6 FEAT-3 — per-pane usage & cost popover.
//
// Given a pane's session, fetches its rolled-up token/cost via
// `rpc.usage.sessionSummary({ sessionId })` and renders a compact breakdown
// (input / output / cache tokens + $cost + turn count). Structurally modelled
// on CheckpointPanel: a small popover body the LEAD mounts inside PaneHeader.
//
// Honest scoping: only the in-app Jorvis assistant CLI turn path records
// machine-readable usage, keyed by conversationId — raw terminal/PTY panes
// never populate the ledger. So for almost every pane this popover shows the
// graceful empty state. That is correct, not a bug: the component degrades to
// "No usage data for this provider" whenever the session has no recorded turns.

import { useEffect, useState } from 'react';
import { Coins, Loader2 } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { findProvider } from '@/shared/providers';
import type { AgentSession, UsageSummary, UsageWeekSummary } from '@/shared/types';

interface Props {
  /** `id` sums this pane's ledger rows; `workspaceId` drives the week-to-date
   *  bars. The full AgentSession is accepted so callers pass the pane as-is. */
  session: Pick<AgentSession, 'id' | 'workspaceId'>;
}

/** Compact integer formatting with thousands separators (e.g. 12,345). */
function formatTokens(n: number): string {
  return n.toLocaleString();
}

/** USD with up to 4 decimals, trimming trailing zeros (e.g. $0.0123, $1.2). */
function formatCost(usd: number): string {
  const fixed = usd.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return `$${trimmed.length > 0 ? trimmed : '0'}`;
}

/** True when the summary carries at least one recorded turn. */
function hasUsage(s: UsageSummary | null): s is UsageSummary {
  return s !== null && s.turnCount > 0;
}

export function UsagePopover({ session }: Props) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [week, setWeek] = useState<UsageWeekSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // All setState happens after the await boundary, never synchronously in the
    // effect body — satisfies react-hooks/set-state-in-effect. The `alive` guard
    // prevents a stale fetch from writing state after unmount / session change.
    void (async () => {
      try {
        const [s, w] = await Promise.all([
          rpc.usage.sessionSummary({ sessionId: session.id }),
          rpc.usage.weekSummary({ workspaceId: session.workspaceId }),
        ]);
        if (alive) {
          setSummary(s);
          setWeek(w);
        }
      } catch {
        // Surfaced via the global RPC error toast; treat as no-data locally.
        if (alive) {
          setSummary(null);
          setWeek(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [session.id, session.workspaceId]);

  return (
    <div className="flex flex-col gap-2" data-testid="usage-popover">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Coins className="h-3.5 w-3.5" aria-hidden />
        Usage &amp; cost
      </p>

      {loading ? (
        <p
          className="flex items-center justify-center gap-1.5 py-3 text-[11px] text-muted-foreground"
          data-testid="usage-loading"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Loading usage…
        </p>
      ) : !hasUsage(summary) ? (
        <p
          className="py-3 text-center text-[11px] text-muted-foreground"
          data-testid="usage-empty"
        >
          No usage data for this provider yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5" data-testid="usage-body">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <Row label="Input" value={`${formatTokens(summary.inputTokens)} tok`} />
            <Row label="Output" value={`${formatTokens(summary.outputTokens)} tok`} />
            <Row label="Cache write" value={`${formatTokens(summary.cacheCreationTokens)} tok`} />
            <Row label="Cache read" value={`${formatTokens(summary.cacheReadTokens)} tok`} />
          </dl>
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1.5">
            <span className="text-[11px] text-muted-foreground">
              {summary.turnCount} turn{summary.turnCount === 1 ? '' : 's'}
            </span>
            <span className="text-xs font-semibold tabular-nums" data-testid="usage-cost">
              {summary.totalCostUsd != null ? formatCost(summary.totalCostUsd) : '—'}
            </span>
          </div>
        </div>
      )}

      {!loading && week && week.byProvider.length > 0 ? (
        <WeekBars week={week} />
      ) : null}
    </div>
  );
}

/** FEAT-3 — workspace week-to-date spend by provider, as max-normalized bars. */
function WeekBars({ week }: { week: UsageWeekSummary }) {
  const maxCost = Math.max(
    ...week.byProvider.map((p) => p.totalCostUsd ?? 0),
    0.0001,
  );
  const total = week.byProvider.reduce((sum, p) => sum + (p.totalCostUsd ?? 0), 0);
  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-border pt-2" data-testid="usage-week">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium">This week</span>
        <span className="font-semibold tabular-nums">{formatCost(total)}</span>
      </div>
      {week.byProvider.map((p) => {
        const cost = p.totalCostUsd ?? 0;
        const pct = Math.round((cost / maxCost) * 100);
        const name = findProvider(p.providerId)?.name ?? p.providerId;
        return (
          <div key={p.providerId} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span className="truncate">{name}</span>
              <span className="tabular-nums">{p.totalCostUsd != null ? formatCost(cost) : '—'}</span>
            </div>
            <div
              className="h-1 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${name}: ${p.totalCostUsd != null ? formatCost(cost) : 'no cost'} this week`}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One label/value pair in the token grid. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </>
  );
}
