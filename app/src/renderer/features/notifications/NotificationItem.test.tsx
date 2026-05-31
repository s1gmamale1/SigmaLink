// @vitest-environment jsdom
//
// v1.4.9 #07 — NotificationItem unit tests. Covers severity-class mapping,
// dup-count badge visibility, read styling, and hover-control wiring.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotificationItem } from './NotificationItem';
import { severityClass } from './helpers';
import type { Notification, NotificationSeverity } from '@/shared/types';

afterEach(() => cleanup());

function makeN(
  partial: Partial<Notification> & { id: string; severity: NotificationSeverity },
): Notification {
  return {
    workspaceId: 'ws-1',
    kind: 'pty-exit',
    title: 'title-' + partial.id,
    body: 'body',
    payload: null,
    sourceEvent: null,
    dedupKey: 'k-' + partial.id,
    dupCount: 1,
    createdAt: Date.now(),
    readAt: null,
    ...partial,
  };
}

describe('severityClass (D1)', () => {
  it('maps info → muted', () => expect(severityClass('info')).toContain('muted'));
  it('maps warn → amber', () => expect(severityClass('warn')).toContain('amber'));
  it('maps error → red', () => expect(severityClass('error')).toContain('red'));
  it('maps critical → red + pulse', () => {
    const cls = severityClass('critical');
    expect(cls).toContain('red');
    expect(cls).toContain('sl-bell-pulse');
  });
});

describe('NotificationItem', () => {
  it('shows dup-count badge when dupCount > 1 (D3)', () => {
    const onClick = vi.fn();
    render(
      <NotificationItem
        notification={makeN({ id: 'a', severity: 'info', dupCount: 5 })}
        onClick={onClick}
        onDismiss={() => undefined}
        onMarkUnread={() => undefined}
      />,
    );
    expect(screen.getByTestId('notification-dup-a').textContent).toBe('×5');
  });

  it('omits dup-count badge when dupCount === 1', () => {
    render(
      <NotificationItem
        notification={makeN({ id: 'a', severity: 'info', dupCount: 1 })}
        onClick={() => undefined}
        onDismiss={() => undefined}
        onMarkUnread={() => undefined}
      />,
    );
    expect(screen.queryByTestId('notification-dup-a')).toBeNull();
  });

  it('renders read styling when readAt is set (D5)', () => {
    render(
      <NotificationItem
        notification={makeN({ id: 'a', severity: 'info', readAt: Date.now() })}
        onClick={() => undefined}
        onDismiss={() => undefined}
        onMarkUnread={() => undefined}
      />,
    );
    const row = screen.getByTestId('notification-item-a');
    expect(row.dataset.read).toBe('1');
  });

  it('renders Mark unread only when read (D5 — separation of concerns)', () => {
    const { rerender } = render(
      <NotificationItem
        notification={makeN({ id: 'a', severity: 'info', readAt: null })}
        onClick={() => undefined}
        onDismiss={() => undefined}
        onMarkUnread={() => undefined}
      />,
    );
    expect(screen.queryByTestId('notification-mark-unread-a')).toBeNull();
    rerender(
      <NotificationItem
        notification={makeN({ id: 'a', severity: 'info', readAt: Date.now() })}
        onClick={() => undefined}
        onDismiss={() => undefined}
        onMarkUnread={() => undefined}
      />,
    );
    expect(screen.queryByTestId('notification-mark-unread-a')).toBeTruthy();
  });

  it('wires the dismiss button (D5)', () => {
    const onDismiss = vi.fn();
    render(
      <NotificationItem
        notification={makeN({ id: 'a', severity: 'info' })}
        onClick={() => undefined}
        onDismiss={onDismiss}
        onMarkUnread={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('notification-dismiss-a'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clicking the body invokes onClick (deep-link + mark-read per D5)', () => {
    const onClick = vi.fn();
    render(
      <NotificationItem
        notification={makeN({ id: 'a', severity: 'info' })}
        onClick={onClick}
        onDismiss={() => undefined}
        onMarkUnread={() => undefined}
      />,
    );
    // UX-9 — aria-label now prefixes the severity word: "Info: title-a".
    fireEvent.click(screen.getByLabelText(/title-a/));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
