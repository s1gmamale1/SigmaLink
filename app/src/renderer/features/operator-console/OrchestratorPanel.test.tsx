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
  it('calls git.status on propose and batchCommitAndMerge on merge', async () => {
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

    // Merge in order (also gated on a post-propose re-render — poll for it too).
    fireEvent.click(await screen.findByRole('button', { name: /merge in order/i }));

    expect(rpc.review.batchCommitAndMerge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: expect.any(Array) }),
    );
  });
});
