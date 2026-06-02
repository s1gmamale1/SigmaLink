// @vitest-environment jsdom

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
// Mock rpc before importing the component under test.
// NOTE: vi.mock is hoisted — no top-level variable refs allowed inside factory.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    swarms: {
      create: vi.fn().mockResolvedValue({
        id: 'swarm-1',
        workspaceId: 'ws-1',
        name: 'Test Swarm',
        mission: 'test mission',
        preset: 'custom',
        status: 'running',
        createdAt: 0,
        endedAt: null,
        agents: [
          {
            id: 'agent-1',
            swarmId: 'swarm-1',
            role: 'builder',
            roleIndex: 1,
            providerId: 'claude',
            sessionId: 'sess-1',
            status: 'idle',
            inboxPath: '/tmp/inbox',
            agentKey: 'builder-1',
            worktreePath: '/tmp/wt1',
          },
        ],
      }),
    },
    panes: {
      brief: vi.fn().mockResolvedValue(undefined),
    },
    git: {
      status: vi.fn().mockResolvedValue({
        branch: 'test-branch',
        staged: ['a.ts'],
        unstaged: [],
        untracked: [],
        clean: false,
      }),
    },
    review: {
      batchCommitAndMerge: vi.fn().mockResolvedValue({
        results: [{ sessionId: 'sess-1', ok: true, code: 0 }],
      }),
      getConflicts: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Mock app state so the component can read activeWorkspace / dispatch.
const mockDispatch = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: vi.fn((selector: (s: unknown) => unknown) =>
    selector({
      activeWorkspace: { id: 'ws-1', name: 'WS', rootPath: '/tmp', repoRoot: null, repoMode: 'git', createdAt: 0, lastOpenedAt: 0 },
      activeWorkspaceId: 'ws-1',
    })
  ),
  useAppDispatch: () => mockDispatch,
}));

import { rpc } from '@/renderer/lib/rpc';
import { OrchestratorPanel } from './OrchestratorPanel';

// Radix polyfills required for jsdom.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() { /* no-op */ }
      unobserve() { /* no-op */ }
      disconnect() { /* no-op */ }
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) {
    proto.hasPointerCapture = () => false;
  }
  if (!proto.scrollIntoView) {
    proto.scrollIntoView = () => undefined;
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrchestratorPanel — O3: author tasks + launch swarm', () => {
  it('calls swarms.create with preset:custom and panes.brief once per spawned agent', async () => {
    render(<OrchestratorPanel />);

    // Add a task row.
    fireEvent.click(screen.getByRole('button', { name: /add task/i }));

    // Fill in the prompt/goal field.
    const promptInput = screen.getByLabelText(/goal|prompt/i);
    fireEvent.change(promptInput, { target: { value: 'add login' } });

    // Launch the swarm.
    fireEvent.click(screen.getByRole('button', { name: /launch swarm/i }));

    await waitFor(() =>
      expect(rpc.swarms.create).toHaveBeenCalledWith(
        expect.objectContaining({ preset: 'custom' }),
      ),
    );

    await waitFor(() => expect(rpc.panes.brief).toHaveBeenCalledTimes(1));
  });

  it('dispatches UPSERT_SWARM after swarm creation', async () => {
    render(<OrchestratorPanel />);

    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    const promptInput = screen.getByLabelText(/goal|prompt/i);
    fireEvent.change(promptInput, { target: { value: 'build feature' } });
    fireEvent.click(screen.getByRole('button', { name: /launch swarm/i }));

    await waitFor(() => expect(rpc.swarms.create).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPSERT_SWARM' }),
      ),
    );
  });
});

describe('OrchestratorPanel — O4: merge order + batch merge', () => {
  it('calls git.status on propose and batchCommitAndMerge on sequential merge', async () => {
    render(<OrchestratorPanel />);

    // Seed the active swarm directly via the panel's internal state by
    // launching first.
    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    const promptInput = screen.getByLabelText(/goal|prompt/i);
    fireEvent.change(promptInput, { target: { value: 'add login' } });
    fireEvent.click(screen.getByRole('button', { name: /launch swarm/i }));

    await waitFor(() => expect(rpc.swarms.create).toHaveBeenCalled());

    // Propose merge order. The button appears only after the swarm-active
    // re-render lands, so poll for it (findByRole) rather than a synchronous
    // getByRole — under CI's slower/parallel coverage run the re-render can lag
    // the swarms.create resolution (this was an intermittent CI-only flake).
    fireEvent.click(await screen.findByRole('button', { name: /propose merge order/i }));

    await waitFor(() => expect(rpc.git.status).toHaveBeenCalled());

    // Sequential merge button — label updated to "Sequential merge (N panes)".
    fireEvent.click(await screen.findByRole('button', { name: /sequential merge/i }));

    expect(rpc.review.batchCommitAndMerge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: expect.any(Array) }),
    );
  });

  it('dispatches SET_ROOM review after a fully-successful merge', async () => {
    render(<OrchestratorPanel />);

    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    fireEvent.change(screen.getByLabelText(/goal|prompt/i), { target: { value: 'add login' } });
    fireEvent.click(screen.getByRole('button', { name: /launch swarm/i }));
    await waitFor(() => expect(rpc.swarms.create).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /propose merge order/i }));
    await waitFor(() => expect(rpc.git.status).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /sequential merge/i }));
    await waitFor(() => expect(rpc.review.batchCommitAndMerge).toHaveBeenCalled());

    await waitFor(() =>
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'review' }),
    );
  });

  it('does NOT dispatch SET_ROOM when a merge fails', async () => {
    (rpc.review.batchCommitAndMerge as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [{ sessionId: 'sess-1', ok: false, code: 1, stderr: 'conflict' }],
    });

    render(<OrchestratorPanel />);

    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    fireEvent.change(screen.getByLabelText(/goal|prompt/i), { target: { value: 'failing task' } });
    fireEvent.click(screen.getByRole('button', { name: /launch swarm/i }));
    await waitFor(() => expect(rpc.swarms.create).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /propose merge order/i }));
    await waitFor(() => expect(rpc.git.status).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /sequential merge/i }));
    await waitFor(() => expect(rpc.review.batchCommitAndMerge).toHaveBeenCalled());

    // After partial failure the dispatch must NOT have been called with SET_ROOM review.
    expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'review' });
  });
});

