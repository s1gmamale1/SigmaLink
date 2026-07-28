// @vitest-environment jsdom

import { DndContext } from '@dnd-kit/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/renderer/lib/drag-region', () => ({
  noDragStyle: () => ({ WebkitAppRegion: 'no-drag' }),
}));

import { PaneReorderHandle } from './PaneReorderHandle';

afterEach(() => {
  cleanup();
});

function renderHandle(
  overrides: Partial<React.ComponentProps<typeof PaneReorderHandle>> = {},
  onDragStart = vi.fn(),
) {
  render(
    <DndContext onDragStart={onDragStart}>
      <PaneReorderHandle
        sessionId="s2"
        paneName="Claude Alpha"
        position={2}
        count={5}
        disabled={false}
        {...overrides}
      />
    </DndContext>,
  );

  return { onDragStart };
}

describe('PaneReorderHandle', () => {
  it('renders a marked, accessible drag activator with pane metadata', () => {
    renderHandle();

    const grip = screen.getByRole('button', {
      name: 'Reorder Claude Alpha, position 2 of 5',
    });
    expect(grip.getAttribute('data-pane-reorder-handle')).toBe('true');
    expect(grip.getAttribute('data-session-id')).toBe('s2');
    expect(grip.style.touchAction).toBe('none');
    expect(
      (grip.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion,
    ).toBe('no-drag');
    expect(grip.getAttribute('draggable')).not.toBe('true');
  });

  it('reflects disabled state in both the native button and dnd-kit attributes', () => {
    renderHandle({ disabled: true });

    const grip = screen.getByRole('button', {
      name: 'Reorder Claude Alpha, position 2 of 5',
    });
    expect((grip as HTMLButtonElement).disabled).toBe(true);
    expect(grip.getAttribute('aria-disabled')).toBe('true');
  });

  it.each([
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('leaves %s activation wired to dnd-kit', async (_name, key) => {
    const onDragStart = vi.fn();
    renderHandle({}, onDragStart);

    const grip = screen.getByRole('button', {
      name: 'Reorder Claude Alpha, position 2 of 5',
    });
    fireEvent.keyDown(grip, { key, code: key === ' ' ? 'Space' : 'Enter' });

    await waitFor(() => {
      expect(onDragStart).toHaveBeenCalledWith(
        expect.objectContaining({ active: expect.objectContaining({ id: 'pane-reorder:s2' }) }),
      );
    });
  });
});
