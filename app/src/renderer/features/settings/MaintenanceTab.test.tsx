// @vitest-environment jsdom
//
// SF-13 — MaintenanceTab UI tests.
// Tests: workspaces render, button presence, dry-run preview, confirm gate,
// confirm cancel = no mutation, confirm ok = RPC call, error handling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// RPC mock — set up before the component loads.
// ---------------------------------------------------------------------------

const mockWorkspaces = [
  { id: 'ws-1', name: 'ProjectA', rootPath: '/projects/a', repoMode: 'git', repoRoot: '/projects/a' },
  { id: 'ws-2', name: 'ProjectB', rootPath: '/projects/b', repoMode: 'plain', repoRoot: null },
];

const rpcMocks = {
  workspaces: {
    list: vi.fn<() => Promise<typeof mockWorkspaces>>(async () => mockWorkspaces),
  },
  'cleanup.removeWorkspace': vi.fn(),
  'cleanup.clearPanes': vi.fn(),
  'cleanup.pruneWorktrees': vi.fn(),
};

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key in rpcMocks) return rpcMocks[key as keyof typeof rpcMocks];
      return undefined;
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// window.confirm mock — default: cancel (false). Override per-test.
// ---------------------------------------------------------------------------

const confirmMock = vi.fn<() => boolean>(() => false);
Object.defineProperty(window, 'confirm', { value: confirmMock, writable: true });

// SF-13/SF-9-integration — the component now calls the `cleanup.*` side-band via
// `window.sigma.invoke(channel, arg)` (not the typed rpc proxy) and unwraps the
// {ok,data} envelope. Route invoke → the existing per-channel mocks below so all
// their `.mockImplementation`/`.mockResolvedValueOnce`/`toHaveBeenCalledWith`
// assertions keep working unchanged; a thrown mock surfaces as a rejected invoke.
const sigmaInvokeMock = vi.fn(async (channel: string, arg: unknown) => {
  const fn = (rpcMocks as unknown as Record<string, (a: unknown) => unknown>)[channel];
  if (typeof fn !== 'function') throw new Error(`unmocked side-band channel: ${channel}`);
  return { ok: true as const, data: await fn(arg) };
});
Object.defineProperty(window, 'sigma', {
  value: { invoke: sigmaInvokeMock },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Lazy import to respect vi.mock hoisting.
// ---------------------------------------------------------------------------

async function renderTab() {
  vi.resetModules();
  const { MaintenanceTab } = await import('./MaintenanceTab');
  render(<MaintenanceTab />);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockReturnValue(false);

  // Default dry-run responses
  rpcMocks['cleanup.removeWorkspace'].mockImplementation(
    async (args: { workspaceId: string; dryRun: boolean }) => {
      if (args.dryRun) {
        return { sessionCount: 2, worktreeCount: 1, liveBlockedWorktrees: [] };
      }
      return { sessionCount: 2, worktreeCount: 1, liveBlockedWorktrees: [] };
    },
  );
  rpcMocks['cleanup.clearPanes'].mockImplementation(
    async (args: { workspaceId: string; dryRun: boolean }) => {
      if (args.dryRun) return { sessionIds: ['s1', 's2'], deleted: 0 };
      return { sessionIds: [], deleted: 2 };
    },
  );
  rpcMocks['cleanup.pruneWorktrees'].mockImplementation(
    async (args: { workspaceId: string; dryRun: boolean }) => {
      if (args.dryRun) return { wouldRemove: ['/wt/a', '/wt/b'], liveBlocked: [] };
      return { removed: 2, liveBlocked: [], errors: 0 };
    },
  );
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MaintenanceTab — rendering', () => {
  it('renders workspace rows after loading', async () => {
    await renderTab();

    await waitFor(() => {
      expect(screen.getByText('ProjectA')).toBeDefined();
      expect(screen.getByText('ProjectB')).toBeDefined();
    });
  });

  it('shows "Clear panes" button for every workspace', async () => {
    await renderTab();
    await waitFor(() => {
      const buttons = screen.getAllByText('Clear panes');
      expect(buttons).toHaveLength(2);
    });
  });

  it('shows "Prune orphan worktrees" only for git repos', async () => {
    await renderTab();
    await waitFor(() => {
      // ws-1 is git, ws-2 is plain — only 1 prune button should appear
      const pruneButtons = screen.getAllByText('Prune orphan worktrees');
      expect(pruneButtons).toHaveLength(1);
    });
  });

  it('shows "Remove workspace" for every workspace', async () => {
    await renderTab();
    await waitFor(() => {
      const removeButtons = screen.getAllByText('Remove workspace');
      expect(removeButtons).toHaveLength(2);
    });
  });
});

describe('MaintenanceTab — remove workspace', () => {
  it('calls dry-run first, then no mutation when user cancels', async () => {
    confirmMock.mockReturnValue(false);
    await renderTab();

    await waitFor(() => screen.getAllByText('Remove workspace'));
    const [removeBtn] = screen.getAllByTestId(/maintenance-remove-ws-ws-1/);
    fireEvent.click(removeBtn);

    // Dry-run call
    await waitFor(() => {
      expect(rpcMocks['cleanup.removeWorkspace']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: true,
      });
    });

    // Confirm dialog shown
    expect(confirmMock).toHaveBeenCalled();

    // No live mutation
    expect(rpcMocks['cleanup.removeWorkspace']).not.toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      dryRun: false,
    });
  });

  it('calls live mutation when user confirms', async () => {
    confirmMock.mockReturnValue(true);
    await renderTab();

    await waitFor(() => screen.getAllByText('Remove workspace'));
    const [removeBtn] = screen.getAllByTestId(/maintenance-remove-ws-ws-1/);
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(rpcMocks['cleanup.removeWorkspace']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: false,
      });
    });
  });
});

