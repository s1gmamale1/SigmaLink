// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const droppableState = vi.hoisted(() => ({
  isOver: false,
  setNodeRef: vi.fn(),
  useDroppable: vi.fn(),
}));

vi.mock('@dnd-kit/core', () => ({
  useDroppable: (args: unknown) => {
    droppableState.useDroppable(args);
    return {
      isOver: droppableState.isOver,
      setNodeRef: droppableState.setNodeRef,
    };
  },
}));

import { PaneGridCell } from './PaneGridCell';

beforeEach(() => {
  droppableState.isOver = false;
  droppableState.setNodeRef.mockReset();
  droppableState.useDroppable.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderCell(
  overrides: Partial<React.ComponentProps<typeof PaneGridCell>> = {},
) {
  const onActivate = vi.fn();
  render(
    <PaneGridCell
      sessionId="session-2"
      reorderEnabled
      isReordering={false}
      isReorderSource={false}
      isActive={false}
      isFocused={false}
      isHidden={false}
      onActivate={onActivate}
      {...overrides}
    >
      <button type="button" data-pane-reorder-handle="true">
        grip
      </button>
      <div data-testid="terminal-content">terminal</div>
    </PaneGridCell>,
  );
  return { onActivate };
}

describe('PaneGridCell', () => {
  it('registers the pane slot with isolated reorder target metadata', () => {
    renderCell();

    expect(droppableState.useDroppable).toHaveBeenCalledWith({
      id: 'pane-slot:session-2',
      data: { kind: 'pane-reorder-target', sessionId: 'session-2' },
      disabled: false,
    });
    expect(droppableState.setNodeRef).toHaveBeenCalledWith(
      screen.getByTestId('pane-cell'),
    );
  });

  it('draws an inset 2px target ring without adding sizing or border classes', () => {
    droppableState.isOver = true;
    renderCell({ isReordering: true });

    const cell = screen.getByTestId('pane-cell');
    expect(cell.className).toMatch(/\bring-2\b/);
    expect(cell.className).toMatch(/\bring-inset\b/);
    expect(cell.className).not.toMatch(/\bborder-2\b|\bp-0?\.?5\b/);
    expect(cell.style.width).toBe('');
    expect(cell.style.height).toBe('');
  });

  it('dims only the reorder source and shields terminal hit testing during a reorder', () => {
    renderCell({ isReordering: true, isReorderSource: true });

    const cell = screen.getByTestId('pane-cell');
    expect(cell.getAttribute('data-pane-reorder-source')).toBe('true');
    expect(cell.className).toMatch(/\bopacity-\d+\b/);

    const shield = screen.getByTestId('pane-reorder-shield');
    expect(shield.getAttribute('aria-hidden')).toBe('true');
    expect(shield.className).toMatch(/\babsolute\b/);
    expect(shield.className).toMatch(/\binset-0\b/);
    expect(shield.className).toMatch(/\bz-30\b/);
    expect(shield.className).toMatch(/\bcursor-grabbing\b/);
  });

  it('does not activate a pane from the reorder handle, but activates pane body presses', () => {
    const { onActivate } = renderCell();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'grip' }));
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId('terminal-content'));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith('session-2');
  });

  it('preserves active, fullscreen, and hidden cell state while reorder is inactive', () => {
    renderCell({ isActive: true });
    let cell = screen.getByTestId('pane-cell');
    expect(cell.getAttribute('data-active')).toBe('true');
    expect(cell.className).toMatch(/\bsl-pane-active\b/);
    expect(cell.className).toContain('z-[1]');
    expect(cell.style.cssText).toBe('');
    expect(screen.queryByTestId('pane-reorder-shield')).toBeNull();

    cleanup();
    renderCell({ isFocused: true });
    cell = screen.getByTestId('pane-cell');
    expect(cell.style.position).toBe('absolute');
    expect(cell.style.inset).toBe('0px');
    expect(cell.style.zIndex).toBe('50');
    expect(cell.className).toMatch(/\bsl-pane-active\b/);

    cleanup();
    renderCell({ isHidden: true });
    cell = screen.getByTestId('pane-cell');
    expect(cell.getAttribute('data-bsp-hidden')).toBe('true');
    expect(cell.style.display).toBe('none');
    expect(cell.className).toMatch(/\bz-0\b/);
  });

  it('disables the drop target when reordering is unavailable', () => {
    renderCell({ reorderEnabled: false });

    expect(droppableState.useDroppable).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: true }),
    );
  });
});
