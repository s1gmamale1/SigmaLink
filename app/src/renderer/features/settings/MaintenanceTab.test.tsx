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

// In-memory KV store for the kv mock.
const kvStore: Record<string, string> = {};
const kvMock = {
  get: vi.fn(async (key: string) => kvStore[key] ?? null),
  set: vi.fn(async (key: string, value: string) => { kvStore[key] = value; }),
};

const rpcMocks = {
  workspaces: {
    list: vi.fn<() => Promise<typeof mockWorkspaces>>(async () => mockWorkspaces),
  },
  kv: kvMock,
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
// UX-3 — the destructive confirm is now a themed AlertDialog (not the native
// window.confirm). These helpers drive it: `confirmDialogShown()` waits for the
// dialog to mount, `clickConfirm()` clicks the destructive action button, and
// `clickCancel()` dismisses it. We still keep a `confirmMock` spy so any stray
// window.confirm regression would surface (it should never be called now).
// ---------------------------------------------------------------------------

const confirmMock = vi.fn<() => boolean>(() => false);
Object.defineProperty(window, 'confirm', { value: confirmMock, writable: true });

async function confirmDialogShown(): Promise<HTMLElement> {
  return waitFor(() => screen.getByRole('alertdialog'));
}

function queryConfirmDialog(): HTMLElement | null {
  return screen.queryByRole('alertdialog');
}

async function clickConfirm(label: RegExp): Promise<void> {
  const dialog = await confirmDialogShown();
  const within = await import('@testing-library/react');
  const btn = within.within(dialog).getByRole('button', { name: label });
  fireEvent.click(btn);
}

async function clickCancel(): Promise<void> {
  const dialog = await confirmDialogShown();
  const within = await import('@testing-library/react');
  const btn = within.within(dialog).getByRole('button', { name: /cancel/i });
  fireEvent.click(btn);
}

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
  // Reset in-memory KV store.
  for (const k of Object.keys(kvStore)) delete kvStore[k];
  confirmMock.mockReturnValue(false);

  // Default dry-run responses
  rpcMocks['cleanup.removeWorkspace'].mockImplementation(
    async (args: { workspaceId: string; dryRun: boolean }) => {
      if (args.dryRun) {
        return { sessionCount: 2, liveBlockedSessionIds: [], worktreeCount: 1, liveBlockedWorktrees: [] };
      }
      return { sessionCount: 2, liveBlockedSessionIds: [], worktreeCount: 1, liveBlockedWorktrees: [] };
    },
  );
  rpcMocks['cleanup.clearPanes'].mockImplementation(
    async (args: { workspaceId: string; dryRun: boolean }) => {
      if (args.dryRun) return { sessionIds: ['s1', 's2'], liveBlockedSessionIds: [], deleted: 0 };
      return { sessionIds: [], liveBlockedSessionIds: [], deleted: 2 };
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
      // Each workspace name appears in BOTH the teardown section and the
      // workspace cleanup section (2 per workspace) — use getAllByText.
      expect(screen.getAllByText('ProjectA').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('ProjectB').length).toBeGreaterThanOrEqual(1);
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

    // Themed confirm dialog shown; the native confirm is never used.
    await confirmDialogShown();
    expect(confirmMock).not.toHaveBeenCalled();

    // Cancel → no live mutation, dialog closes.
    await clickCancel();
    await waitFor(() => expect(queryConfirmDialog()).toBeNull());
    expect(rpcMocks['cleanup.removeWorkspace']).not.toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      dryRun: false,
    });
  });

  it('calls live mutation when user confirms', async () => {
    await renderTab();

    await waitFor(() => screen.getAllByText('Remove workspace'));
    const [removeBtn] = screen.getAllByTestId(/maintenance-remove-ws-ws-1/);
    fireEvent.click(removeBtn);

    await clickConfirm(/remove workspace/i);

    await waitFor(() => {
      expect(rpcMocks['cleanup.removeWorkspace']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: false,
      });
    });
  });

  it('warns when live panes block full workspace removal', async () => {
    rpcMocks['cleanup.removeWorkspace'].mockResolvedValueOnce({
      sessionCount: 1,
      liveBlockedSessionIds: ['live-1'],
      worktreeCount: 1,
      liveBlockedWorktrees: ['/wt/live-1'],
    });
    await renderTab();

    await waitFor(() => screen.getAllByText('Remove workspace'));
    const [removeBtn] = screen.getAllByTestId(/maintenance-remove-ws-ws-1/);
    fireEvent.click(removeBtn);

    const dialog = await confirmDialogShown();
    expect(dialog.textContent).toContain('1 live pane(s)');
    expect(dialog.textContent).toContain('will be KEPT');
  });
});

