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
import { applyFilter, groupBySource, maxSeverity } from './helpers';
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

// ---- NTF-2 grouping helpers -------------------------------------------------

describe('groupBySource', () => {
  it('buckets rows by source in NOTIFICATION_SOURCES order, omitting empty', () => {
    const notes = [
      makeN({ id: 's1', severity: 'info', kind: 'swarm-broadcast' }),
      makeN({ id: 'p1', severity: 'warn', kind: 'pty-exit' }),
      makeN({ id: 't1', severity: 'error', kind: 'tool-error' }),
    ];
    const groups = groupBySource(notes);
    // Canonical order is pty → swarm → tool → system; `system` is empty here.
    expect(groups.map((g) => g.source)).toEqual(['pty', 'swarm', 'tool']);
    expect(groups.find((g) => g.source === 'pty')?.items.map((n) => n.id)).toEqual(['p1']);
  });

  it('preserves incoming (created-desc) order within a section', () => {
    const notes = [
      makeN({ id: 'p2', severity: 'info', kind: 'pty-exit' }),
      makeN({ id: 'p1', severity: 'info', kind: 'pty-exit' }),
    ];
    const groups = groupBySource(notes);
    expect(groups[0].items.map((n) => n.id)).toEqual(['p2', 'p1']);
  });

  it('counts only unread rows per section', () => {
    const notes = [
      makeN({ id: 'p1', severity: 'info', kind: 'pty-exit', readAt: null }),
      makeN({ id: 'p2', severity: 'info', kind: 'pty-exit', readAt: 123 }),
    ];
    const grp = groupBySource(notes)[0];
    expect(grp.items).toHaveLength(2);
    expect(grp.unreadCount).toBe(1);
  });

  it('returns [] for an empty list', () => {
    expect(groupBySource([])).toEqual([]);
  });
});

describe('maxSeverity', () => {
  it('returns the highest-ranked severity (critical > error > warn > info)', () => {
    expect(
      maxSeverity([
        makeN({ id: 'a', severity: 'info' }),
        makeN({ id: 'b', severity: 'error' }),
        makeN({ id: 'c', severity: 'warn' }),
      ]),
    ).toBe('error');
    expect(
      maxSeverity([
        makeN({ id: 'a', severity: 'warn' }),
        makeN({ id: 'b', severity: 'critical' }),
      ]),
    ).toBe('critical');
  });

  it('returns null for an empty list', () => {
    expect(maxSeverity([])).toBeNull();
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

  it('NTF-2 — groups rows into source sections with labels + unread counts', () => {
    mockState = {
      ...initialAppState,
      notifications: [
        makeN({ id: 'p1', severity: 'info', kind: 'pty-exit' }),
        makeN({ id: 'p2', severity: 'info', kind: 'pty-exit', readAt: Date.now() }),
        makeN({ id: 's1', severity: 'warn', kind: 'swarm-broadcast' }),
      ],
    };
    render(<NotificationDropdown onClose={() => undefined} />);
    // Two sections rendered: pty + swarm (tool + system absent).
    expect(screen.getByTestId('notification-section-pty')).toBeTruthy();
    expect(screen.getByTestId('notification-section-swarm')).toBeTruthy();
    expect(screen.queryByTestId('notification-section-tool')).toBeNull();
    // pty has 1 unread of 2 rows → count badge shows "1".
    expect(screen.getByTestId('notification-section-count-pty').textContent).toBe('1');
    // Both pty rows render under the section.
    expect(screen.getByTestId('notification-item-p1')).toBeTruthy();
    expect(screen.getByTestId('notification-item-p2')).toBeTruthy();
  });

  it('NTF-2 — collapsing a section hides its items (default expanded)', () => {
    mockState = {
      ...initialAppState,
      notifications: [
        makeN({ id: 'p1', severity: 'info', kind: 'pty-exit' }),
        makeN({ id: 's1', severity: 'warn', kind: 'swarm-broadcast' }),
      ],
    };
    render(<NotificationDropdown onClose={() => undefined} />);
    // Default: expanded → both items visible.
    expect(screen.getByTestId('notification-item-p1')).toBeTruthy();
    expect(screen.getByTestId('notification-item-s1')).toBeTruthy();
    // Collapse the pty section.
    fireEvent.click(screen.getByTestId('notification-section-toggle-pty'));
    expect(screen.queryByTestId('notification-item-p1')).toBeNull();
    // The other section is unaffected.
    expect(screen.getByTestId('notification-item-s1')).toBeTruthy();
    // aria-expanded reflects the collapsed state.
    expect(
      screen.getByTestId('notification-section-toggle-pty').getAttribute('aria-expanded'),
    ).toBe('false');
    // Re-expand restores the items.
    fireEvent.click(screen.getByTestId('notification-section-toggle-pty'));
    expect(screen.getByTestId('notification-item-p1')).toBeTruthy();
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
