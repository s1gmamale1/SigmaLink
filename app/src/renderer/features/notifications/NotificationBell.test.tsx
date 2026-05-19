// @vitest-environment jsdom
//
// v1.4.9 #07 — NotificationBell unit tests. Covers D4 badge math (color +
// label thresholds) and D1 critical pulse class application.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NotificationBell } from './NotificationBell';
import { deriveBadgeState } from './helpers';
import type { AppState } from '@/renderer/app/state.types';
import { initialAppState } from '@/renderer/app/state.types';
import type { Notification, NotificationSeverity } from '@/shared/types';

vi.mock('@/renderer/lib/drag-region', () => ({ noDragStyle: () => ({}) }));

// Mock the dropdown — we test it separately.
vi.mock('./NotificationDropdown', () => ({
  NotificationDropdown: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="notification-dropdown" onClick={onClose} />
  ),
}));

// Mutable state holder so each test customises the AppState used by the
// `useAppState` mock without re-importing.
let mockState: AppState = { ...initialAppState };
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({ state: mockState, dispatch: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  mockState = { ...initialAppState };
});

function makeNotification(
  partial: Partial<Notification> & { id: string; severity: NotificationSeverity },
): Notification {
  return {
    workspaceId: 'ws-1',
    kind: 'pty-exit',
    title: 'title',
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

describe('deriveBadgeState (D4 badge math)', () => {
  it('returns no label when unread is 0', () => {
    expect(deriveBadgeState(0, false, false, false)).toEqual({
      label: null,
      colorClass: '',
    });
  });

  it('numbers 1..9 verbatim', () => {
    expect(deriveBadgeState(1, false, false, false).label).toBe('1');
    expect(deriveBadgeState(9, false, false, false).label).toBe('9');
  });

  it('caps at 9+ for 10 or more', () => {
    expect(deriveBadgeState(10, false, false, false).label).toBe('9+');
    expect(deriveBadgeState(99, false, false, false).label).toBe('9+');
  });

  it('paints red when error present', () => {
    expect(deriveBadgeState(3, true, false, false).colorClass).toContain('red');
  });

  it('paints red when critical present', () => {
    expect(deriveBadgeState(3, false, true, false).colorClass).toContain('red');
  });

  it('paints amber when warn is the highest', () => {
    expect(deriveBadgeState(3, false, false, true).colorClass).toContain('amber');
  });

  it('paints gray when only info is unread', () => {
    expect(deriveBadgeState(3, false, false, false).colorClass).toContain('muted-foreground');
  });
});

describe('NotificationBell', () => {
  it('renders no badge when unreadCount is 0', () => {
    mockState = { ...initialAppState, notifications: [], notificationsUnreadCount: 0 };
    render(<NotificationBell />);
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
  });

  it('renders a numeric badge for unread < 10', () => {
    mockState = {
      ...initialAppState,
      notifications: [makeNotification({ id: 'a', severity: 'info' })],
      notificationsUnreadCount: 3,
    };
    render(<NotificationBell />);
    expect(screen.getByTestId('notification-bell-badge').textContent).toBe('3');
  });

  it("renders '9+' for unread >= 10", () => {
    mockState = {
      ...initialAppState,
      notifications: [makeNotification({ id: 'a', severity: 'info' })],
      notificationsUnreadCount: 25,
    };
    render(<NotificationBell />);
    expect(screen.getByTestId('notification-bell-badge').textContent).toBe('9+');
  });

  it('applies sl-bell-pulse class when an unread critical exists (D1)', () => {
    mockState = {
      ...initialAppState,
      notifications: [makeNotification({ id: 'a', severity: 'critical' })],
      notificationsUnreadCount: 1,
    };
    render(<NotificationBell />);
    const btn = screen.getByTestId('notification-bell');
    expect(btn.className).toContain('sl-bell-pulse');
  });

  it('does NOT pulse when criticals are all read', () => {
    mockState = {
      ...initialAppState,
      notifications: [
        makeNotification({ id: 'a', severity: 'critical', readAt: Date.now() }),
      ],
      notificationsUnreadCount: 0,
    };
    render(<NotificationBell />);
    const btn = screen.getByTestId('notification-bell');
    expect(btn.className).not.toContain('sl-bell-pulse');
  });
});
