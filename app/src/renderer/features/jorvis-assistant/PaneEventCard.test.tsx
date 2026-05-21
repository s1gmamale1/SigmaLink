// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaneEventCard, type PaneEvent } from './PaneEventCard';

const base: PaneEvent = {
  id: 'evt-1',
  conversationId: 'conv-1',
  sessionId: 'sess-12345678',
  kind: 'exited',
  ts: Date.now(),
};

describe('<PaneEventCard />', () => {
  it('renders exited event', () => {
    render(<PaneEventCard event={base} />);
    expect(screen.getByText('Pane exited')).toBeTruthy();
    expect(screen.getByText(/sess-123/)).toBeTruthy();
  });

  it('renders error event with exit code', () => {
    render(<PaneEventCard event={{ ...base, kind: 'error', body: { exitCode: 1 } }} />);
    expect(screen.getByText('Pane error')).toBeTruthy();
    expect(screen.getByText(/exit 1/)).toBeTruthy();
  });

  it('fires onReply when clicked', () => {
    const onReply = vi.fn();
    render(<PaneEventCard event={base} onReply={onReply} />);
    fireEvent.click(screen.getByText('Reply to pane'));
    expect(onReply).toHaveBeenCalledWith(base);
  });
});
