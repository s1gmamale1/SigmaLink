// @vitest-environment jsdom
//
// Pre-v3 fix — the P0.2 Retry button's visibility rule. The old rule ("the
// most recent error row, anywhere in the transcript") meant the button
// rendered FOREVER once any turn had errored: after later successful turns
// its click re-sent whatever prompt lastSentPromptRef held by then — a
// stale/duplicated send that could orphan a live turn. New rule: Retry only
// when the error row is the LAST committed message (nothing has happened
// since the failure).

import { render, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => true }));

import { ChatTranscript, type ChatMessageView } from './ChatTranscript';

afterEach(cleanup);

const userMsg = (id: string, at: number): ChatMessageView => ({
  id,
  role: 'user',
  content: `prompt ${id}`,
  createdAt: at,
});

const errorMsg = (id: string, at: number): ChatMessageView => ({
  id,
  role: 'error',
  content: 'Jorvis hit an error',
  createdAt: at,
});

const assistantMsg = (id: string, at: number): ChatMessageView => ({
  id,
  role: 'assistant',
  content: 'a successful reply',
  createdAt: at,
});

describe('ChatTranscript Retry visibility', () => {
  it('shows Retry when the error row is the last committed message, and click fires onRetry', () => {
    const onRetry = vi.fn();
    const { getByText } = render(
      <ChatTranscript
        messages={[userMsg('u1', 1), errorMsg('e1', 2)]}
        streaming={null}
        pending={false}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides Retry once ANY later message follows the error row (stale-retry guard)', () => {
    const { queryByText } = render(
      <ChatTranscript
        messages={[userMsg('u1', 1), errorMsg('e1', 2), userMsg('u2', 3), assistantMsg('a1', 4)]}
        streaming={null}
        pending={false}
        onRetry={vi.fn()}
      />,
    );
    expect(queryByText('Retry')).toBeNull();
  });

  it('renders no Retry when onRetry is not provided (JorvisRoom withholds it while busy)', () => {
    const { queryByText } = render(
      <ChatTranscript
        messages={[userMsg('u1', 1), errorMsg('e1', 2)]}
        streaming={null}
        pending={false}
      />,
    );
    expect(queryByText('Retry')).toBeNull();
  });
});
