// BUG-V1.1.2-02 — Unit tests for the session-restore kv codec.
//
// The full integration (renderer IPC → main cache → kv flush on quit) is
// covered by the Playwright suite. These tests pin the contract surface that
// runs purely inside the main process: validation rejects bad payloads,
// reads of malformed/absent rows return null, and the in-memory cache
// behaves as expected (idempotent flush, missing-snapshot is a no-op).
// CRIT-3 tests verify the trailing-edge throttled opportunistic flush so a
// force-quit (SIGKILL) loses at most a few seconds of session state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getRawDb: vi.fn(),
}));

import { getRawDb } from '../db/client';
import {
  SESSION_KV_KEY,
  __resetForTests,
  getCachedSnapshot,
  persistCachedSnapshot,
  readSessionSnapshot,
  rememberSessionSnapshot,
  writeSessionSnapshot,
} from './session-restore';
import { fakeDb } from '@/test-utils/db-fake';

beforeEach(() => {
  __resetForTests();
  vi.mocked(getRawDb).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  __resetForTests();
});

describe('session-restore: rememberSessionSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const ok = rememberSessionSnapshot({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'command' }],
    });
    expect(ok).toBe(true);
    expect(getCachedSnapshot()).toEqual({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'command' }],
    });
  });

  it('accepts a legacy v1.1.2 snapshot', () => {
    const ok = rememberSessionSnapshot({ workspaceId: 'ws-1', room: 'command' });
    expect(ok).toBe(true);
    expect(getCachedSnapshot()).toEqual({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'command' }],
    });
  });

  it('rejects an empty workspaceId', () => {
    const ok = rememberSessionSnapshot({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: '', room: 'command' }],
    });
    expect(ok).toBe(false);
    expect(getCachedSnapshot()).toBeNull();
  });

  it('rejects an empty room', () => {
    const ok = rememberSessionSnapshot({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: '' }],
    });
    expect(ok).toBe(false);
    expect(getCachedSnapshot()).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(rememberSessionSnapshot(null)).toBe(false);
    expect(rememberSessionSnapshot(undefined)).toBe(false);
    expect(rememberSessionSnapshot('snapshot')).toBe(false);
    expect(rememberSessionSnapshot(42)).toBe(false);
    expect(getCachedSnapshot()).toBeNull();
  });

  it('rejects extra-long values to bound the kv row size', () => {
    const big = 'x'.repeat(500);
    const ok = rememberSessionSnapshot({
      activeWorkspaceId: big,
      openWorkspaces: [{ workspaceId: big, room: 'command' }],
    });
    expect(ok).toBe(false);
    expect(getCachedSnapshot()).toBeNull();
  });

  it('overwrites the cached snapshot on each accepted call', () => {
    rememberSessionSnapshot({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'command' }],
    });
    rememberSessionSnapshot({
      activeWorkspaceId: 'ws-2',
      openWorkspaces: [{ workspaceId: 'ws-2', room: 'memory' }],
    });
    expect(getCachedSnapshot()).toEqual({
      activeWorkspaceId: 'ws-2',
      openWorkspaces: [{ workspaceId: 'ws-2', room: 'memory' }],
    });
  });
});

