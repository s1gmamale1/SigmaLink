// @vitest-environment jsdom
//
// v1.4.9 #07 — NotificationBell unit tests. Covers D4 badge math (color +
// label thresholds) and D1 critical pulse class application.
// UX-2 — the bell is now the trigger of a Radix Popover whose content is the
//   NotificationDropdown. Tests assert the trigger wiring (open on click,
//   dropdown mounts in the portal) + that the UX-9 critical bell classes are
//   preserved on the trigger button.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotificationBell } from './NotificationBell';
import { deriveBadgeState } from './helpers';
import type { AppState } from '@/renderer/app/state.types';
import { initialAppState } from '@/renderer/app/state.types';
import type { Notification, NotificationSeverity } from '@/shared/types';

vi.mock('@/renderer/lib/drag-region', () => ({ noDragStyle: () => ({}) }));

// Mock the dropdown — we test it separately. It only mounts inside the
// Popover's portal when the bell trigger is open.
vi.mock('./NotificationDropdown', () => ({
  NotificationDropdown: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="notification-dropdown" onClick={onClose} />
  ),
}));

// Mutable state holder so each test customises the AppState the granular
// `useAppStateSelector` mock reads from without re-importing. PERF-3 — the
// component now selects `s.notifications` + `s.notificationsUnreadCount` via
// useAppStateSelector and never reads dispatch.
let mockState: AppState = { ...initialAppState };
vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (sel: (s: AppState) => unknown) => sel(mockState),
  useAppDispatch: () => vi.fn(),
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

  it('applies the UX-9 critical bell classes when an unread critical exists (D1)', () => {
    mockState = {
      ...initialAppState,
      notifications: [makeNotification({ id: 'a', severity: 'critical' })],
      notificationsUnreadCount: 1,
    };
    render(<NotificationBell />);
    const btn = screen.getByTestId('notification-bell');
    // UX-9 preserved: animated pulse + the static accent companion for
    // reduced-motion operators.
    expect(btn.className).toContain('sl-bell-pulse');
    expect(btn.className).toContain('sl-bell-critical-static');
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
    expect(btn.className).not.toContain('sl-bell-critical-static');
  });

  it('UX-2 — the bell is the Popover trigger; dropdown is closed until clicked', async () => {
    mockState = { ...initialAppState, notifications: [], notificationsUnreadCount: 0 };
    render(<NotificationBell />);
    // Closed: the portal'd PopoverContent (and thus the dropdown) is unmounted.
    expect(screen.queryByTestId('notification-dropdown')).toBeNull();
    const trigger = screen.getByTestId('notification-bell');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    // Click the trigger → Popover opens → dropdown mounts in the portal.
    fireEvent.click(trigger);
    expect(await screen.findByTestId('notification-dropdown')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });
});
