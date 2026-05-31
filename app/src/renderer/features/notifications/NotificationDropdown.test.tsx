// @vitest-environment jsdom
//
// v1.4.9 #07 — NotificationDropdown unit tests. Covers:
//   - Filter chips (All / This workspace / Errors only) and their semantics.
//   - Mark-all-read + Clear-read controls trigger the right RPC method.
//   - Item click marks read (optimistic) + invokes rpc.notifications.markRead.
// UX-2 — the dropdown is now the body of a Radix PopoverContent. It is no
//   longer self-positioned and no longer owns an outside-click listener
//   (the Popover handles dismissal). ARIA is now role="dialog" + role="list".

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

  it('dropdown container carries sl-glass class for glass theme surface (SF-4)', () => {
    render(<NotificationDropdown onClose={() => undefined} />);
    const container = screen.getByTestId('notification-dropdown');
    expect(container.className).toContain('sl-glass');
  });

  it('UX-2 — exposes role="dialog" labelled Notifications (not the old role=menu)', () => {
    render(<NotificationDropdown onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog.getAttribute('data-testid')).toBe('notification-dropdown');
    // The old hand-rolled surface used role="menu" with non-menuitem
    // children — that ARIA mismatch must be gone.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('UX-2 — renders the item list as role="list"', () => {
    mockState = {
      ...initialAppState,
      notifications: [makeN({ id: 'a', severity: 'info' })],
    };
    render(<NotificationDropdown onClose={() => undefined} />);
    expect(screen.getByRole('list')).toBeTruthy();
  });

  it('UX-2 — header close button invokes onClose (Popover dismissal)', () => {
    const onClose = vi.fn();
    render(<NotificationDropdown onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close notifications'));
    expect(onClose).toHaveBeenCalledTimes(1);
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