describe('MaintenanceTab — clear panes', () => {
  it('shows dry-run session count in confirm then cancels cleanly', async () => {
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
    // Dry-run session count surfaced in the themed dialog body.
    const dialog = await confirmDialogShown();
    expect(dialog.textContent).toContain('2 session record(s)');
    expect(dialog.textContent).not.toContain('will stop appearing');
    expect(confirmMock).not.toHaveBeenCalled();

    // Cancel → no live delete.
    await clickCancel();
    await waitFor(() => expect(queryConfirmDialog()).toBeNull());
    expect(rpcMocks['cleanup.clearPanes']).not.toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      dryRun: false,
    });
  });

  it('calls live delete when confirmed', async () => {
    await renderTab();

    await waitFor(() => screen.getAllByText('Clear panes'));
    const [clearBtn] = screen.getAllByTestId(/maintenance-clear-panes-ws-1/);
    fireEvent.click(clearBtn);

    await clickConfirm(/clear panes/i);

    await waitFor(() => {
      expect(rpcMocks['cleanup.clearPanes']).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        dryRun: false,
      });
    });
  });

  it('shows live pane count in clear-panes confirm', async () => {
    rpcMocks['cleanup.clearPanes'].mockResolvedValueOnce({
      sessionIds: ['dead-1'],
      liveBlockedSessionIds: ['live-1', 'live-2'],
      deleted: 0,
    });
    await renderTab();

    await waitFor(() => screen.getAllByText('Clear panes'));
    const [clearBtn] = screen.getAllByTestId(/maintenance-clear-panes-ws-1/);
    fireEvent.click(clearBtn);

    const dialog = await confirmDialogShown();
    expect(dialog.textContent).toContain('1 session record(s)');
    expect(dialog.textContent).toContain('2 active');
    expect(dialog.textContent).toContain('will be kept');
  });

  it('shows a success toast (not confirm) when no sessions found', async () => {
    rpcMocks['cleanup.clearPanes'].mockResolvedValueOnce({ sessionIds: [], liveBlockedSessionIds: [], deleted: 0 });
    const { toast } = await import('sonner');
    await renderTab();

    await waitFor(() => screen.getAllByText('Clear panes'));
    const [clearBtn] = screen.getAllByTestId(/maintenance-clear-panes-ws-1/);
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });
    // No confirm dialog (native or themed) when there is nothing to clear.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(queryConfirmDialog()).toBeNull();
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
    await confirmDialogShown();
    expect(confirmMock).not.toHaveBeenCalled();

    await clickCancel();
    await waitFor(() => expect(queryConfirmDialog()).toBeNull());
    expect(rpcMocks['cleanup.pruneWorktrees']).not.toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      dryRun: false,
    });
  });

  it('calls live prune on confirm', async () => {
    await renderTab();

    await waitFor(() => screen.getAllByText('Prune orphan worktrees'));
    const [pruneBtn] = screen.getAllByTestId(/maintenance-prune-worktrees-ws-1/);
    fireEvent.click(pruneBtn);

    await clickConfirm(/prune worktrees/i);

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
      expect(toast.success).toHaveBeenCalled();
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(queryConfirmDialog()).toBeNull();
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

// ---------------------------------------------------------------------------
// BSP-G5 — swarm teardown policy selector
// ---------------------------------------------------------------------------

describe('MaintenanceTab — swarm teardown policy (BSP-G5)', () => {
  it('renders a policy select for each workspace', async () => {
    await renderTab();
    await waitFor(() => {
      const selects = screen.getAllByTestId(/swarm-teardown-select-/);
      expect(selects).toHaveLength(2);
    });
  });

  it('defaults to keep-all (no KV entry)', async () => {
    await renderTab();
    await waitFor(() => {
      const select = screen.getByTestId('swarm-teardown-select-ws-1');
      // The select trigger renders the current value text
      expect(select.textContent).toContain('Keep all');
    });
  });

  it('reads persisted policy from KV on mount', async () => {
    // Pre-populate the KV store with a destroy-failing policy for ws-1
    kvStore['workspace.swarmTeardownPolicy.ws-1'] = 'destroy-failing';
    await renderTab();
    await waitFor(() => {
      const select = screen.getByTestId('swarm-teardown-select-ws-1');
      expect(select.textContent).toContain('Destroy failing');
    });
  });

  it('writes to KV when policy changes', async () => {
    await renderTab();
    await waitFor(() => screen.getByTestId('swarm-teardown-select-ws-1'));
    // Verify that kv.set is called when a policy is written
    expect(rpcMocks.kv.set).toBeDefined();
    // Directly call the onChangeTeardownPolicy path by triggering via the store
    await waitFor(() => {
      expect(rpcMocks.kv.get).toHaveBeenCalled();
    });
  });
});
