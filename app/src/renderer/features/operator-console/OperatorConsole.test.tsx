// @vitest-environment jsdom
//
// O5 — Verify the chat tab renders OrchestratorPanel (not the old placeholder).

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Mock heavy dependencies before importing components.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    swarms: { create: vi.fn() },
    panes: { brief: vi.fn() },
    git: { status: vi.fn() },
    review: { batchCommitAndMerge: vi.fn() },
  },
  onEvent: vi.fn(() => () => undefined),
}));

const mockActiveSwarm = {
  id: 'swarm-1',
  workspaceId: 'ws-1',
  name: 'Swarm 1',
  mission: 'test',
  preset: 'custom' as const,
  status: 'running' as const,
  createdAt: 0,
  endedAt: null,
  agents: [],
};

const mockWorkspace = {
  id: 'ws-1',
  name: 'WS',
  rootPath: '/tmp',
  repoRoot: null,
  repoMode: 'git' as const,
  createdAt: 0,
  lastOpenedAt: 0,
};

const mockDispatch = vi.fn();

const mockState = {
  activeWorkspace: mockWorkspace,
  activeWorkspaceId: 'ws-1',
  activeSwarmId: 'swarm-1',
  swarmMessages: { 'swarm-1': [] },
  swarmsByWorkspace: { 'ws-1': [mockActiveSwarm] },
  swarms: [mockActiveSwarm],
};

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: vi.fn((selector: (s: unknown) => unknown) =>
    selector(mockState),
  ),
  useAppState: vi.fn(() => ({ state: mockState, dispatch: mockDispatch })),
  useAppDispatch: vi.fn(() => mockDispatch),
}));

// Minimal canvas shim for Constellation.
beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext?: () => Record<string, unknown>;
  };
  proto.getContext = () => ({
    clearRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    fillText: () => undefined,
    setTransform: () => undefined,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  });

  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() { /* no-op */ }
      unobserve() { /* no-op */ }
      disconnect() { /* no-op */ }
    } as unknown as typeof ResizeObserver;
  }
  const proto2 = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto2.hasPointerCapture) {
    proto2.hasPointerCapture = () => false;
  }
  if (!proto2.scrollIntoView) {
    proto2.scrollIntoView = () => undefined;
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import { OperatorConsole } from './index';

describe('OperatorConsole — O5: chat tab mounts OrchestratorPanel', () => {
  it('chat tab renders OrchestratorPanel, not the placeholder text', async () => {
    render(<OperatorConsole />);

    // Navigate to the chat tab.
    const chatTab = screen.getByRole('button', { name: /chat/i });
    fireEvent.click(chatTab);

    // The old placeholder should be gone.
    expect(screen.queryByText(/Wire the live chat tail/i)).toBeNull();

    // The OrchestratorPanel landmark is present.
    expect(
      screen.getByText(/Sigma Agent/i),
    ).toBeDefined();
  });
});
