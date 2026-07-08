// P1a Task 6 — Kanban card for a single mission task. Read-only in P1a (no
// drag handles — that's optional P1b polish, see Task 6 brief). Shows the
// title, a status-colored dot, and the linked pane/session id when the task
// is assigned. `assigneeSessionId` is always null in P1a's tool set, so this
// must render fine on null (it does — the badge is simply omitted).

import { cn } from '@/lib/utils';
import type { MissionTask, MissionTaskStatus } from '@/shared/types';

interface Props {
  task: MissionTask;
  onClick?: (task: MissionTask) => void;
}

const STATUS_DOT: Record<MissionTaskStatus, string> = {
  backlog: 'bg-muted-foreground/40',
  dispatched: 'bg-blue-500',
  working: 'bg-amber-500',
  reviewing: 'bg-violet-500',
  needs_input: 'bg-orange-500',
  done: 'bg-emerald-500',
  blocked: 'bg-red-500',
};

export function MissionTaskCard({ task, onClick }: Props) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(task)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(task);
        }
      }}
      className="cursor-pointer select-none rounded-md border border-border bg-card p-2 text-xs shadow-sm transition hover:border-primary/50"
      data-testid={`mission-task-${task.id}`}
    >
      <div className="flex items-start gap-1.5">
        <span
          className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[task.status])}
          aria-hidden
        />
        <span className="line-clamp-2 flex-1 break-words text-[12px] font-medium leading-snug">
          {task.title}
        </span>
      </div>
      {task.assigneeSessionId ? (
        <div className="mt-1.5 truncate text-[10px] text-muted-foreground">
          Pane {task.assigneeSessionId.slice(0, 8)}
        </div>
      ) : null}
      {task.worktreePath ? (
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
          {task.worktreePath}
        </div>
      ) : null}
    </div>
  );
}
