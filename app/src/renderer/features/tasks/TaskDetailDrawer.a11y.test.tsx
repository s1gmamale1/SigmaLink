// @vitest-environment jsdom
//
// FE-4 a11y — TaskDetailDrawer dialog accessibility.
// Verifies:
//   - The panel is an ARIA modal dialog (role + aria-modal + aria-labelledby)
//   - Initial focus lands inside the dialog (on the panel) when it opens
//   - Tab on the last focusable element wraps to the first (focus containment)
//   - Shift+Tab on the first focusable element wraps to the last
//   - Closing returns focus to the element that opened the drawer

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '@/shared/types';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    tasks: {
      listComments: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      addComment: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { TaskDetailDrawer } from './TaskDetailDrawer';

afterEach(() => {
  cleanup();
});

function makeTask(): Task {
  return {
    id: 't1',
    workspaceId: 'ws-1',
    title: 'Wire up the auth callback',
    description: 'details',
    status: 'backlog',
    assignedSessionId: null,
    assignedSwarmId: null,
    assignedSwarmAgentId: null,
    labels: ['bug'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
  };
}

/**
 * All Tab-order focusable elements inside the dialog, in DOM order. Mirrors
 * useFocusTrap's selector: every clause excludes `[tabindex="-1"]` so the
 * click-to-close backdrop scrim (a `<button tabindex="-1">`) and the panel
 * itself (`tabindex={-1}`) are NOT counted — making this set identical to what
 * the panel-scoped trap operates on.
 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

describe('TaskDetailDrawer — FE-4 a11y', () => {
  it('renders as an ARIA modal dialog with a label', () => {
    render(<TaskDetailDrawer open task={makeTask()} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('task-detail-drawer-title');
    expect(document.getElementById('task-detail-drawer-title')).not.toBeNull();
  });

  it('moves initial focus inside the dialog panel on open', async () => {
    render(<TaskDetailDrawer open task={makeTask()} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    // Initial focus is deferred via requestAnimationFrame to the panel
    // (tabIndex={-1}). Wait for it to land somewhere inside the dialog.
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active != null && dialog.contains(active)).toBe(true);
    });
  });

  it('Tab on the last focusable element wraps focus to the first', () => {
    render(<TaskDetailDrawer open task={makeTask()} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    const focusables = focusablesIn(dialog);
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab on the first focusable element wraps focus to the last', () => {
    render(<TaskDetailDrawer open task={makeTask()} onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    const focusables = focusablesIn(dialog);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the opener element when the drawer closes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);

    // Focus the opener while the drawer is still closed so the closed->open
    // transition captures it as the return-focus target.
    const { rerender } = render(
      <TaskDetailDrawer open={false} task={makeTask()} onClose={() => undefined} />,
    );
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    rerender(<TaskDetailDrawer open task={makeTask()} onClose={() => undefined} />);
    rerender(<TaskDetailDrawer open={false} task={makeTask()} onClose={() => undefined} />);
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });
});
