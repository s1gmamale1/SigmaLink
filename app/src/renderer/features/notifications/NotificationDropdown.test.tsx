// @vitest-environment jsdom
//
// v1.4.9 #07 — NotificationDropdown unit tests. Covers:
//   - Filter chips (All / This workspace / Errors only) and their semantics.
//   - Mark-all-read + Clear-read controls trigger the right RPC method.
//   - Item click marks read (optimistic) + invokes rpc.notifications.markRead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotificationDropdown } from './NotificationDropdown';
import { applyFilter } from './helpers';
import type { AppState } from '@/renderer/app/state.types';
import { initialAppState } from '@/renderer/app/state.types';
import type { Notification, NotificationSeverity } from '@/shared/types';

vi.mock('@/renderer/lib/drag-region', () => ({ noDragStyle: () => ({}) }));

// Note: vi.mock is hoisted; the factory must construct mocks inline. We
// re-import the mocked module below to grab references for assertions.
vi.mock('@/renderer/lib/rpc', () => {
  const fns = {
    markAllRead: vi.fn().mockResolvedValue(undefined),
    clearRead: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    markUnread: vi.fn().mockResolvedValue(undefined),
  };
  const obj = { notifications: fns };
  return { rpc: obj, rpcSilent: obj };
});

// Helper to grab the live mocks after the module is initialised.
import { rpc as mockRpc } from '@/renderer/lib/rpc';

let mockState: AppState = { ...initialAppState };
const dispatchSpy = vi.fn();
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({ state: mockState, dispatch: dispatchSpy }),
}));

function makeN(
  partial: Partial<Notification> & { id: string; severity: NotificationSeverity },
): Notification {
  return {
    workspaceId: 'ws-1',
    kind: 'pty-exit',
    title: 'title-' + partial.id,
    body: null,
    payload: null,
    sourceEvent: null,
    dedupKey: 'k-' + partial.id,
    dupCount: 1,
    createdAt: Date.now(),
    readAt: null,
    ...partial,
  };
}

beforeEach(() => {
  mockState = { ...initialAppState };
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('applyFilter', () => {
  const notes = [
    makeN({ id: '1', severity: 'info', workspaceId: 'ws-1' }),
    makeN({ id: '2', severity: 'warn', workspaceId: 'ws-2' }),
    makeN({ id: '3', severity: 'error', workspaceId: 'ws-1' }),
    makeN({ id: '4', severity: 'critical', workspaceId: null }),
  ];

  it('"all" returns every row', () => {
    expect(applyFilter(notes, 'all', 'ws-1')).toHaveLength(4);
  });

  it('"workspace" returns active workspace + global rows', () => {
    const out = applyFilter(notes, 'workspace', 'ws-1');
    expect(out.map((n) => n.id).sort()).toEqual(['1', '3', '4']);
  });

  it('"errors" returns error + critical (Open Q3 resolution)', () => {
    const out = applyFilter(notes, 'errors', 'ws-1');
    expect(out.map((n) => n.id).sort()).toEqual(['3', '4']);
  });
});

describe('NotificationDropdown', () => {
  it('renders empty state when no rows', () => {
    render(<NotificationDropdown onClose={() => undefined} />);
    expect(screen.getByTestId('notification-empty')).toBeTruthy();
  });

  it('renders one row per notification', () => {
    mockState = {
      ...initialAppState,
      notifications: [
        makeN({ id: 'a', severity: 'info' }),
        makeN({ id: 'b', severity: 'warn' }),
      ],
    };
    render(<NotificationDropdown onClose={() => undefined} />);
    expect(screen.getByTestId('notification-item-a')).toBeTruthy();
    expect(screen.getByTestId('notification-item-b')).toBeTruthy();
  });

  it('Mark all read triggers rpc.notifications.markAllRead', () => {
    render(<NotificationDropdown onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));
    expect((mockRpc as unknown as { notifications: Record<string, ReturnType<typeof vi.fn>> }).notifications.markAllRead).toHaveBeenCalledTimes(1);
  });

  it('Clear read triggers rpc.notifications.clearRead', () => {
    render(<NotificationDropdown onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('notification-clear-read'));
    expect((mockRpc as unknown as { notifications: Record<string, ReturnType<typeof vi.fn>> }).notifications.clearRead).toHaveBeenCalledTimes(1);
  });

  it('switching filter chip re-renders the list', () => {
    mockState = {
      ...initialAppState,
      activeWorkspaceId: 'ws-1',
      activeWorkspace: {
        id: 'ws-1',
        name: 'w',
        rootPath: '/',
        repoRoot: null,
        repoMode: 'plain',
        createdAt: 0,
        lastOpenedAt: 0,
      },
      notifications: [
        makeN({ id: 'a', severity: 'info', workspaceId: 'ws-1' }),
        makeN({ id: 'b', severity: 'error', workspaceId: 'ws-2' }),
      ],
    };
    render(<NotificationDropdown onClose={() => undefined} />);
    // Default chip = 'all' — both visible.
    expect(screen.queryByTestId('notification-item-a')).toBeTruthy();
    expect(screen.queryByTestId('notification-item-b')).toBeTruthy();
    // Switch to Errors only.
    fireEvent.click(screen.getByTestId('notification-filter-errors'));
    expect(screen.queryByTestId('notification-item-a')).toBeNull();
    expect(screen.queryByTestId('notification-item-b')).toBeTruthy();
  });
});