describe('session-restore: writeSessionSnapshot + readSessionSnapshot', () => {
  it('round-trips a valid snapshot through the fake kv', () => {
    const db = fakeDb();
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    writeSessionSnapshot({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'memory' }],
    });
    expect(db.storage.get(SESSION_KV_KEY)).toBe(
      JSON.stringify({
        activeWorkspaceId: 'ws-1',
        openWorkspaces: [{ workspaceId: 'ws-1', room: 'memory' }],
      }),
    );
    const read = readSessionSnapshot();
    expect(read).toEqual({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'memory' }],
    });
  });

  it('reads a legacy v1.1.2 snapshot through the fake kv', () => {
    const db = fakeDb();
    db.storage.set(SESSION_KV_KEY, JSON.stringify({ workspaceId: 'ws-1', room: 'memory' }));
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    expect(readSessionSnapshot()).toEqual({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'memory' }],
    });
  });

  it('returns null when no row exists', () => {
    const db = fakeDb();
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    expect(readSessionSnapshot()).toBeNull();
  });

  it('returns null when the kv value is not valid JSON', () => {
    const db = fakeDb();
    db.storage.set(SESSION_KV_KEY, '{not-json');
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    expect(readSessionSnapshot()).toBeNull();
  });

  it('returns null when the kv value parses but has the wrong shape', () => {
    const db = fakeDb();
    db.storage.set(SESSION_KV_KEY, JSON.stringify({ workspaceId: 'ws-1' }));
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    expect(readSessionSnapshot()).toBeNull();
  });

  it('returns null when getRawDb throws (cold DB)', () => {
    vi.mocked(getRawDb).mockImplementation(() => {
      throw new Error('db not initialized');
    });
    expect(readSessionSnapshot()).toBeNull();
  });

  it('is a no-op when called with a malformed snapshot', () => {
    const db = fakeDb();
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    writeSessionSnapshot({
      activeWorkspaceId: '',
      openWorkspaces: [{ workspaceId: '', room: '' }],
    });
    expect(db.storage.size).toBe(0);
  });
});

describe('session-restore: persistCachedSnapshot', () => {
  it('writes the cached snapshot to kv', () => {
    const db = fakeDb();
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    rememberSessionSnapshot({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'tasks' }],
    });
    persistCachedSnapshot();
    expect(db.storage.get(SESSION_KV_KEY)).toBe(
      JSON.stringify({
        activeWorkspaceId: 'ws-1',
        openWorkspaces: [{ workspaceId: 'ws-1', room: 'tasks' }],
      }),
    );
  });

  it('is a no-op when nothing is cached', () => {
    const db = fakeDb();
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    persistCachedSnapshot();
    expect(db.storage.size).toBe(0);
  });

  it('swallows kv write errors so before-quit never throws', () => {
    vi.mocked(getRawDb).mockImplementation(() => {
      throw new Error('write failed');
    });
    rememberSessionSnapshot({
      activeWorkspaceId: 'ws-1',
      openWorkspaces: [{ workspaceId: 'ws-1', room: 'command' }],
    });
    expect(() => persistCachedSnapshot()).not.toThrow();
  });
});

// A minimal valid snapshot that passes the module's zod normalizer.
const VALID_SNAP = {
  activeWorkspaceId: 'ws-1',
  openWorkspaces: [{ workspaceId: 'ws-1', room: 'command' }],
};

describe('session-restore: opportunistic throttled flush (CRIT-3)', () => {
  // Each test in this block wires its own runSpy so timer-driven writes
  // are counted independently.  vi.useFakeTimers() is set up per-test so
  // the timer is always advanced by an explicit call, never by wall-clock.

  it('flushes to kv shortly after a snapshot (not only at quit)', () => {
    const runSpy = vi.fn();
    vi.mocked(getRawDb).mockReturnValue({
      prepare: () => ({ run: runSpy, get: () => undefined }),
    } as unknown as ReturnType<typeof getRawDb>);

    vi.useFakeTimers();
    rememberSessionSnapshot(VALID_SNAP);

    // Before the throttle window: no write yet.
    expect(runSpy).not.toHaveBeenCalled();

    // Advance past the 2 s throttle threshold.
    vi.advanceTimersByTime(5000);

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('coalesces a rapid burst into a single throttled write', () => {
    const runSpy = vi.fn();
    vi.mocked(getRawDb).mockReturnValue({
      prepare: () => ({ run: runSpy, get: () => undefined }),
    } as unknown as ReturnType<typeof getRawDb>);

    vi.useFakeTimers();
    rememberSessionSnapshot(VALID_SNAP);
    rememberSessionSnapshot(VALID_SNAP);
    rememberSessionSnapshot(VALID_SNAP);

    vi.advanceTimersByTime(5000);

    // All three calls share one trailing-edge timer → exactly one write.
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
