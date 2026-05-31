// @vitest-environment jsdom
//
// UX-3 — PromptDialog unit tests. Locks the async API: confirm fires with the
// entered value and closes; Enter submits; empty values are blocked when
// `requireValue` (the default); the field re-seeds with `defaultValue` on open.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PromptDialog } from './prompt-dialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function getDialog(): HTMLElement {
  return screen.getByRole('dialog');
}

describe('PromptDialog', () => {
  it('does not render its content when closed', () => {
    render(
      <PromptDialog open={false} onOpenChange={vi.fn()} title="Rename" onConfirm={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('seeds the input with defaultValue and confirms with the entered value', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PromptDialog
        open
        onOpenChange={onOpenChange}
        title="Rename note"
        label="Note name"
        defaultValue="alpha"
        onConfirm={onConfirm}
      />,
    );

    const dialog = getDialog();
    const input = within(dialog).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('alpha');

    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm/i }));

    expect(onConfirm).toHaveBeenCalledWith('beta');
    // Closes itself after confirm.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('submits on Enter (form submit)', async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog open onOpenChange={vi.fn()} title="Prompt" onConfirm={onConfirm} />,
    );
    const dialog = getDialog();
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(input.closest('form')!);
    expect(onConfirm).toHaveBeenCalledWith('hello');
  });

  it('blocks confirm when the value is empty (requireValue default)', () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog open onOpenChange={vi.fn()} title="Prompt" onConfirm={onConfirm} />,
    );
    const dialog = getDialog();
    const confirmBtn = within(dialog).getByRole('button', {
      name: /confirm/i,
    }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancel fires onCancel + onOpenChange(false) without confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PromptDialog
        open
        onOpenChange={onOpenChange}
        onCancel={onCancel}
        title="Prompt"
        defaultValue="x"
        onConfirm={onConfirm}
      />,
    );
    const dialog = getDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('allows empty confirm when requireValue is false', async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        open
        onOpenChange={vi.fn()}
        title="Prompt"
        requireValue={false}
        onConfirm={onConfirm}
      />,
    );
    const dialog = getDialog();
    const confirmBtn = within(dialog).getByRole('button', {
      name: /confirm/i,
    }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(''));
  });
});
