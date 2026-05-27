import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  maybeNotifyStdioFallback,
  __resetStdioFallbackNoticeState,
  type StdioFallbackNoticeDeps,
} from './ruflo-fallback-notice';

function makeDeps() {
  const add = vi.fn();
  const deps: StdioFallbackNoticeDeps = { notifications: { add } };
  return { deps, add };
}

beforeEach(() => {
  __resetStdioFallbackNoticeState();
});

describe('maybeNotifyStdioFallback', () => {
  it('notifies once with severity "info" when the daemon did NOT spawn', () => {
    const { deps, add } = makeDeps();
    maybeNotifyStdioFallback(deps, 'ws-1', false);
    expect(add).toHaveBeenCalledTimes(1);
    const arg = add.mock.calls[0][0];
    expect(arg.severity).toBe('info');
    expect(arg.workspaceId).toBe('ws-1');
    expect(typeof arg.title).toBe('string');
    expect(arg.title.length).toBeGreaterThan(0);
    // The manager requires a dedupKey or it throws — assert we supply one.
    expect(typeof arg.dedupKey).toBe('string');
    expect(arg.dedupKey.length).toBeGreaterThan(0);
    expect(typeof arg.kind).toBe('string');
    expect(arg.kind.length).toBeGreaterThan(0);
  });

  it('is a one-time no-op for the same workspaceId on subsequent calls', () => {
    const { deps, add } = makeDeps();
    maybeNotifyStdioFallback(deps, 'ws-1', false);
    maybeNotifyStdioFallback(deps, 'ws-1', false);
    maybeNotifyStdioFallback(deps, 'ws-1', false);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('notifies separately per distinct workspaceId', () => {
    const { deps, add } = makeDeps();
    maybeNotifyStdioFallback(deps, 'ws-1', false);
    maybeNotifyStdioFallback(deps, 'ws-2', false);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0][0].workspaceId).toBe('ws-1');
    expect(add.mock.calls[1][0].workspaceId).toBe('ws-2');
  });

  it('never notifies when the daemon DID spawn', () => {
    const { deps, add } = makeDeps();
    maybeNotifyStdioFallback(deps, 'ws-1', true);
    expect(add).not.toHaveBeenCalled();
  });

  it('does not mark a workspace as notified when daemonSpawned is true', () => {
    const { deps, add } = makeDeps();
    // A successful spawn followed (in a later open) by a fallback should still notify.
    maybeNotifyStdioFallback(deps, 'ws-1', true);
    maybeNotifyStdioFallback(deps, 'ws-1', false);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0].workspaceId).toBe('ws-1');
  });

  it('fail-open — swallows a throwing notifications.add (never throws into caller)', () => {
    const add = vi.fn(() => {
      throw new Error('boom');
    });
    const deps: StdioFallbackNoticeDeps = { notifications: { add } };
    expect(() => maybeNotifyStdioFallback(deps, 'ws-1', false)).not.toThrow();
    // A failed add must NOT mark the workspace notified — a later retry can fire.
    const add2 = vi.fn();
    maybeNotifyStdioFallback({ notifications: { add: add2 } }, 'ws-1', false);
    expect(add2).toHaveBeenCalledTimes(1);
  });
});
