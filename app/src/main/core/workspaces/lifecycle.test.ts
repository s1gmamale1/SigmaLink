// Runtime-open workspace lifecycle tests.
//
// lifecycle.ts imports `BrowserWindow`/`ipcMain` from electron and broadcasts
// the open-workspace id list to every live window. We mock electron with a
// controllable window list so a broadcast can be observed as a spied
// `webContents.send`. The `app:open-workspaces-changed` event is on the real
// EVENTS allowlist, so `isAllowedEvent` (imported, not mocked) passes.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Each test pushes fake windows onto `fakeWindows`; the mocked BrowserWindow
// exposes them via getAllWindows(). `send` is a vi.fn so broadcasts are
// observable. ipcMain.on captures the installed handler (unused here but the
// module references it at import time).
interface FakeWindow {
  isDestroyed(): boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

const fakeWindows: FakeWindow[] = [];

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => fakeWindows },
  ipcMain: { on: vi.fn() },
}));

import {
  __resetWorkspaceLifecycleForTests,
  getOpenWorkspaceIds,
  markWorkspaceClosed,
  markWorkspaceOpened,
  refreshOpenWorkspaces,
  replaceOpenWorkspaces,
  setDetachedWorkspaceIdsProvider,
} from './lifecycle';

const EVENT_NAME = 'app:open-workspaces-changed';

function addFakeWindow(): FakeWindow {
  const win: FakeWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
  fakeWindows.push(win);
  return win;
}

function broadcasts(win: FakeWindow): unknown[] {
  return win.webContents.send.mock.calls
    .filter(([name]) => name === EVENT_NAME)
    .map(([, payload]) => payload);
}

function lastBroadcast(win: FakeWindow): unknown {
  const calls = broadcasts(win);
  return calls.length ? calls[calls.length - 1] : undefined;
}

beforeEach(() => {
  fakeWindows.length = 0;
  __resetWorkspaceLifecycleForTests();
});

// ── Legacy single-window behavior (must stay byte-identical) ─────────────────
describe('open-workspace lifecycle (legacy single-window)', () => {
  it('replaceOpenWorkspaces de-dupes and returns true on change', () => {
    expect(replaceOpenWorkspaces(['a', 'a', 'b'])).toBe(true);
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
  });

  it('replaceOpenWorkspaces short-circuits (returns false) on no change', () => {
    replaceOpenWorkspaces(['a', 'b']);
    expect(replaceOpenWorkspaces(['a', 'b'])).toBe(false);
  });

  it('markWorkspaceOpened moves the id to the front', () => {
    replaceOpenWorkspaces(['a', 'b', 'c']);
    markWorkspaceOpened('c');
    expect(getOpenWorkspaceIds()).toEqual(['c', 'a', 'b']);
  });

  it('markWorkspaceClosed removes the id', () => {
    replaceOpenWorkspaces(['a', 'b', 'c']);
    markWorkspaceClosed('b');
    expect(getOpenWorkspaceIds()).toEqual(['a', 'c']);
  });

  it('broadcasts the list to every live window on change', () => {
    const w1 = addFakeWindow();
    const w2 = addFakeWindow();
    replaceOpenWorkspaces(['a', 'b']);
    expect(lastBroadcast(w1)).toEqual({ workspaceIds: ['a', 'b'] });
    expect(lastBroadcast(w2)).toEqual({ workspaceIds: ['a', 'b'] });
  });
});

// ── Detached-aware union (multi-window A4) ───────────────────────────────────
describe('detached-aware union (multi-window A4)', () => {
  it('keeps detached workspaces in the union when the main renderer echoes without them', () => {
    setDetachedWorkspaceIdsProvider(() => ['b']);
    replaceOpenWorkspaces(['a']); // main window dropped 'b' after detach
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
  });

  it('does not duplicate a workspace both echoed and detached', () => {
    setDetachedWorkspaceIdsProvider(() => ['a']);
    replaceOpenWorkspaces(['a', 'c']);
    expect(getOpenWorkspaceIds()).toEqual(['a', 'c']);
  });

  it('without a provider, behaves exactly as before (legacy single-window)', () => {
    replaceOpenWorkspaces(['a', 'b']);
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
  });

  it('a workspace leaving the detached set stays open only if echoed or re-marked', () => {
    let detached: string[] = ['b'];
    setDetachedWorkspaceIdsProvider(() => detached);
    replaceOpenWorkspaces(['a']);
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
    detached = []; // redock happened registry-side…
    replaceOpenWorkspaces(['a', 'b']); // …and the redock path re-marks it (B2/B1 call markWorkspaceOpened)
    expect(getOpenWorkspaceIds()).toEqual(['a', 'b']);
  });

  it('broadcasts the union (echoed ∪ detached) to every window', () => {
    const win = addFakeWindow();
    setDetachedWorkspaceIdsProvider(() => ['b']);
    replaceOpenWorkspaces(['a']);
    expect(lastBroadcast(win)).toEqual({ workspaceIds: ['a', 'b'] });
  });

  it('registry-side detached changes do not re-broadcast via replaceOpenWorkspaces; refreshOpenWorkspaces is the escape hatch', () => {
    const win = addFakeWindow();
    let detached: string[] = ['b'];
    setDetachedWorkspaceIdsProvider(() => detached);
    replaceOpenWorkspaces(['a']); // broadcast 1: union ['a','b']
    expect(broadcasts(win)).toHaveLength(1);

    detached = []; // registry-side change only — the short-circuit diffs the RAW echoed list
    replaceOpenWorkspaces(['a']); // same raw list → no new broadcast
    expect(broadcasts(win)).toHaveLength(1);

    refreshOpenWorkspaces(); // B-phase callers re-broadcast explicitly after detach/redock
    expect(broadcasts(win)).toHaveLength(2);
    expect(lastBroadcast(win)).toEqual({ workspaceIds: ['a'] });
  });
});