// ─── Overlap badge thresholds ────────────────────────────────────────────────

describe('OrchestratorPanel — overlap badge: 3-tier thresholds', () => {
  /** Helper: launch → propose → return the first list-item text content. */
  async function getBadgeText(): Promise<string> {
    fireEvent.click(screen.getByRole('button', { name: /add task/i }));
    fireEvent.change(screen.getByLabelText(/goal|prompt/i), { target: { value: 'task' } });
    fireEvent.click(screen.getByRole('button', { name: /launch swarm/i }));
    await waitFor(() => expect(rpc.swarms.create).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /propose merge order/i }));
    await waitFor(() => expect(rpc.git.status).toHaveBeenCalled());

    // Wait for the ordered list to appear.
    await screen.findByRole('list');
    const item = screen.getAllByRole('listitem')[0];
    return item?.textContent ?? '';
  }

  it('shows "clean" badge when overlapScore is 0 (no shared filenames)', async () => {
    // git.status returns unique files for the single pane — no overlap with anything.
    render(<OrchestratorPanel />);
    const text = await getBadgeText();
    expect(text).toMatch(/clean/i);
    expect(text).not.toMatch(/overlap/i);
  });

  it('shows "low overlap" badge when overlapScore is 1–2', async () => {
    // Two agents both touch 'shared.ts' → overlapScore = 1 for the first entry.
    (rpc.git.status as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ branch: 'b', staged: ['shared.ts', 'a.ts'], unstaged: [], untracked: [], clean: false })
      .mockResolvedValueOnce({ branch: 'b', staged: ['shared.ts', 'b.ts'], unstaged: [], untracked: [], clean: false });

    // Provide a second agent in the swarm so there IS something to overlap with.
    (rpc.swarms.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'swarm-2',
      workspaceId: 'ws-1',
      name: 'Two Agent Swarm',
      mission: 'test',
      preset: 'custom',
      status: 'running',
      createdAt: 0,
      endedAt: null,
      agents: [
        { id: 'a1', swarmId: 'swarm-2', role: 'builder', roleIndex: 1, providerId: 'claude', sessionId: 'sess-a', status: 'idle', inboxPath: '/tmp/ia', agentKey: 'builder-a', worktreePath: '/tmp/wta' },
        { id: 'a2', swarmId: 'swarm-2', role: 'builder', roleIndex: 2, providerId: 'claude', sessionId: 'sess-b', status: 'idle', inboxPath: '/tmp/ib', agentKey: 'builder-b', worktreePath: '/tmp/wtb' },
      ],
    });

    render(<OrchestratorPanel />);
    const text = await getBadgeText();
    expect(text).toMatch(/low overlap/i);
  });

  it('shows "high overlap" badge when overlapScore is ≥ 3', async () => {
    // Three agents share the same 3 files → overlapScore = 3 for first entry.
    const sharedFiles = ['x.ts', 'y.ts', 'z.ts'];
    (rpc.git.status as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ branch: 'b', staged: sharedFiles, unstaged: [], untracked: [], clean: false });

    (rpc.swarms.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'swarm-3',
      workspaceId: 'ws-1',
      name: 'Three Agent Swarm',
      mission: 'test',
      preset: 'custom',
      status: 'running',
      createdAt: 0,
      endedAt: null,
      agents: [
        { id: 'a1', swarmId: 'swarm-3', role: 'builder', roleIndex: 1, providerId: 'claude', sessionId: 'sess-a', status: 'idle', inboxPath: '/tmp/ia', agentKey: 'builder-a', worktreePath: '/tmp/wta' },
        { id: 'a2', swarmId: 'swarm-3', role: 'builder', roleIndex: 2, providerId: 'claude', sessionId: 'sess-b', status: 'idle', inboxPath: '/tmp/ib', agentKey: 'builder-b', worktreePath: '/tmp/wtb' },
        { id: 'a3', swarmId: 'swarm-3', role: 'builder', roleIndex: 3, providerId: 'claude', sessionId: 'sess-c', status: 'idle', inboxPath: '/tmp/ic', agentKey: 'builder-c', worktreePath: '/tmp/wtc' },
      ],
    });

    render(<OrchestratorPanel />);
    const text = await getBadgeText();
    expect(text).toMatch(/high overlap/i);
  });
});
