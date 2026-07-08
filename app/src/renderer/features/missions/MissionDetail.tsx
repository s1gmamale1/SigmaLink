// P1a Task 6 — Mission detail rail: header (title/goal/origin/status/scope),
// per-task linked pane + worktree, the report (when the mission is done),
// and the event timeline. Read-only in P1a.

import { GitBranch, ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Mission, MissionEvent, MissionTask } from '@/shared/types';

interface Props {
  mission: Mission | null;
  tasks: MissionTask[];
  events: MissionEvent[];
  className?: string;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Best-effort relative timestamp ("2h ago", "yesterday", …). Falls back to
 *  an absolute date when the delta exceeds two weeks. Mirrors
 *  ConversationsPanel.tsx's `rel()`. */
function rel(ts: number): string {
  const diffMs = ts - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < hour) return RELATIVE.format(Math.round(diffMs / minute), 'minute');
  if (abs < day) return RELATIVE.format(Math.round(diffMs / hour), 'hour');
  if (abs < 14 * day) return RELATIVE.format(Math.round(diffMs / day), 'day');
  return new Date(ts).toLocaleDateString();
}

export function MissionDetail({ mission, tasks, events, className }: Props) {
  if (!mission) {
    return (
      <aside
        className={cn(
          'flex h-full w-80 shrink-0 items-center justify-center border-l border-border bg-muted/5 px-4 text-center text-xs text-muted-foreground',
          className,
        )}
        data-testid="mission-detail"
      >
        Select a mission to see its timeline.
      </aside>
    );
  }

  const linkedTasks = tasks.filter((t) => t.assigneeSessionId || t.worktreePath);

  return (
    <aside
      className={cn(
        'flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-muted/5',
        className,
      )}
      data-testid="mission-detail"
    >
      <div className="border-b border-border px-3 py-2">
        <div className="text-sm font-semibold leading-tight">{mission.title}</div>
        <p className="mt-1 text-xs text-muted-foreground">{mission.goal}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
          <span className="rounded bg-muted px-1.5 py-0.5 capitalize text-muted-foreground">
            {mission.status}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 capitalize text-muted-foreground">
            {mission.origin}
          </span>
          <span className="rounded border border-border/50 px-1.5 py-0.5 text-muted-foreground">
            {mission.workspaceId === null ? 'Global' : 'Workspace-scoped'}
          </span>
        </div>
      </div>

      {linkedTasks.length > 0 ? (
        <div className="border-b border-border px-3 py-2">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <GitBranch className="h-3 w-3" aria-hidden />
            Linked panes
          </div>
          <ul className="flex flex-col gap-1.5">
            {linkedTasks.map((t) => (
              <li key={t.id} className="text-[11px]">
                <div className="truncate font-medium">{t.title}</div>
                {t.assigneeSessionId ? (
                  <div className="truncate text-muted-foreground">
                    Pane {t.assigneeSessionId.slice(0, 8)}
                  </div>
                ) : null}
                {t.worktreePath ? (
                  <div className="truncate font-mono text-[10px] text-muted-foreground/70">
                    {t.worktreePath}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {mission.report ? (
        <div className="border-b border-border px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-1 font-medium text-muted-foreground">
            <ScrollText className="h-3 w-3" aria-hidden />
            Report
          </div>
          <p className="whitespace-pre-wrap text-foreground/90">{mission.report}</p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 px-3 py-2">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Timeline
        </div>
        {events.length === 0 ? (
          <div className="text-xs text-muted-foreground">No events yet.</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {events.map((e) => (
              <li key={e.id} className="rounded border border-border/50 px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{e.kind}</span>
                  <span className="shrink-0 text-muted-foreground">{rel(e.ts)}</span>
                </div>
                {e.body ? <div className="mt-0.5 text-muted-foreground">{e.body}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
