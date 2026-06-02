// P6 FEAT-8 — per-worktree git-activity sparkline.
//
// A compact (~16px tall) churn bar-strip for a pane header. Self-contained: it
// owns the shared 60 s activity poll for its worktree path and renders one bar
// per active day (oldest→newest), bar height ∝ that day's churn, bar tint
// ∝ relative heat (calm → hot). When there is no worktree or no recent
// activity it renders nothing — the lead mounts it unconditionally in
// PaneHeader and lets it self-suppress.

import { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';
import { useGitActivityPoll } from '@/renderer/lib/use-git-activity-poll';
import type { GitActivityBucket } from '@/shared/types';

interface GitActivityStripProps {
  worktreePath: string | null;
}

/** Map a 0..1 heat ratio to a CSS color. Calm = muted, hot = accent. We blend
 *  via HSL alpha on the accent token so it reads on both light/dark glass. */
function heatColor(ratio: number): string {
  // Clamp + floor the alpha so even the calmest active day is visible.
  const a = 0.35 + Math.min(1, Math.max(0, ratio)) * 0.65;
  return `hsl(var(--accent) / ${a.toFixed(2)})`;
}

interface Row {
  date: string;
  churn: number;
  fill: string;
}

function toRows(buckets: GitActivityBucket[]): { rows: Row[]; maxChurn: number } {
  const maxChurn = buckets.reduce((m, b) => Math.max(m, b.churn), 0);
  const rows = buckets.map((b) => ({
    date: b.date,
    // Floor the rendered value so a 0-churn-but-active day (commit with no
    // numstat, e.g. a rename) still draws a faint tick.
    churn: Math.max(b.churn, 1),
    fill: heatColor(maxChurn > 0 ? b.churn / maxChurn : 0),
  }));
  return { rows, maxChurn };
}

export function GitActivityStrip({ worktreePath }: GitActivityStripProps) {
  const buckets = useGitActivityPoll(worktreePath);

  const { rows, totals } = useMemo(() => {
    const { rows } = toRows(buckets);
    const totals = buckets.reduce(
      (acc, b) => {
        acc.commits += b.commitCount;
        acc.churn += b.churn;
        acc.added += b.linesAdded;
        acc.deleted += b.linesDeleted;
        return acc;
      },
      { commits: 0, churn: 0, added: 0, deleted: 0 },
    );
    return { rows, totals };
  }, [buckets]);

  // No worktree, no data yet, or no recent activity → render nothing. The strip
  // is mounted unconditionally; it self-suppresses so the header stays clean.
  if (!worktreePath || rows.length === 0) return null;

  const label =
    `Git activity, last ${rows.length} active ${rows.length === 1 ? 'day' : 'days'}: ` +
    `${totals.commits} ${totals.commits === 1 ? 'commit' : 'commits'}, ` +
    `${totals.churn} lines changed (+${totals.added} / -${totals.deleted}).`;

  return (
    <div
      className="h-4 w-full min-w-0"
      role="img"
      aria-label={label}
      title={label}
      data-testid="git-activity-strip"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 1, right: 0, bottom: 0, left: 0 }} barCategoryGap={1}>
          <Bar dataKey="churn" isAnimationActive={false} radius={[1, 1, 0, 0]}>
            {rows.map((r) => (
              <Cell key={r.date} fill={r.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
