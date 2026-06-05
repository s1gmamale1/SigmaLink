// @vitest-environment jsdom
//
// BSP-G1 — CreateWorktreeModal unit coverage.
//
// Tested invariants:
//   1. Modal renders with the correct data-testids.
//   2. Submit is disabled when branch name is empty.
//   3. Submit is enabled when branch name is non-empty.
//   4. Clicking Create calls rpc.git.worktreeCreate with correct args.
//   5. On success: toast.success is shown and the modal closes.
//   6. On failure: toast.error is shown and the modal stays open.
//   7. Base ref is optional — omitted when empty.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';

// ── mocks ──────────────────────────────────────────────────────────────────

const worktreeCreateMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    git: {
      worktreeCreate: (...args: unknown[]) => worktreeCreateMock(...args),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: vi.fn(),
  },
}));

// ── polyfills for Radix Dialog ──────────────────────────────────────────────

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;
});

beforeEach(() => {
  worktreeCreateMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  cleanup();
});

// ── helpers ────────────────────────────────────────────────────────────────

function renderModal(
  open = true,
  onOpenChange = vi.fn(),
  repoRoot = '/repo/root',
) {
  return import('./CreateWorktreeModal').then(({ CreateWorktreeModal }) =>
    render(
      <CreateWorktreeModal
        open={open}
        onOpenChange={onOpenChange}
        repoRoot={repoRoot}
      />,
    ),
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('CreateWorktreeModal — render', () => {
  it('renders the modal with correct data-testids when open=true', async () => {
    await renderModal();
    expect(screen.getByTestId('create-worktree-modal')).toBeTruthy();
    expect(screen.getByTestId('cwt-branch')).toBeTruthy();
    expect(screen.getByTestId('cwt-base')).toBeTruthy();
    expect(screen.getByTestId('cwt-submit')).toBeTruthy();
  });

  it('does not render the modal content when open=false', async () => {
    await renderModal(false);
    expect(screen.queryByTestId('create-worktree-modal')).toBeNull();
  });
});

describe('CreateWorktreeModal — validation', () => {
  it('submit is disabled when branch name is empty', async () => {
    await renderModal();
    const submit = screen.getByTestId('cwt-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('submit is enabled when branch name is non-empty', async () => {
    await renderModal();
    const branchInput = screen.getByTestId('cwt-branch');
    fireEvent.change(branchInput, { target: { value: 'feature/test' } });
    const submit = screen.getByTestId('cwt-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('submit stays disabled when branch name is only whitespace', async () => {
    await renderModal();
    const branchInput = screen.getByTestId('cwt-branch');
    fireEvent.change(branchInput, { target: { value: '   ' } });
    const submit = screen.getByTestId('cwt-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe('CreateWorktreeModal — RPC call', () => {
  it('calls rpc.git.worktreeCreate with repoRoot and hint on submit', async () => {
    worktreeCreateMock.mockResolvedValue({
      worktreePath: '/repo/root/.wt/feature-test',
      branch: 'feature/test',
    });
    const onOpenChange = vi.fn();
    await renderModal(true, onOpenChange);

    fireEvent.change(screen.getByTestId('cwt-branch'), {
      target: { value: 'feature/test' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('cwt-submit'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(worktreeCreateMock).toHaveBeenCalledWith({
        repoRoot: '/repo/root',
        hint: 'feature/test',
      });
    });
  });

  it('passes base ref when provided', async () => {
    worktreeCreateMock.mockResolvedValue({
      worktreePath: '/repo/root/.wt/feature-test',
      branch: 'feature/test',
    });
    await renderModal();

    fireEvent.change(screen.getByTestId('cwt-branch'), {
      target: { value: 'feature/test' },
    });
    fireEvent.change(screen.getByTestId('cwt-base'), {
      target: { value: 'main' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('cwt-submit'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(worktreeCreateMock).toHaveBeenCalledWith({
        repoRoot: '/repo/root',
        hint: 'feature/test',
        base: 'main',
      });
    });
  });

  it('omits base when the base field is empty', async () => {
    worktreeCreateMock.mockResolvedValue({
      worktreePath: '/wt/branch',
      branch: 'branch',
    });
    await renderModal();

    fireEvent.change(screen.getByTestId('cwt-branch'), {
      target: { value: 'branch' },
    });
    // base stays empty

    await act(async () => {
      fireEvent.click(screen.getByTestId('cwt-submit'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(worktreeCreateMock).toHaveBeenCalledWith({
        repoRoot: '/repo/root',
        hint: 'branch',
        // base absent
      });
    });
    // Confirm no `base` key was passed
    const call = worktreeCreateMock.mock.calls[0][0] as Record<string, unknown>;
    expect('base' in call).toBe(false);
  });
});

describe('CreateWorktreeModal — success / error', () => {
  it('shows toast.success and closes modal on success', async () => {
    worktreeCreateMock.mockResolvedValue({
      worktreePath: '/repo/.wt/my-branch',
      branch: 'my-branch',
    });
    const onOpenChange = vi.fn();
    await renderModal(true, onOpenChange);

    fireEvent.change(screen.getByTestId('cwt-branch'), {
      target: { value: 'my-branch' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('cwt-submit'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Worktree created',
        expect.objectContaining({ description: expect.stringContaining('my-branch') }),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows toast.error and keeps modal open on failure', async () => {
    worktreeCreateMock.mockRejectedValue(new Error('git error'));
    const onOpenChange = vi.fn();
    await renderModal(true, onOpenChange);

    fireEvent.change(screen.getByTestId('cwt-branch'), {
      target: { value: 'bad-branch' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('cwt-submit'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Failed to create worktree',
        expect.objectContaining({ description: 'git error' }),
      );
      // modal stays open
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
  });
});
