// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    swarms: {
      broadcast: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@/renderer/lib/pane-context-builder', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildPaneContext: vi.fn().mockResolvedValue('CTX-BLOCK'),
  PANE_DRAG_MIME: 'application/sigmalink-pane',
}));

import { SideChat } from './SideChat';
import { PANE_DRAG_MIME } from '@/renderer/lib/pane-context-builder';
import type { Swarm } from '@/shared/types';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
});

function makeSwarm(overrides: Partial<Swarm> = {}): Swarm {
  return {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Test Swarm',
    mission: 'test',
    status: 'running',
    agents: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('SideChat drop zone', () => {
  it('appends pane context to draft when PANE_DRAG_MIME is dropped on composer', async () => {
    render(<SideChat swarm={makeSwarm()} messages={[]} />);
    const composerWrapper = screen.getByTestId('sidechat-composer');
    fireEvent.dragOver(composerWrapper, {
      dataTransfer: { types: [PANE_DRAG_MIME] },
    });
    fireEvent.drop(composerWrapper, {
      dataTransfer: {
        types: [PANE_DRAG_MIME],
        getData: () => JSON.stringify({ kind: 'pane', sessionId: 's1', branch: 'b', worktreePath: '/w', providerId: 'claude' }),
      },
    });
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Broadcast|Message/i)).toHaveProperty('value', expect.stringContaining('CTX-BLOCK')),
    );
  });
});
