// @vitest-environment jsdom
//
// Task B1 — failing test first (TDD). Tests for useRufloDaemonHealth hook.
// Mocks rpcSilent.ruflo.daemonStatus to cover all 5 contract states:
//   running row   → state:'running'
//   crashed row   → state:'down'
//   starting row  → state:'starting'
//   empty array   → state:'fallback' (no row for this workspaceId → stdio)
//   rejected RPC  → state:'unknown'  (fail-safe, never throws)

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// vi.mock is hoisted — factory MUST NOT reference variables defined below it.
// Use vi.fn() inline; we retrieve the mock reference from the imported module.
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    ruflo: {
      daemonStatus: vi.fn(),
    },
  },
  rpc: {
    panes: { brief: vi.fn().mockResolvedValue(undefined) },
  },
}));

import { rpcSilent } from '@/renderer/lib/rpc';
import { useRufloDaemonHealth } from './useRufloDaemonHealth';

type DaemonRow = {
  workspaceId: string;
  status: string;
  port: number;
  pid: number;
  uptime: number;
  connections: number | null;
};

// Typed helper to avoid casting on every call
const mockDaemonStatus = rpcSilent.ruflo.daemonStatus as ReturnType<
  typeof vi.fn<(workspaceId?: string) => Promise<DaemonRow[]>>
>;

beforeEach(() => {
  vi.useFakeTimers();
  mockDaemonStatus.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRufloDaemonHealth', () => {
  it('returns state:running when the workspace row has status=running', async () => {
    mockDaemonStatus.mockResolvedValue([
      { workspaceId: 'ws-1', status: 'running', port: 53112, pid: 1234, uptime: 100, connections: 2 },
    ]);

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    // Initial state before first poll resolves
    expect(result.current.state).toBe('unknown');

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('running');
    expect(result.current.detail).toMatch(/running/i);
    expect(result.current.detail).toMatch(/53112/);
  });

  it('returns state:down when the workspace row has status=crashed', async () => {
    mockDaemonStatus.mockResolvedValue([
      { workspaceId: 'ws-1', status: 'crashed', port: 0, pid: 0, uptime: 0, connections: null },
    ]);

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('down');
    expect(result.current.detail).toMatch(/crash/i);
  });

  it('returns state:down when the workspace row has status=down', async () => {
    mockDaemonStatus.mockResolvedValue([
      { workspaceId: 'ws-1', status: 'down', port: 0, pid: 0, uptime: 0, connections: null },
    ]);

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('down');
  });

  it('returns state:starting when the workspace row has status=starting', async () => {
    mockDaemonStatus.mockResolvedValue([
      { workspaceId: 'ws-1', status: 'starting', port: 0, pid: 0, uptime: 0, connections: null },
    ]);

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('starting');
    expect(result.current.detail).toMatch(/starting/i);
  });

  it('returns state:fallback when no row exists for the workspace (empty array → stdio)', async () => {
    mockDaemonStatus.mockResolvedValue([]);

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('fallback');
    expect(result.current.detail).toMatch(/stdio/i);
  });

  it('returns state:unknown when the RPC rejects — never throws', async () => {
    mockDaemonStatus.mockRejectedValue(new Error('RPC unavailable'));

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('unknown');
    // Must not throw — fail-safe contract
  });

  it('polls again after ~5s interval', async () => {
    mockDaemonStatus
      .mockResolvedValueOnce([
        { workspaceId: 'ws-1', status: 'starting', port: 0, pid: 0, uptime: 0, connections: null },
      ])
      .mockResolvedValueOnce([
        { workspaceId: 'ws-1', status: 'running', port: 53112, pid: 1234, uptime: 5, connections: 1 },
      ]);

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state).toBe('starting');

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(result.current.state).toBe('running');
    expect(mockDaemonStatus).toHaveBeenCalledTimes(2);
  });

  it('clears interval on unmount (no late-state updates)', async () => {
    mockDaemonStatus.mockResolvedValue([
      { workspaceId: 'ws-1', status: 'running', port: 53112, pid: 1234, uptime: 100, connections: 1 },
    ]);

    const { unmount } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    const callCountAfterUnmount = mockDaemonStatus.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });

    // No additional calls after unmount
    expect(mockDaemonStatus.mock.calls.length).toBe(callCountAfterUnmount);
  });

  it('filters by workspaceId — ignores rows for other workspaces', async () => {
    mockDaemonStatus.mockResolvedValue([
      { workspaceId: 'ws-other', status: 'running', port: 53113, pid: 5678, uptime: 200, connections: 3 },
    ]);

    const { result } = renderHook(() => useRufloDaemonHealth('ws-1'));

    await act(async () => {
      await Promise.resolve();
    });

    // ws-other is running but ws-1 has no row → fallback
    expect(result.current.state).toBe('fallback');
  });
});
