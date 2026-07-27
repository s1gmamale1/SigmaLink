import type { KeyboardCoordinateGetter } from '@dnd-kit/core';
import { paneRows } from '@/shared/pane-grid-shape';

const paneDragPrefix = 'pane-reorder:';
const paneDropPrefix = 'pane-slot:';

export type PaneArrowCode = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export function paneDragId(sessionId: string): string {
  return `${paneDragPrefix}${sessionId}`;
}

export function paneDropId(sessionId: string): string {
  return `${paneDropPrefix}${sessionId}`;
}

function sessionIdFromPrefixedId(id: unknown, prefix: string): string | null {
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const sessionId = id.slice(prefix.length);
  return sessionId.length > 0 ? sessionId : null;
}

export function sessionIdFromPaneDragId(id: unknown): string | null {
  return sessionIdFromPrefixedId(id, paneDragPrefix);
}

export function sessionIdFromPaneDropId(id: unknown): string | null {
  return sessionIdFromPrefixedId(id, paneDropPrefix);
}

export function paneTargetForArrow(
  sessionIds: readonly string[],
  currentSessionId: string,
  code: PaneArrowCode,
): string | null {
  const currentIndex = sessionIds.indexOf(currentSessionId);
  if (currentIndex === -1) return null;

  if (code === 'ArrowLeft') return sessionIds[currentIndex - 1] ?? null;
  if (code === 'ArrowRight') return sessionIds[currentIndex + 1] ?? null;

  const rows = paneRows([...sessionIds]);
  const rowIndex = rows.findIndex((row) => row.includes(currentSessionId));
  if (rowIndex === -1) return null;

  const currentRow = rows[rowIndex];
  const columnIndex = currentRow.indexOf(currentSessionId);
  const targetRow = rows[code === 'ArrowUp' ? rowIndex - 1 : rowIndex + 1];
  if (!targetRow) return null;

  return targetRow[Math.min(columnIndex, targetRow.length - 1)] ?? null;
}

function isPaneArrowCode(code: string): code is PaneArrowCode {
  return code === 'ArrowLeft' || code === 'ArrowRight' || code === 'ArrowUp' || code === 'ArrowDown';
}

export function createPaneKeyboardCoordinates(
  sessionIds: readonly string[],
): KeyboardCoordinateGetter {
  return (event, { active, currentCoordinates, context }) => {
    if (!isPaneArrowCode(event.code)) return currentCoordinates;

    const currentSessionId = context.over
      ? sessionIdFromPaneDropId(context.over.id)
      : sessionIdFromPaneDragId(active);
    if (!currentSessionId) return currentCoordinates;

    const targetSessionId = paneTargetForArrow(sessionIds, currentSessionId, event.code);
    if (!targetSessionId) return currentCoordinates;

    const targetRect = context.droppableRects.get(paneDropId(targetSessionId));
    if (!targetRect) return currentCoordinates;

    event.preventDefault();
    return {
      x: targetRect.left + targetRect.width / 2,
      y: targetRect.top + targetRect.height / 2,
    };
  };
}
