// @vitest-environment jsdom
// BSP-G2 — GitRoom rendering tests.
// Tests the 3 sections, ahead/behind pill, and branch switch disabled state.

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// --- mock rpc ---
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    git: {
      status: vi.fn(),
    },
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  rpcSilent: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// --- mock app state ---
const mockWorkspace = {
  id: 'ws-1',
  name: 'Test Workspace',
  rootPath: '/tmp/test-ws',
  repoRoot: '/tmp/test-ws',
  repoMode: 'git' as const,
  createdAt: 0,
  lastOpenedAt: 0,
};

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: vi.fn(
    (selector: (s: object) => unknown) =>
      selector({ activeWorkspace: mockWorkspace }),
  ),
  useAppDispatch: vi.fn(() => vi.fn()),
}));

// --- mock workspace-ui-kv ---
vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: vi.fn().mockResolvedValue(null),
  writeWorkspaceUi: vi.fn().mockResolvedValue(undefined),
}));

// --- mock DiffView (avoid rendering heavy component) ---
vi.mock('@/renderer/features/review/DiffView', () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));

// --- mock BranchSelector ---
vi.mock('./BranchSelector', () => ({
  BranchSelector: ({ status }: { status: { clean: boolean } | null }) => (
    <div data-testid="branch-selector">
      {status && !status.clean ? (
        <span data-testid="branch-dirty-indicator">dirty</span>
      ) : null}
    </div>
  ),
}));

// --- mock ChangesPanel ---
vi.mock('./ChangesPanel', () => ({
  ChangesPanel: () => <div data-testid="changes-panel" />,
}));

// --- mock HistoryPanel ---
vi.mock('./HistoryPanel', () => ({
  HistoryPanel: () => <div data-testid="history-panel" />,
}));

// --- mock EmptyState ---
vi.mock('@/renderer/components/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => (
    <div data-testid="empty-state">{title}</div>
  ),
}));

// --- mock tooltip ---
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// --- mock resizable ---
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    children,
  }: {
    children: React.ReactNode;
    orientation: string;
    className?: string;
    onLayoutChanged?: unknown;
  }) => <div data-testid="resizable-group">{children}</div>,
  ResizablePanel: ({
    children,
  }: {
    children: React.ReactNode;
    id: string;
    defaultSize?: number;
    minSize?: number;
    className?: string;
  }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

import React from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { GitRoom } from './GitRoom';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGitStatus = (rpc.git.status as any) as ReturnType<typeof vi.fn>;

const cleanStatus = {
  branch: 'main',
  ahead: 2,
  behind: 1,
  staged: [],
  unstaged: [],
  untracked: [],
  clean: true,
};

const dirtyStatus = {
  ...cleanStatus,
  staged: ['src/foo.ts'],
  unstaged: ['src/bar.ts'],
  untracked: ['src/baz.ts'],
  clean: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGitStatus.mockResolvedValue(cleanStatus);
});

afterEach(() => {
  cleanup();
});

describe('GitRoom', () => {
  it('renders the 3 tab sections (Changes, History, Branches)', async () => {
    render(<GitRoom />);
    await waitFor(() => {
      expect(screen.getByTestId('git-tab-changes')).toBeTruthy();
      expect(screen.getByTestId('git-tab-history')).toBeTruthy();
      expect(screen.getByTestId('git-tab-branches')).toBeTruthy();
    });
  });

  it('shows the branch name in the header', async () => {
    render(<GitRoom />);
    await waitFor(() => {
      expect(screen.getByText('main')).toBeTruthy();
    });
  });

  it('renders ahead/behind pill when values are non-zero', async () => {
    render(<GitRoom />);
    await waitFor(() => {
      // cleanStatus has ahead=2 behind=1
      expect(screen.getByText('↑2 ↓1')).toBeTruthy();
    });
  });

  it('hides ahead/behind pill when both are zero', async () => {
    mockGitStatus.mockResolvedValue({ ...cleanStatus, ahead: 0, behind: 0 });
    render(<GitRoom />);
    await waitFor(() => {
      expect(screen.queryByText(/↑0/)).toBeNull();
    });
  });

  it('shows ChangesPanel on the Changes tab by default', async () => {
    render(<GitRoom />);
    await waitFor(() => {
      expect(screen.getByTestId('changes-panel')).toBeTruthy();
    });
  });

  it('passes dirty status to BranchSelector', async () => {
    mockGitStatus.mockResolvedValue(dirtyStatus);
    render(<GitRoom />);

    // Switch to Branches tab
    const branchTab = await screen.findByTestId('git-tab-branches');
    branchTab.click();

    await waitFor(() => {
      expect(screen.getByTestId('branch-selector')).toBeTruthy();
      // The mock BranchSelector renders a dirty indicator when status.clean === false
      expect(screen.getByTestId('branch-dirty-indicator')).toBeTruthy();
    });
  });
});
