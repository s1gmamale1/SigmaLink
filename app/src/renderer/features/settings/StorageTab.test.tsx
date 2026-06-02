// @vitest-environment jsdom
//
// DB-2 — StorageTab: Database backup/restore section tests.
// Covers: backup button calls export_db + success toast on ok;
//         restore button shows confirm dialog, calls import_db only after confirm;
//         import ok → reloads; canceled import → no error toast; error paths.
//         Existing worktree section: renders without crash.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// vi.hoisted() — declare mock fns BEFORE any vi.mock() factory references them.
// vi.mock factories are hoisted to the top of the file by Vitest's transformer,
// so any variable they close over must also be hoisted.
// ---------------------------------------------------------------------------

const {
  exportDbMock,
  importDbMock,
  toastSuccess,
  toastError,
  reloadMock,
} = vi.hoisted(() => ({
  exportDbMock: vi.fn<() => Promise<{ ok: boolean; canceled?: boolean; path?: string }>>(),
  importDbMock: vi.fn<() => Promise<{ ok: boolean; canceled?: boolean }>>(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  reloadMock: vi.fn(),
}));

// Stub window.location.reload — must run at module scope (before renders).
Object.defineProperty(window, 'location', {
  value: { reload: reloadMock },
  writable: true,
});

// ---------------------------------------------------------------------------
// RPC mock
// ---------------------------------------------------------------------------

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    memory: {
      export_db: exportDbMock,
      import_db: importDbMock,
    },
    fs: {
      getWorktreeSizes: vi.fn().mockResolvedValue({ worktrees: [], totalBytes: 0 }),
    },
    app: {
      getUserDataPath: vi.fn().mockResolvedValue('/userData'),
      revealInFolder: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// ---------------------------------------------------------------------------
// sonner mock
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

// convenience aliases used in tests
const toastMocks = { success: toastSuccess, error: toastError };

// ---------------------------------------------------------------------------
// alert-dialog stub — lightweight inline stubs so we don't depend on Radix
// Portal / window.matchMedia in jsdom. The AlertDialog renders its children
// only when `open` is true, inside a div with role="alertdialog".
// ---------------------------------------------------------------------------

vi.mock('@/components/ui/alert-dialog', () => {
  const AlertDialog = ({
    open,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (o: boolean) => void;
    children?: React.ReactNode;
  }) => (open ? React.createElement('div', { role: 'alertdialog' }, children) : null);

  const passthrough =
    (tag: string) =>
    ({ children, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) =>
      React.createElement(tag, props, children);

  const AlertDialogContent = passthrough('div');
  const AlertDialogHeader = passthrough('div');
  const AlertDialogFooter = passthrough('div');
  const AlertDialogTitle = passthrough('h2');
  const AlertDialogDescription = passthrough('p');

  const AlertDialogAction = ({
    children,
    onClick,
    className,
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) =>
    React.createElement('button', { onClick, className }, children);

  const AlertDialogCancel = ({
    children,
    onClick,
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) =>
    React.createElement('button', { onClick }, children);

  return {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogFooter,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogAction,
    AlertDialogCancel,
  };
});

// ---------------------------------------------------------------------------
// button stub — plain <button> forwarding data-* and disabled.
// ---------------------------------------------------------------------------

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) =>
    React.createElement('button', { onClick, disabled, ...props }, children),
}));

// ---------------------------------------------------------------------------
// lucide-react stub — noop icon components (avoid SVG rendering complexity).
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    FolderOpen: Icon,
    HardDrive: Icon,
    Loader2: Icon,
    Database: Icon,
  };
});

// ---------------------------------------------------------------------------
// Component import — must come AFTER all vi.mock() calls.
// ---------------------------------------------------------------------------

