// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ConversationsPanel, type ConversationListItem } from './ConversationsPanel';

afterEach(() => {
  cleanup();
});

function row(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: 'conversation-1',
    title: 'Launch the workspace panes',
    lastMessageAt: Date.now(),
    messageCount: 3,
    claudeSessionId: null,
    ...overrides,
  };
}

describe('<ConversationsPanel />', () => {
  it('shows a resumable pill for rows with a Claude session id', () => {
    const { getByText, getByTestId } = render(
      <ConversationsPanel
        items={[row({ claudeSessionId: '11111111-1111-4111-8111-111111111111' })]}
        activeId={null}
        onPick={vi.fn()}
        onNew={vi.fn()}
      />,
    );

    expect(getByText('Launch the workspace panes')).toBeTruthy();
    expect(getByTestId('bridge-resumable-pill').textContent).toContain('Resumable');
  });

  it('omits the resumable pill for non-resumable rows', () => {
    const { queryByTestId } = render(
      <ConversationsPanel
        items={[row()]}
        activeId={null}
        onPick={vi.fn()}
        onNew={vi.fn()}
      />,
    );

    expect(queryByTestId('bridge-resumable-pill')).toBeNull();
  });
});
