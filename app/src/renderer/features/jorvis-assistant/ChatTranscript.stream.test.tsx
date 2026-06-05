// @vitest-environment jsdom
//
// Tests for stream-reveal wiring and spring bubble-enter in ChatTranscript.

import { render, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => false }));

let raf: ((t: number) => void)[] = [];
beforeEach(() => {
  raf = [];
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { raf.push(cb); return raf.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const flush = (n: number) => {
  for (let i = 0; i < n; i++) {
    const cbs = raf;
    raf = [];
    cbs.forEach((cb) => cb(0));
  }
};

import { ChatTranscript, type ChatMessageView } from './ChatTranscript';

const olderMsg: ChatMessageView = {
  id: 'm1',
  role: 'assistant',
  content: 'older reply',
  createdAt: 1000,
};

describe('ChatTranscript stream-reveal', () => {
  it('completed rows render full content; in-flight row reveals progressively and shows a caret', () => {
    const { getByText, queryAllByTestId, rerender } = render(
      <ChatTranscript
        messages={[olderMsg]}
        streaming={{ turnId: 't1', delta: 'new reply' }}
      />,
    );
    // The older, completed row renders its full content immediately.
    expect(getByText('older reply')).toBeTruthy();

    // The in-flight row starts with no revealed text (count=0).
    // After one frame, some text should be revealed.
    act(() => flush(1));

    // After many frames, the full new reply text should appear somewhere.
    act(() => flush(20));
    expect(getByText(/new reply/)).toBeTruthy();

    // Caret element should be present while streaming (active=true).
    const carets = document.querySelectorAll('[data-caret]');
    expect(carets.length).toBeGreaterThan(0);

    // Once streaming stops (active=false), caret should disappear and full text shown.
    rerender(
      <ChatTranscript
        messages={[olderMsg, { id: 'm2', role: 'assistant', content: 'new reply', createdAt: 2000 }]}
        streaming={null}
      />,
    );
    act(() => flush(1));
    const caretsAfter = document.querySelectorAll('[data-caret]');
    expect(caretsAfter.length).toBe(0);

    void queryAllByTestId; // suppress unused
  });
});

describe('ChatTranscript spring bubble-enter', () => {
  it('springs a bubble in on first mount only', () => {
    const msg: ChatMessageView = { id: 'm1', role: 'assistant', content: 'hello', createdAt: 1000 };
    const { getByTestId, rerender } = render(
      <ChatTranscript messages={[msg]} streaming={null} />,
    );
    const row = getByTestId('chat-row-m1');
    // The enter animation class is applied on first mount.
    expect(row.className).toContain('sl-slide-up');
    // The playedRef marker confirms it was applied.
    expect(row.dataset.entered).toBe('1');

    // A re-render (simulating a new streaming delta) does NOT re-apply or reset.
    rerender(
      <ChatTranscript
        messages={[msg]}
        streaming={{ turnId: 't1', delta: 'extra', messageId: null }}
      />,
    );
    expect(row.dataset.entered).toBe('1');
  });

  it('does NOT re-spring when the streamed bubble commits (spring in once)', () => {
    // While streaming, the in-flight sentinel is keyed by the turn's eventual
    // messageId ('msg-1'). When the turn commits, `messages` gains a row with
    // that same id and `streaming` clears. React must REUSE the same DOM node
    // across the commit (same key) so the bubble does not jump + re-fade.
    const { getByTestId, rerender } = render(
      <ChatTranscript
        messages={[]}
        streaming={{ turnId: 't1', delta: 'streamed reply', messageId: 'msg-1' }}
      />,
    );

    // The in-flight row springs in on first appearance (genuine new bubble).
    const streamedRow = getByTestId('chat-row-msg-1');
    expect(streamedRow.className).toContain('sl-slide-up');
    expect(streamedRow.dataset.entered).toBe('1');

    // Strip the class so a RE-application would be detectable, and capture the
    // node identity to prove React reuses the same DOM node (no remount).
    streamedRow.classList.remove('sl-slide-up');
    expect(streamedRow.className).not.toContain('sl-slide-up');

    // Commit: streaming clears + the committed message (same id) lands.
    rerender(
      <ChatTranscript
        messages={[{ id: 'msg-1', role: 'assistant', content: 'streamed reply', createdAt: 2000 }]}
        streaming={null}
      />,
    );

    // SAME DOM node (no remount) — identity preserved.
    const committedRow = getByTestId('chat-row-msg-1');
    expect(committedRow).toBe(streamedRow);
    // The enter marker carried over (first-mount effect did not re-run) and the
    // enter class was NOT re-added → no second spring.
    expect(committedRow.dataset.entered).toBe('1');
    expect(committedRow.className).not.toContain('sl-slide-up');
  });
});
