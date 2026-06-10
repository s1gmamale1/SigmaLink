// @vitest-environment jsdom
//
// 2026-06-10 audit finding #4 — the standby commit must NOT be a setState
// dispatched from inside the setStreaming updater. StrictMode (and concurrent
// rebase) re-invokes functional updaters; a nested setMessages re-fires.
// Post-fix: the handler mirrors the stream buffer synchronously on
// `streamingRef` and commits via a SIBLING setMessages call.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import type { ChatMessageView } from './ChatTranscript';

type EventCb = (payload: unknown) => void;
const handlers = new Map<string, Set<EventCb>>();
function emit(name: string, payload: unknown): void {
  act(() => {
    handlers.get(name)?.forEach((fn) => fn(payload));
  });
}

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    ruflo: { 'patterns.store': vi.fn().mockResolvedValue({ ok: true }) },
  },
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

import { useJorvisAssistantState } from './use-jorvis-assistant-state';

type StreamingBuf = { turnId: string; delta: string; messageId: string | null } | null;

afterEach(() => {
  handlers.clear();
  cleanup();
  vi.clearAllMocks();
});

function mountHandler() {
  const setMessages = vi.fn();
  const setOrbState = vi.fn();
  const setBusy = vi.fn();
  const setStreaming = vi.fn();
  const lastSentPromptRef = { current: null as string | null };
  const rufloReadyRef = { current: false };
  const activeTurnIdRef = { current: 't1' as string | null };
  const busyRef = { current: true };
  const streamingRef = { current: null as StreamingBuf };
  const clearWatchdog = vi.fn();

  renderHook(() =>
    useJorvisAssistantState({
      conversationId: 'c1',
      setMessages,
      setOrbState,
      setBusy,
      setStreaming,
      lastSentPromptRef,
      rufloReadyRef,
      activeTurnIdRef,
      busyRef,
      streamingRef,
      clearWatchdog,
    }),
  );

  return { setMessages, setStreaming, streamingRef };
}

describe('useJorvisAssistantState — standby commit is a sibling setState', () => {
  it('commits exactly one message even when streaming updaters are re-invoked (StrictMode)', () => {
    const { setMessages, setStreaming, streamingRef } = mountHandler();

    emit('assistant:state', {
      kind: 'delta',
      delta: 'Hello world',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });
    // Post-fix the handler mirrors the buffer SYNCHRONOUSLY on the ref so a
    // standby in the same tick can read the full delta.
    expect(streamingRef.current).toEqual({ turnId: 't1', delta: 'Hello world', messageId: 'm1' });

    emit('assistant:state', {
      kind: 'state',
      state: 'standby',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });

    // StrictMode simulation: React re-invokes FUNCTIONAL updaters. Any
    // updater handed to setStreaming must be pure — re-running it must not
    // re-fire a sibling setState. Pre-fix the commit lives INSIDE the
    // setStreaming updater, so this loop drives setMessages a second time.
    const prevBuf: StreamingBuf = { turnId: 't1', delta: 'Hello world', messageId: 'm1' };
    for (const call of setStreaming.mock.calls) {
      const arg = call[0] as unknown;
      if (typeof arg === 'function') {
        (arg as (p: StreamingBuf) => StreamingBuf)(prevBuf);
        (arg as (p: StreamingBuf) => StreamingBuf)(prevBuf);
      }
    }
    expect(setMessages).toHaveBeenCalledTimes(1);

    // The committed row carries the buffered delta; idempotency guard intact.
    const updater = setMessages.mock.calls[0][0] as (rows: ChatMessageView[]) => ChatMessageView[];
    const rows = updater([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', role: 'assistant', content: 'Hello world' });
    expect(updater(rows)).toBe(rows);

    // The buffer is retired once the turn commits.
    expect(streamingRef.current).toBeNull();
    expect(setStreaming).toHaveBeenLastCalledWith(null);
  });

  it('accumulates same-tick deltas through the ref (no lost chunks)', () => {
    const { setStreaming, streamingRef } = mountHandler();
    emit('assistant:state', {
      kind: 'delta',
      delta: 'Hello ',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });
    emit('assistant:state', {
      kind: 'delta',
      delta: 'world',
      conversationId: 'c1',
      turnId: 't1',
      messageId: 'm1',
    });
    expect(streamingRef.current).toEqual({ turnId: 't1', delta: 'Hello world', messageId: 'm1' });
    expect(setStreaming).toHaveBeenLastCalledWith({
      turnId: 't1',
      delta: 'Hello world',
      messageId: 'm1',
    });
  });
});
