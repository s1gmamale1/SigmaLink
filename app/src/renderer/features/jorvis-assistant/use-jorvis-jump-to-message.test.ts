// @vitest-environment jsdom
//
// 2026-06-10 audit finding #3 — the jump-to-message highlight must retry
// across frames (the hydrate commit can flush AFTER the first rAF) and the
// 1.5s class-removal timer must be cleared on unmount (it otherwise holds a
// detached transcript node).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { set: vi.fn().mockResolvedValue(undefined) } },
}));

import { useJorvisJumpToMessage } from './use-jorvis-jump-to-message';

let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): void {
  const queue = rafQueue;
  rafQueue = [];
  act(() => {
    queue.forEach((cb) => cb(0));
  });
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  rafQueue = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  // jsdom has no scrollIntoView.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountHook() {
  const hydrateConversation = vi.fn(async () => {});
  const transcriptRef = { current: container as HTMLDivElement | null };
  const r = renderHook(() =>
    useJorvisJumpToMessage({ conversationId: 'c1', hydrateConversation, transcriptRef }),
  );
  return { ...r, hydrateConversation };
}

function dispatchJump(messageId: string): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('jorvis:jump-to-message', {
        detail: { conversationId: 'c1', messageId },
      }),
    );
  });
}

function addRow(messageId: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-message-id', messageId);
  container.appendChild(el);
  return el;
}

describe('useJorvisJumpToMessage — highlight retry + timer hygiene', () => {
  it('retries across frames when the message row commits after the first frame', () => {
    mountHook();
    dispatchJump('m1');

    flushRaf(); // frame 1 — row not in the DOM yet (commit hasn't flushed)
    const el = addRow('m1');
    flushRaf(); // frame 2 — the retry must find it (pre-fix: single rAF, no retry)

    expect(el.classList.contains('ring-2')).toBe(true);
  });

  it('clears the 1.5s highlight-removal timer on unmount (no detached-node hold)', () => {
    const el = addRow('m2');
    const { unmount } = mountHook();
    dispatchJump('m2');
    flushRaf();
    expect(el.classList.contains('ring-2')).toBe(true);

    unmount();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    // The removal callback must NOT have run after unmount — its timer was
    // cleared in cleanup, so it no longer pins the detached node. Pre-fix the
    // timer survives unmount, fires at 1.5s, and strips the class.
    expect(el.classList.contains('ring-2')).toBe(true);
  });
});
