// @vitest-environment jsdom
//
// Tests for InlineToolChips — per-turn inline tool-chip rail.
// Reuses the onEvent/emitEvent mock pattern from JorvisRoom.b3.test.tsx.

import { render, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable event bus — same pattern as JorvisRoom.b3.test.tsx.
type EventCb = (payload: unknown) => void;
const handlers = new Map<string, Set<EventCb>>();

function emitEvent(name: string, payload: unknown): void {
  handlers.get(name)?.forEach((fn) => fn(payload));
}

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {},
  rpcSilent: {},
  onEvent: (name: string, cb: EventCb) => {
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(cb);
    return () => {
      handlers.get(name)?.delete(cb);
    };
  },
}));

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import { InlineToolChips } from './InlineToolChips';

describe('InlineToolChips', () => {
  it('renders a chip per tool-trace for the active conversationId, ignores other conversations', () => {
    const { getAllByTestId, queryByText } = render(
      <InlineToolChips conversationId="c1" turnId="t1" />,
    );

    // Emit a trace for the active conversation.
    act(() => {
      emitEvent('assistant:tool-trace', {
        id: 'trace-1',
        conversationId: 'c1',
        name: 'Read',
        startedAt: 1000,
        finishedAt: 1012,
        ok: true,
      });
    });

    // Emit a trace for a DIFFERENT conversation — must be ignored.
    act(() => {
      emitEvent('assistant:tool-trace', {
        id: 'trace-9',
        conversationId: 'c9',
        name: 'Bash',
        startedAt: 1000,
        finishedAt: 1005,
        ok: true,
      });
    });

    const chips = getAllByTestId('tool-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain('Read');
    // durationMs = 12ms
    expect(chips[0].textContent).toContain('12ms');
    // The Bash chip for a different conversation should NOT be rendered.
    expect(queryByText('Bash')).toBeNull();
  });

  it('shows an ok (green) status dot for successful traces and amber for errors', () => {
    const { getAllByTestId } = render(
      <InlineToolChips conversationId="c2" turnId="t2" />,
    );

    act(() => {
      emitEvent('assistant:tool-trace', {
        id: 'ok-trace',
        conversationId: 'c2',
        name: 'Write',
        startedAt: 1000,
        finishedAt: 1050,
        ok: true,
      });
      emitEvent('assistant:tool-trace', {
        id: 'err-trace',
        conversationId: 'c2',
        name: 'Bash',
        startedAt: 1000,
        finishedAt: 1200,
        ok: false,
        error: 'command failed',
      });
    });

    const chips = getAllByTestId('tool-chip');
    expect(chips).toHaveLength(2);
    // Check that status dots exist with appropriate classes.
    const dots = document.querySelectorAll('[aria-hidden="true"]');
    const dotClasses = Array.from(dots).map((d) => d.className);
    expect(dotClasses.some((c) => c.includes('emerald'))).toBe(true);
    expect(dotClasses.some((c) => c.includes('amber'))).toBe(true);
  });

  it('renders nothing when no traces have arrived', () => {
    const { container } = render(
      <InlineToolChips conversationId="c3" turnId="t3" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('cleans up subscription on unmount', () => {
    const { unmount } = render(
      <InlineToolChips conversationId="c4" turnId="t4" />,
    );
    unmount();
    // After unmount, emitting an event should not throw / cause state updates.
    expect(() => {
      act(() => {
        emitEvent('assistant:tool-trace', {
          id: 'after-unmount',
          conversationId: 'c4',
          name: 'Read',
          startedAt: 1000,
          finishedAt: 1010,
          ok: true,
        });
      });
    }).not.toThrow();
  });
});
