// @vitest-environment jsdom
//
// 2026-06-10 finding 4 — module-scope SIGMA::PROMPT watcher.
//
// The bus has no replay, so a watcher that only lives while PaneShell is
// mounted loses prompt lines arriving during a room/workspace switch. This
// watcher persists at module scope (the hasPtyDataArrived pattern): once
// installed for a session it keeps parsing while NO component is mounted,
// and the last valid prompt is waiting at the next mount.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (p: { sessionId: string; data: string }) => void;
const busSubscribers = new Map<string, Set<Listener>>();
const busUnsubscribeSpy = vi.fn();

vi.mock('@/renderer/lib/pty-data-bus', () => ({
  subscribePtyData: (sessionId: string, fn: Listener) => {
    let set = busSubscribers.get(sessionId);
    if (!set) {
      set = new Set();
      busSubscribers.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      busUnsubscribeSpy(sessionId);
      busSubscribers.get(sessionId)?.delete(fn);
    };
  },
}));

import {
  clearActivePrompt,
  disposePromptWatcher,
  ensurePromptWatcher,
  getActivePrompt,
  subscribeActivePrompt,
  __resetPromptWatchers,
} from './prompt-watcher';

function emit(sessionId: string, data: string): void {
  busSubscribers.get(sessionId)?.forEach((fn) => fn({ sessionId, data }));
}

const VALID =
  'SIGMA::PROMPT {"question":"Pick one","type":"single","choices":["red","blue"]}\n';

beforeEach(() => {
  __resetPromptWatchers();
  busSubscribers.clear();
  busUnsubscribeSpy.mockClear();
});

describe('prompt-watcher', () => {
  it('captures a prompt with NO component subscriber attached (the remount-gap bug)', () => {
    ensurePromptWatcher('s1');
    emit('s1', VALID); // arrives while the pane is unmounted
    expect(getActivePrompt('s1')).toMatchObject({
      question: 'Pick one',
      type: 'single',
      choices: ['red', 'blue'],
    });
  });

  it('re-buffers a prompt split across coalesced chunks', () => {
    ensurePromptWatcher('s1');
    emit('s1', 'SIGMA::PROMPT {"question":"Q","type":"single",');
    expect(getActivePrompt('s1')).toBeNull();
    emit('s1', '"choices":["yes","no"]}\n');
    expect(getActivePrompt('s1')).toMatchObject({ choices: ['yes', 'no'] });
  });

  it('ignores non-PROMPT and malformed lines', () => {
    ensurePromptWatcher('s1');
    emit('s1', 'SIGMA::SAY {"body":"hi"}\n');
    emit('s1', 'just regular terminal output\n');
    emit('s1', 'SIGMA::PROMPT {bad json}\n');
    expect(getActivePrompt('s1')).toBeNull();
  });

  it('ensurePromptWatcher is idempotent — one bus subscription per session', () => {
    ensurePromptWatcher('s1');
    ensurePromptWatcher('s1');
    expect(busSubscribers.get('s1')?.size).toBe(1);
  });

  it('notifies subscribers on new prompt and on clear', () => {
    ensurePromptWatcher('s1');
    const cb = vi.fn();
    const off = subscribeActivePrompt('s1', cb);
    emit('s1', VALID);
    expect(cb).toHaveBeenCalledTimes(1);
    clearActivePrompt('s1');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getActivePrompt('s1')).toBeNull();
    off();
    emit('s1', VALID);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('disposePromptWatcher unsubscribes the bus and drops state', () => {
    ensurePromptWatcher('s1');
    emit('s1', VALID);
    disposePromptWatcher('s1');
    expect(busUnsubscribeSpy).toHaveBeenCalledWith('s1');
    expect(getActivePrompt('s1')).toBeNull();
  });

  it('disposePromptWatcher is a no-op for an unknown session', () => {
    expect(() => disposePromptWatcher('never-watched')).not.toThrow();
  });
});
