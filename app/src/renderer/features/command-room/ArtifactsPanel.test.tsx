// @vitest-environment jsdom
//
// BSP-O4 — ArtifactsPanel unit coverage.
// Validates: changed-files list, checkpoint timeline, event-driven refresh,
// in-place (no worktree) mode, and loading state.
//
// DB rule: NEVER import better-sqlite3 or new Database() — would crash on the
// Electron ABI. All data comes from mocked RPC.

import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Mock } from 'vitest';

// ── Mock rpc + onEvent ────────────────────────────────────────────────────────
// vi.mock is hoisted — use only vi.fn() with no top-level variable captures.

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    git: {
      status: vi.fn(),
      listCheckpoints: vi.fn(),
    },
  },
  onEvent: vi.fn(() => () => undefined),
}));

import { ArtifactsPanel } from './ArtifactsPanel';
import { rpc, onEvent } from '@/renderer/lib/rpc';

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockGitStatus = rpc.git.status as Mock;
const mockListCheckpoints = rpc.git.listCheckpoints as Mock;
const mockOnEvent = onEvent as Mock;

function makeStatus(overrides: Partial<{
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}> = {}) {
  return {
    branch: 'feat/x',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    clean: true,
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<{
  id: string;
  sha: string;
  label: string | null;
  kind: 'auto' | 'manual';
  createdAt: number;
}> = {}) {
  return {
    id: 'cp-1',
    sessionId: 'sess-1',
    sha: 'abc1234def5678',
    label: 'Before refactor',
    kind: 'manual' as const,
    createdAt: Date.now() - 5 * 60_000, // 5 min ago
    ...overrides,
  };
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() { /* no-op */ }
      unobserve() { /* no-op */ }
      disconnect() { /* no-op */ }
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset onEvent to the default no-op return so subsequent tests start clean.
  mockOnEvent.mockReturnValue(() => undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ArtifactsPanel', () => {
  it('renders loading state initially and then resolves', async () => {
    // Delay the resolution so we can observe the loading state.
    let resolve!: () => void;
    const pending = new Promise<void>((res) => { resolve = res; });
    mockGitStatus.mockReturnValue(pending.then(() => makeStatus()));
    mockListCheckpoints.mockResolvedValue([]);

    render(<ArtifactsPanel sessionId="sess-1" worktreePath="/wt/x" />);
    expect(screen.getByTestId('artifacts-panel-loading')).toBeTruthy();

    resolve();
    await waitFor(() => expect(screen.getByTestId('artifacts-panel')).toBeTruthy());
  });

  it('shows "Working tree clean" when status.clean=true', async () => {
    mockGitStatus.mockResolvedValue(makeStatus({ clean: true }));
    mockListCheckpoints.mockResolvedValue([]);

    render(<ArtifactsPanel sessionId="sess-1" worktreePath="/wt/x" />);
    await waitFor(() => expect(screen.getByTestId('artifacts-clean')).toBeTruthy());
  });

  it('lists staged/unstaged/untracked files when not clean', async () => {
    mockGitStatus.mockResolvedValue(
      makeStatus({
        staged: ['src/foo.ts'],
        unstaged: ['src/bar.ts'],
        untracked: ['new-file.ts'],
        clean: false,
      }),
    );
    mockListCheckpoints.mockResolvedValue([]);

    render(<ArtifactsPanel sessionId="sess-1" worktreePath="/wt/x" />);
    await waitFor(() => expect(screen.getByTestId('artifacts-changed-files')).toBeTruthy());
    const list = screen.getByTestId('artifacts-changed-files');
    expect(list.textContent).toContain('src/foo.ts');
    expect(list.textContent).toContain('src/bar.ts');
    expect(list.textContent).toContain('new-file.ts');
  });

  it('shows the checkpoint timeline when checkpoints exist', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());
    mockListCheckpoints.mockResolvedValue([makeCheckpoint({ label: 'Pre-deploy' })]);

    render(<ArtifactsPanel sessionId="sess-1" worktreePath="/wt/x" />);
    await waitFor(() => expect(screen.getByTestId('artifacts-checkpoints')).toBeTruthy());
    expect(screen.getByTestId('artifacts-checkpoints').textContent).toContain('Pre-deploy');
  });

  it('shows "No checkpoints yet" when list is empty', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());
    mockListCheckpoints.mockResolvedValue([]);

    render(<ArtifactsPanel sessionId="sess-1" worktreePath="/wt/x" />);
    await waitFor(() =>
      expect(screen.getByTestId('artifacts-no-checkpoints')).toBeTruthy(),
    );
  });

  it('shows "No worktree — running in-place" when worktreePath is null', async () => {
    // git.status should NOT be called when there is no worktree path.
    mockListCheckpoints.mockResolvedValue([]);

    render(<ArtifactsPanel sessionId="sess-1" worktreePath={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('artifacts-no-worktree')).toBeTruthy(),
    );
    expect(mockGitStatus).not.toHaveBeenCalled();
  });

  it('subscribes to git:checkpoints-changed and re-fetches on matching sessionId', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());
    mockListCheckpoints.mockResolvedValue([]);

    type OnEventCb = (payload: unknown) => void;
    let capturedCb: OnEventCb | undefined;
    mockOnEvent.mockImplementation((event: string, cb: OnEventCb) => {
      if (event === 'git:checkpoints-changed') capturedCb = cb;
      return () => undefined;
    });

    render(<ArtifactsPanel sessionId="sess-1" worktreePath="/wt/x" />);
    await waitFor(() => expect(screen.getByTestId('artifacts-panel')).toBeTruthy());

    // After the event fires for this session, listCheckpoints is called again.
    const before = mockListCheckpoints.mock.calls.length;
    mockListCheckpoints.mockResolvedValue([makeCheckpoint()]);
    capturedCb?.({ sessionId: 'sess-1' });
    await waitFor(() =>
      expect(mockListCheckpoints.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('does NOT re-fetch on git:checkpoints-changed for a different sessionId', async () => {
    mockGitStatus.mockResolvedValue(makeStatus());
    mockListCheckpoints.mockResolvedValue([]);

    type OnEventCb = (payload: unknown) => void;
    let capturedCb: OnEventCb | undefined;
    mockOnEvent.mockImplementation((event: string, cb: OnEventCb) => {
      if (event === 'git:checkpoints-changed') capturedCb = cb;
      return () => undefined;
    });

    render(<ArtifactsPanel sessionId="sess-1" worktreePath="/wt/x" />);
    await waitFor(() => expect(screen.getByTestId('artifacts-panel')).toBeTruthy());

    const before = mockListCheckpoints.mock.calls.length;
    capturedCb?.({ sessionId: 'sess-OTHER' });
    // Give a tick for any potential spurious call.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockListCheckpoints.mock.calls.length).toBe(before);
  });
});
