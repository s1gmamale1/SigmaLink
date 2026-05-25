// @vitest-environment jsdom
//
// Stage-4 UX — MemoryRoom no longer calls window.alert on create failure;
// instead it renders an ErrorBanner that can be dismissed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ---- mocks -----------------------------------------------------------------

const createMemoryMock = vi.fn();
const initHubMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    memory: {
      init_hub: () => initHubMock(),
      create_memory: (...args: unknown[]) => createMemoryMock(...args),
      getGraph: vi.fn().mockResolvedValue(null),
    },
  },
  onEvent: vi.fn(() => () => undefined),
  rpcSilent: {
    ruflo: { health: vi.fn().mockResolvedValue({ state: 'absent' }) },
  },
}));

const mockDispatch = vi.fn();
const mockWorkspace = {
  id: 'ws-test',
  name: 'Test WS',
  rootPath: '/tmp',
  repoRoot: null,
  repoMode: 'git' as const,
  createdAt: 0,
  lastOpenedAt: 0,
};

vi.mock('@/renderer/app/state', () => ({
  useAppState: vi.fn(() => ({
    state: {
      activeWorkspace: mockWorkspace,
      memories: { 'ws-test': [] },
      activeMemoryName: { 'ws-test': null },
      memoryGraph: { 'ws-test': null },
    },
    dispatch: mockDispatch,
  })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import { MemoryRoom } from './MemoryRoom';

describe('MemoryRoom — Stage-4 UX', () => {
  it('does NOT call window.alert when create_memory rejects', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    createMemoryMock.mockRejectedValue(new Error('Duplicate name'));

    render(<MemoryRoom />);

    // Trigger create via prompt
    vi.spyOn(window, 'prompt').mockReturnValue('my-note');
    const createBtn = screen.getByRole('button', { name: /create note/i });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(alertSpy).not.toHaveBeenCalled();
    });

    alertSpy.mockRestore();
  });

  it('renders ErrorBanner after create_memory rejects', async () => {
    createMemoryMock.mockRejectedValue(new Error('Duplicate name'));

    render(<MemoryRoom />);

    vi.spyOn(window, 'prompt').mockReturnValue('my-note');
    const createBtn = screen.getByRole('button', { name: /create note/i });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Duplicate name/i)).toBeDefined();
    });
  });

  it('ErrorBanner can be dismissed', async () => {
    createMemoryMock.mockRejectedValue(new Error('Duplicate name'));

    render(<MemoryRoom />);

    vi.spyOn(window, 'prompt').mockReturnValue('my-note');
    const createBtn = screen.getByRole('button', { name: /create note/i });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });

    const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
