// Draggable Kanban card. Uses @dnd-kit/core's `useDraggable` so the same card
// can be dropped onto a column or onto a swarm-roster slot — the parent
// (TasksRoom) interprets the drop target by id-prefix.
//
// When a drag is active the *original* card in the column is rendered as a
// faded placeholder (no transform — the DragOverlay owns the flying clone).

import { useDraggable } from '@dnd-kit/core';
import { Tag, User2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Task } from '@/shared/types';

interface Props {
  task: Task;
  onClick?: (task: Task) => void;
  /**
   * When true the card is rendered inside the DragOverlay (the "flying" clone).
   * It gets a slight tilt + elevated shadow and must NOT register drag handles
   * (the overlay is not itself draggable).
   */
  dragOverlay?: boolean;
}

export function Card({ task, onClick, dragOverlay }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `task:${task.id}`,
    data: { taskId: task.id },
  });

  return (
    <div
      // dragOverlay copies don't need a ref or drag handles — the overlay
      // manages its own position.
      ref={dragOverlay ? undefined : setNodeRef}
      {...(dragOverlay ? {} : attributes)}
      {...(dragOverlay ? {} : listeners)}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // Don't fire click when the user just finished a drag.
        if (isDragging) return;
        if (onClick) onClick(task);
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(task);
        }
      }}
      className={cn(
        'cursor-grab select-none rounded-md border border-border bg-card p-2 text-xs shadow-sm transition',
        'hover:border-primary/50',
        // Ghost: original card stays in place while the overlay flies.
        isDragging && !dragOverlay && 'opacity-20',
        // Overlay clone: slight tilt + lift to signal "in-flight".
        dragOverlay && 'rotate-1 border-primary shadow-lg',
      )}
    >
      <div className="text-sm font-medium leading-snug">{task.title}</div>
      {task.description ? (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
          {task.description}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
        {task.labels.slice(0, 4).map((l) => (
          <span
            key={l}
            className="flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-primary"
          >
            <Tag className="h-2.5 w-2.5" /> {l}
          </span>
        ))}
        {task.assignedSwarmAgentId ? (
          <span className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-500">
            <User2 className="h-2.5 w-2.5" /> swarm
          </span>
        ) : task.assignedSessionId ? (
          <span className="flex items-center gap-0.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">
            <User2 className="h-2.5 w-2.5" /> session
          </span>
        ) : null}
      </div>
    </div>
  );
}