describe('MaintenanceTab — clear panes', () => {
  it('shows dry-run session count in confirm then cancels cleanly', async () => {
    confirmMock.mockReturnValue(false);
    await renderTab();

    await waitFor(() => screen.getAllByText('Clear panes'));
    const [clearBtn] = screen.getAllByTestId(/maintenance-clear-panes-ws-1/);
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(rpcMocks['cleanup.clearPanes']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: true,
      });
    });
    expect(confirmMock).toHaveBeenCalled();
    // No live delete
    expect(rpcMocks['cleanup.clearPanes']).not.toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      dryRun: false,
    });
  });

  it('calls live delete when confirmed', async () => {
    confirmMock.mockReturnValue(true);
    await renderTab();

    await waitFor(() => screen.getAllByText('Clear panes'));
    const [clearBtn] = screen.getAllByTestId(/maintenance-clear-panes-ws-1/);
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(rpcMocks['cleanup.clearPanes']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: false,
      });
    });
  });

  it('shows a success toast (not confirm) when no sessions found', async () => {
    rpcMocks['cleanup.clearPanes'].mockResolvedValueOnce({ sessionIds: [], deleted: 0 });
    const { toast } = await import('sonner');
    await renderTab();

    await waitFor(() => screen.getAllByText('Clear panes'));
    const [clearBtn] = screen.getAllByTestId(/maintenance-clear-panes-ws-1/);
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(confirmMock).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalled();
    });
  });
});

describe('MaintenanceTab — prune worktrees', () => {
  it('does not show prune button for plain (non-git) workspace', async () => {
    await renderTab();
    await waitFor(() => screen.getAllByText('ProjectB'));

    // ws-2 is plain — its prune button should not exist
    const pruneBtns = screen.queryAllByTestId(/maintenance-prune-worktrees-ws-2/);
    expect(pruneBtns).toHaveLength(0);
  });

  it('calls dry-run, shows confirm, no mutation on cancel', async () => {
    confirmMock.mockReturnValue(false);
    await renderTab();

    await waitFor(() => screen.getAllByText('Prune orphan worktrees'));
    const [pruneBtn] = screen.getAllByTestId(/maintenance-prune-worktrees-ws-1/);
    fireEvent.click(pruneBtn);

    await waitFor(() => {
      expect(rpcMocks['cleanup.pruneWorktrees']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: true,
      });
    });
    expect(confirmMock).toHaveBeenCalled();
    expect(rpcMocks['cleanup.pruneWorktrees']).not.toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      dryRun: false,
    });
  });

  it('calls live prune on confirm', async () => {
    confirmMock.mockReturnValue(true);
    await renderTab();

    await waitFor(() => screen.getAllByText('Prune orphan worktrees'));
    const [pruneBtn] = screen.getAllByTestId(/maintenance-prune-worktrees-ws-1/);
    fireEvent.click(pruneBtn);

    await waitFor(() => {
      expect(rpcMocks['cleanup.pruneWorktrees']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: false,
      });
    });
  });

  it('shows success toast when no orphans found', async () => {
    rpcMocks['cleanup.pruneWorktrees'].mockResolvedValueOnce({
      wouldRemove: [],
      liveBlocked: [],
    });
    const { toast } = await import('sonner');
    await renderTab();

    await waitFor(() => screen.getAllByText('Prune orphan worktrees'));
    const [pruneBtn] = screen.getAllByTestId(/maintenance-prune-worktrees-ws-1/);
    fireEvent.click(pruneBtn);

    await waitFor(() => {
      expect(confirmMock).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalled();
    });
  });
});

describe('MaintenanceTab — error handling', () => {
  it('shows error toast when RPC throws during dry-run', async () => {
    rpcMocks['cleanup.clearPanes'].mockRejectedValueOnce(new Error('DB locked'));
    const { toast } = await import('sonner');
    await renderTab();

    await waitFor(() => screen.getAllByText('Clear panes'));
    const [clearBtn] = screen.getAllByTestId(/maintenance-clear-panes-ws-1/);
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('DB locked');
    });
    // No confirm shown for a failed dry-run
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
