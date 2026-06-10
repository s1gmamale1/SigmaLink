// @vitest-environment jsdom
//
// Perf audit 2026-06-10 #3 — ChatTranscript row memoization.
// JorvisRoom re-renders the whole transcript on every stream delta; committed
// rows have stable props (same message object identity, isStreaming=false) so
// memo(ChatRow) must skip them. Probe: every ChatRow render calls
// useJorvisStreamReveal exactly once — mock it with a counter.
// Also: historical tool rows must not re-run JSON.parse(content) per delta.
// MUST-PRESERVE pin: the sentinel→committed key handoff (Phase-6 H1
// anti-double-spring) still re-renders the transitioning row.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const revealMock = vi.hoisted(() =>
  vi.fn(() => ({ revealed: '', caret: false })),
);
vi.mock('./use-jorvis-stream-reveal', () => ({
  useJorvisStreamReveal: revealMock,
}));
// InlineToolChips subscribes to live events; not under test.
vi.mock('./InlineToolChips', () => ({
  InlineToolChips: () => null,
}));

import { ChatTranscript, type ChatMessageView } from './ChatTranscript';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const committed: ChatMessageView[] = [
  { id: 'm1', role: 'user', content: 'hi', createdAt: 1000 },
  { id: 'm2', role: 'assistant', content: 'hello', createdAt: 2000 },
  { id: 'm3', role: 'tool', content: '{"tool":"ok","n":1}', toolCallId: 'tc1', createdAt: 3000 },
];

describe('ChatTranscript memo(ChatRow) (perf audit #3)', () => {
  it('a stream delta re-renders ONLY the in-flight sentinel row', () => {
    const { rerender } = render(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'a', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    // Mount: 3 committed rows + 1 sentinel = 4 hook calls.
    expect(revealMock.mock.calls.length).toBe(4);

    // New delta, SAME messages array identity (mirrors JorvisRoom: only the
    // streaming object changes between deltas).
    rerender(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'ab', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    // Only the sentinel re-renders → exactly +1.
    expect(revealMock.mock.calls.length).toBe(5);
  });

  it('does not re-run JSON.parse on a historical tool row per stream delta', () => {
    const toolContent = '{"tool":"ok","n":1}';
    const parseSpy = vi.spyOn(JSON, 'parse');
    const callsForTool = () =>
      parseSpy.mock.calls.filter((c) => c[0] === toolContent).length;

    const { rerender } = render(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'a', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    expect(callsForTool()).toBe(1); // parsed once on mount

    rerender(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'ab', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    expect(callsForTool()).toBe(1); // NOT re-parsed on the delta re-render
    parseSpy.mockRestore();
  });

  it('control: the sentinel→committed transition still re-renders the row (key handoff preserved)', () => {
    const { rerender } = render(
      <ChatTranscript
        messages={committed}
        streaming={{ turnId: 't1', delta: 'done', messageId: 'm-new' }}
        conversationId="c1"
      />,
    );
    const before = revealMock.mock.calls.length;
    // Turn commits: the standby handler appends the committed twin with the
    // SAME id the sentinel row was keyed by (Phase-6 H1 anti-double-spring).
    rerender(
      <ChatTranscript
        messages={[
          ...committed,
          { id: 'm-new', role: 'assistant', content: 'done', createdAt: 4000 },
        ]}
        streaming={null}
        conversationId="c1"
      />,
    );
    // The m-new row's props changed (isStreaming flips, message swaps) —
    // memo must NOT block this render.
    expect(revealMock.mock.calls.length).toBeGreaterThan(before);
  });
});
