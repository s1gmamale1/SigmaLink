// Kanban column. Receives drops via @dnd-kit/core's `useDroppable`; the
// dropped card's status moves to this column's status.

import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Task, TaskStatus } from '@/shared/types';
import { Card } from './Card';

interface Props {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  onCardClick?: (task: Task) => void;
  onAdd?: () => void;
  hint?: string;
}

export function Column(props: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: `col:${props.status}`,
    data: { status: props.status },
  });
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {props.label}
          </span>
          <span className="text-muted-foreground">{props.tasks.length}</span>
        </div>
        {props.onAdd ? (
          <button
            type="button"
            onClick={props.onAdd}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Add task"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex flex-1 flex-col gap-2 overflow-y-auto p-2 transition',
          isOver ? 'bg-primary/5' : '',
        )}
      >
        {props.tasks.length === 0 ? (
          <div className="rounded border border-dashed border-border/50 p-4 text-center text-[11px] text-muted-foreground">
            {props.hint ?? 'Drop here'}
          </div>
        ) : (
          props.tasks.map((t) => (
            <Card key={t.id} task={t} onClick={props.onCardClick} />
          ))
        )}
      </div>
    </div>
  );
}
