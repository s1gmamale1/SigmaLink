// P1a Task 6 — Mission kanban board. Columns are keyed by the 7
// MissionTaskStatus values, in the fixed order below (mirrors the state
// machine's forward progression, not alphabetical). Read-only in P1a — no
// drop targets; drag-to-reassign is optional P1b polish.

import { cn } from '@/lib/utils';
import type { MissionTask, MissionTaskStatus } from '@/shared/types';
import { MissionTaskCard } from './MissionTaskCard';

interface Props {
  tasks: MissionTask[];
  onTaskClick?: (task: MissionTask) => void;
  className?: string;
}

// Not exported: react-refresh/only-export-components forbids a component
// file from exporting anything but components. Nothing outside this file
// needs the column order today.
const MISSION_TASK_COLUMNS: ReadonlyArray<{ status: MissionTaskStatus; label: string }> = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'dispatched', label: 'Dispatched' },
  { status: 'working', label: 'Working' },
  { status: 'reviewing', label: 'Reviewing' },
  { status: 'needs_input', label: 'Needs Input' },
  { status: 'done', label: 'Done' },
  { status: 'blocked', label: 'Blocked' },
];

export function MissionBoard({ tasks, onTaskClick, className }: Props) {
  return (
    <div
      className={cn(
        'grid h-full min-h-0 auto-cols-[minmax(180px,1fr)] grid-flow-col gap-2 overflow-x-auto p-2',
        className,
      )}
      data-testid="mission-board"
    >
      {MISSION_TASK_COLUMNS.map(({ status, label }) => {
        const colTasks = tasks.filter((t) => t.status === status);
        return (
          <div
            key={status}
            className="flex h-full min-w-0 flex-col"
            data-testid={`mission-column-${status}`}
          >
            <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
              <span className="text-[10px] text-muted-foreground">{colTasks.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
              {colTasks.length === 0 ? (
                <div className="rounded border border-dashed border-border/50 p-3 text-center text-[11px] text-muted-foreground">
                  Empty
                </div>
              ) : (
                colTasks.map((t) => (
                  <MissionTaskCard key={t.id} task={t} onClick={onTaskClick} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
