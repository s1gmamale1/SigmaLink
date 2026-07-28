import { useDroppable } from '@dnd-kit/core';
import type { MouseEvent, ReactNode } from 'react';
import { paneDropId } from './pane-reorder-navigation';

export interface PaneGridCellProps {
  sessionId: string;
  reorderEnabled: boolean;
  isReordering: boolean;
  isReorderSource: boolean;
  isActive: boolean;
  isFocused: boolean;
  isHidden: boolean;
  onActivate: (sessionId: string) => void;
  children: ReactNode;
}

export function PaneGridCell({
  sessionId,
  reorderEnabled,
  isReordering,
  isReorderSource,
  isActive,
  isFocused,
  isHidden,
  onActivate,
  children,
}: PaneGridCellProps): ReactNode {
  const { isOver, setNodeRef } = useDroppable({
    id: paneDropId(sessionId),
    data: { kind: 'pane-reorder-target', sessionId },
    disabled: !reorderEnabled,
  });

  const handleMouseDownCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest('[data-pane-reorder-handle]')
    ) {
      return;
    }
    onActivate(sessionId);
  };

  return (
    <div
      ref={setNodeRef}
      data-testid="pane-cell"
      data-session-id={sessionId}
      data-active={isActive ? 'true' : undefined}
      data-bsp-hidden={isHidden ? 'true' : undefined}
      data-pane-reorder-source={isReorderSource ? 'true' : undefined}
      onMouseDownCapture={handleMouseDownCapture}
      className={[
        'relative min-h-0 min-w-0 overflow-hidden bg-card',
        isActive || isFocused ? 'sl-pane-active z-[1]' : 'z-0',
        isReordering && isOver ? 'ring-2 ring-inset ring-ring' : '',
        isReorderSource ? 'opacity-50' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        isFocused
          ? { position: 'absolute', inset: 0, zIndex: 50 }
          : isHidden
            ? { display: 'none' }
            : undefined
      }
    >
      {children}
      {isReordering ? (
        <div
          aria-hidden="true"
          data-testid="pane-reorder-shield"
          className="absolute inset-0 z-30 cursor-grabbing"
        />
      ) : null}
    </div>
  );
}