import { StorageTab } from './StorageTab';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function waitForRestoreDialog(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = screen.getByRole('alertdialog');
    return el;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageTab — Database section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders backup and restore buttons', async () => {
    render(React.createElement(StorageTab));
    const backupBtn = await screen.findByTestId('db-backup-btn');
    const restoreBtn = screen.getByTestId('db-restore-btn');
    expect(backupBtn).toBeTruthy();
    expect(restoreBtn).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Backup
  // -------------------------------------------------------------------------

  describe('Back up database', () => {
    it('calls export_db and shows success toast with path on ok', async () => {
      exportDbMock.mockResolvedValueOnce({ ok: true, path: '/backups/sigma.db' });
      render(React.createElement(StorageTab));

      const btn = await screen.findByTestId('db-backup-btn');
      fireEvent.click(btn);

      await waitFor(() => expect(exportDbMock).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(toastMocks.success).toHaveBeenCalledWith('Backed up to /backups/sigma.db'),
      );
      expect(toastMocks.error).not.toHaveBeenCalled();
    });

    it('shows no toast when export_db is canceled', async () => {
      exportDbMock.mockResolvedValueOnce({ ok: false, canceled: true });
      render(React.createElement(StorageTab));

      fireEvent.click(await screen.findByTestId('db-backup-btn'));

      await waitFor(() => expect(exportDbMock).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(toastMocks.success).not.toHaveBeenCalled();
      expect(toastMocks.error).not.toHaveBeenCalled();
    });

    it('shows error toast when export_db throws', async () => {
      exportDbMock.mockRejectedValueOnce(new Error('disk full'));
      render(React.createElement(StorageTab));

      fireEvent.click(await screen.findByTestId('db-backup-btn'));

      await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('disk full'));
    });
  });

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  describe('Restore from backup', () => {
    it('opens the confirm dialog when restore button is clicked', async () => {
      render(React.createElement(StorageTab));

      fireEvent.click(await screen.findByTestId('db-restore-btn'));

      await waitForRestoreDialog();
      expect(importDbMock).not.toHaveBeenCalled();
    });

    it('does NOT call import_db if the dialog is canceled', async () => {
      render(React.createElement(StorageTab));

      fireEvent.click(await screen.findByTestId('db-restore-btn'));
      await waitForRestoreDialog();

      const cancelBtn = screen.getByRole('button', { name: /cancel/i });
      fireEvent.click(cancelBtn);

      await new Promise((r) => setTimeout(r, 20));
      expect(importDbMock).not.toHaveBeenCalled();
      expect(toastMocks.error).not.toHaveBeenCalled();
    });

    it('calls import_db after confirm and reloads on ok', async () => {
      importDbMock.mockResolvedValueOnce({ ok: true });
      render(React.createElement(StorageTab));

      fireEvent.click(await screen.findByTestId('db-restore-btn'));
      await waitForRestoreDialog();

      const confirmBtn = screen.getByRole('button', { name: /^restore$/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => expect(importDbMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(toastMocks.success).toHaveBeenCalled());
      await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    });

    it('does not reload or error when import_db is canceled', async () => {
      importDbMock.mockResolvedValueOnce({ ok: false, canceled: true });
      render(React.createElement(StorageTab));

      fireEvent.click(await screen.findByTestId('db-restore-btn'));
      await waitForRestoreDialog();

      const confirmBtn = screen.getByRole('button', { name: /^restore$/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => expect(importDbMock).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(toastMocks.error).not.toHaveBeenCalled();
      expect(reloadMock).not.toHaveBeenCalled();
    });

    it('shows error toast and does not reload when import_db throws', async () => {
      importDbMock.mockRejectedValueOnce(new Error('bad file'));
      render(React.createElement(StorageTab));

      fireEvent.click(await screen.findByTestId('db-restore-btn'));
      await waitForRestoreDialog();

      const confirmBtn = screen.getByRole('button', { name: /^restore$/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('bad file'));
      expect(reloadMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Worktree section (smoke — must still render without crash)
  // -------------------------------------------------------------------------

  it('still renders the db-backup-btn and db-restore-btn without crash', async () => {
    render(React.createElement(StorageTab));
    // Both DB buttons render → component mounts without error
    await screen.findByTestId('db-backup-btn');
    expect(screen.getByTestId('db-restore-btn')).toBeTruthy();
  });
});
