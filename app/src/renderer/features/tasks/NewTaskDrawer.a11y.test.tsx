// @vitest-environment jsdom
//
// FE-4 a11y — NewTaskDrawer dialog accessibility.
// Verifies:
//   - The panel is an ARIA modal dialog (role + aria-modal + aria-labelledby)
//   - Tab on the last focusable element wraps to the first (focus containment)
//   - Shift+Tab on the first focusable element wraps to the last
//   - Closing returns focus to the element that opened the drawer

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Drawer talks to the IPC bridge on submit; stub it so render is side-effect free.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    tasks: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { NewTaskDrawer } from './NewTaskDrawer';

afterEach(() => {
  cleanup();
});

function renderOpen() {
  return render(
    <NewTaskDrawer
      open
      workspaceId="ws-1"
      onClose={() => undefined}
      onCreated={() => undefined}
    />,
  );
}

/**
 * All Tab-order focusable elements inside the dialog, in DOM order. Mirrors
 * useFocusTrap's selector: every clause excludes `[tabindex="-1"]` so the
 * click-to-close backdrop scrim (a `<button tabindex="-1">`) is NOT counted —
 * which makes this set identical to what the panel-scoped trap operates on.
 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

describe('NewTaskDrawer — FE-4 a11y', () => {
  it('renders as an ARIA modal dialog with a label', () => {
    renderOpen();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('new-task-drawer-title');
    // The labelledby target exists.
    expect(document.getElementById('new-task-drawer-title')).not.toBeNull();
  });

  it('Tab on the last focusable element wraps focus to the first', () => {
    renderOpen();
    const dialog = screen.getByRole('dialog');
    const focusables = focusablesIn(dialog);
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    expect(document.activeElement).toBe(last);
    // Trap listener is on the panel (capture phase) — dispatch on the panel.
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab on the first focusable element wraps focus to the last', () => {
    renderOpen();
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
    // An external trigger button receives focus first, THEN the drawer opens —
    // mirroring the real flow where a button opens the drawer. The drawer
    // captures document.activeElement on the closed->open transition, so the
    // opener must be focused while the drawer is still closed.
    const trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);

    const { rerender } = render(
      <NewTaskDrawer open={false} workspaceId="ws-1" onClose={() => undefined} />,
    );
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Open: captures `trigger` as the return-focus target.
    rerender(<NewTaskDrawer open workspaceId="ws-1" onClose={() => undefined} />);
    // Close: the open->closed transition runs the return-focus effect.
    rerender(
      <NewTaskDrawer open={false} workspaceId="ws-1" onClose={() => undefined} />,
    );
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });
});
