import { useDraggable } from '@dnd-kit/core';
import { GripVertical } from 'lucide-react';
import type { ReactNode } from 'react';
import { noDragStyle } from '@/renderer/lib/drag-region';
import { paneDragId } from './pane-reorder-navigation';

export interface PaneReorderHandleProps {
  sessionId: string;
  paneName: string;
  position: number;
  count: number;
  disabled: boolean;
}

export function PaneReorderHandle({
  sessionId,
  paneName,
  position,
  count,
  disabled,
}: PaneReorderHandleProps): ReactNode {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
  } = useDraggable({
    id: paneDragId(sessionId),
    data: { kind: 'pane-reorder', sessionId },
    disabled,
    attributes: { role: 'button', roleDescription: 'sortable pane' },
  });

  return (
    <button
      ref={(node) => {
        setNodeRef(node);
        setActivatorNodeRef(node);
      }}
      type="button"
      disabled={disabled}
      {...attributes}
      {...listeners}
      aria-label={`Reorder ${paneName}, position ${position} of ${count}`}
      data-pane-reorder-handle="true"
      data-session-id={sessionId}
      style={{ ...noDragStyle(), touchAction: 'none' }}
      className="flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded opacity-40 transition-opacity hover:opacity-100 active:cursor-grabbing focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-25"
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
