// @vitest-environment jsdom
//
// 2026-06-10 lifecycle audit, finding 1 — module-scope scratch-tab store.
//
// Contract:
//   • Tabs are keyed by parent sessionId and survive React unmounts (the
//     store is a module singleton, like terminal-cache / pty-data-bus).
//   • closeScratchTab is the SINGLE teardown choke point: it removes the
//     tab, destroys the cached xterm (terminal-cache destroy), and kills
//     the PTY (rpc.pty.killScratch) — in that order, idempotently.
//   • getScratchTabs returns a STABLE reference between mutations so it
//     is safe as a useSyncExternalStore snapshot.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const killScratchMock = vi.fn((..._a: unknown[]) => Promise.resolve());
const destroyMock = vi.fn();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { pty: { killScratch: (...a: unknown[]) => killScratchMock(...a) } },
}));
vi.mock('@/renderer/lib/terminal-cache', () => ({
  destroy: (...a: unknown[]) => destroyMock(...a),
}));

import {
  addScratchTab,
  closeScratchForParent,
  closeScratchTab,
  getScratchParentIds,
  getScratchTabs,
  subscribeScratchTabs,
  __resetScratchTabs,
} from './scratch-tabs';

beforeEach(() => {
  killScratchMock.mockClear();
  destroyMock.mockClear();
  __resetScratchTabs();
});

describe('scratch-tabs store', () => {
  it('adds tabs under a parent and lists them in order', () => {
    addScratchTab('parent-1', 'scr-a');
    addScratchTab('parent-1', 'scr-b');
    expect(getScratchTabs('parent-1')).toEqual([
      { scratchId: 'scr-a' },
      { scratchId: 'scr-b' },
    ]);
    expect(getScratchTabs('parent-2')).toEqual([]);
  });

  it('returns a stable snapshot reference between mutations (useSyncExternalStore contract)', () => {
    addScratchTab('parent-1', 'scr-a');
    const first = getScratchTabs('parent-1');
    expect(getScratchTabs('parent-1')).toBe(first);
    // Unknown parents share ONE stable empty array.
    expect(getScratchTabs('nope-1')).toBe(getScratchTabs('nope-2'));
  });

  it('notifies subscribers on add and close, and unsubscribe stops notifications', () => {
    const cb = vi.fn();
    const off = subscribeScratchTabs('parent-1', cb);
    addScratchTab('parent-1', 'scr-a');
    expect(cb).toHaveBeenCalledTimes(1);
    closeScratchTab('parent-1', 'scr-a');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    addScratchTab('parent-1', 'scr-b');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('closeScratchTab destroys the cached xterm AND kills the PTY (finding 1c)', () => {
    addScratchTab('parent-1', 'scr-a');
    closeScratchTab('parent-1', 'scr-a');
    expect(getScratchTabs('parent-1')).toEqual([]);
    expect(destroyMock).toHaveBeenCalledWith('scr-a');
    expect(killScratchMock).toHaveBeenCalledWith({ scratchId: 'scr-a' });
  });

  it('closeScratchTab is a no-op for an unknown scratchId (idempotent)', () => {
    addScratchTab('parent-1', 'scr-a');
    closeScratchTab('parent-1', 'scr-zzz');
    closeScratchTab('parent-other', 'scr-a');
    expect(destroyMock).not.toHaveBeenCalled();
    expect(killScratchMock).not.toHaveBeenCalled();
    expect(getScratchTabs('parent-1')).toHaveLength(1);
  });

  it('closeScratchForParent tears down every tab and forgets the parent', () => {
    addScratchTab('parent-1', 'scr-a');
    addScratchTab('parent-1', 'scr-b');
    addScratchTab('parent-2', 'scr-c');
    closeScratchForParent('parent-1');
    expect(getScratchTabs('parent-1')).toEqual([]);
    expect(destroyMock.mock.calls.map((c) => c[0])).toEqual(['scr-a', 'scr-b']);
    expect(killScratchMock).toHaveBeenCalledTimes(2);
    expect(getScratchParentIds()).toEqual(['parent-2']);
  });

  it('closeScratchForParent is a no-op for a parent with no tabs', () => {
    expect(() => closeScratchForParent('ghost')).not.toThrow();
    expect(destroyMock).not.toHaveBeenCalled();
  });
});
