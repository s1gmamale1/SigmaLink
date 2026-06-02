// P3 (NTF-1) — OsNotifier prefs-gating unit tests.
//
// Asserts the DND / quiet-hours / per-source mute gate that `notify()` applies
// AFTER the master + per-severity gates and BEFORE the throttle.
//
// DB constraint: better-sqlite3 is built for Electron's ABI and cannot load
// under vitest, so we mock `../db/client` with a Map-backed fake serving the
// `SELECT value FROM kv WHERE key = ?` statement the module fires via `readKv`.
// We also avoid constructing a real Electron `Notification`: the ctor is
// injected via `notificationFactory`, and `Notification.isSupported()` is
// stubbed on the mocked electron module so the early support guard passes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KV_DND,
  KV_QUIET_HOURS,
  KV_OS_PER_SOURCE,
} from '../../../shared/notification-prefs';

// ── Mocks ──────────────────────────────────────────────────────────────────
// A Map-backed kv store the fake DB reads from. Each test seeds it directly.
const kv = new Map<string, string>();

vi.mock('../db/client', () => ({
  getRawDb: vi.fn(() => ({
    prepare: () => ({
      // os-notify's readKv calls `.get(key)` and expects `{ value }` | undefined.
      get: (key: string) => {
        const value = kv.get(key);
        return value === undefined ? undefined : { value };
      },
    }),
  })),
  getDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

// Stub electron minimally — only `Notification.isSupported()` is consulted in
// the prod path before the injected factory takes over. `app`/`BrowserWindow`
// are referenced only inside default deps we never trigger (we inject all of
// them), but must exist as module exports so the import resolves.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  Notification: { isSupported: () => true },
}));

import { OsNotifier, KV_OS_ENABLED } from './os-notify';
import type { Notification as AppNotification } from '../../../shared/types';

// ── Helpers ──────────────────────────────────────────────────────────────────
let dedupSeq = 0;

function makeNotification(over: Partial<AppNotification> = {}): AppNotification {
  dedupSeq += 1;
  return {
    id: `n${dedupSeq}`,
    workspaceId: null,
    kind: 'system',
    severity: 'warn',
    title: 'Test',
    body: 'body',
    payload: null,
    sourceEvent: null,
    dedupKey: `dedup-${dedupSeq}`,
    dupCount: 1,
    createdAt: 0,
    readAt: null,
    ...over,
  };
}

/** Build an OsNotifier with a captured `show` spy and a fixed clock. */
function makeNotifier(nowMs: number) {
  const show = vi.fn();
  const notifier = new OsNotifier({
    now: () => nowMs,
    resolveIconPath: () => undefined,
    notificationFactory: () => ({ show, on: vi.fn() }),
  });
  return { notifier, show };
}

/** Local minutes-since-midnight → an epoch ms whose local clock reads that. */
function epochAtLocalMinutes(min: number): number {
  const d = new Date(2026, 5, 2, 0, 0, 0, 0); // local midnight
  d.setMinutes(min);
  return d.getTime();
}

// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
  kv.clear();
  // Master OS gate on; per-severity defaults to warn/error/critical.
  kv.set(KV_OS_ENABLED, '1');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('OsNotifier — NTF-1 prefs gating', () => {
  it('default prefs (no DND/quiet/mute) fire for warn and error', () => {
    const { notifier, show } = makeNotifier(0);

    expect(notifier.notify(makeNotification({ severity: 'warn' }))).toBe(true);
    expect(notifier.notify(makeNotification({ severity: 'error' }))).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('DND on suppresses non-critical but lets critical through', () => {
    kv.set(KV_DND, '1');
    const { notifier, show } = makeNotifier(0);

    expect(notifier.notify(makeNotification({ severity: 'warn' }))).toBe(false);
    expect(notifier.notify(makeNotification({ severity: 'error' }))).toBe(false);
    expect(show).not.toHaveBeenCalled();

    expect(notifier.notify(makeNotification({ severity: 'critical' }))).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('quiet-hours window suppresses inside, fires outside (non-critical)', () => {
    // Window 22:00 → 08:00 (wraps midnight).
    kv.set(
      KV_QUIET_HOURS,
      JSON.stringify({ enabled: true, start: '22:00', end: '08:00' }),
    );

    // Inside: 23:00 local → suppressed.
    const inside = makeNotifier(epochAtLocalMinutes(23 * 60));
    expect(inside.notifier.notify(makeNotification({ severity: 'warn' }))).toBe(false);
    expect(inside.show).not.toHaveBeenCalled();

    // Outside: 12:00 local → fires.
    const outside = makeNotifier(epochAtLocalMinutes(12 * 60));
    expect(outside.notifier.notify(makeNotification({ severity: 'warn' }))).toBe(true);
    expect(outside.show).toHaveBeenCalledTimes(1);
  });

  it('quiet-hours does NOT suppress critical, but DOES outside the window for non-critical', () => {
    kv.set(
      KV_QUIET_HOURS,
      JSON.stringify({ enabled: true, start: '22:00', end: '08:00' }),
    );
    // Inside window, critical bypasses quiet.
    const { notifier, show } = makeNotifier(epochAtLocalMinutes(23 * 60));
    expect(notifier.notify(makeNotification({ severity: 'critical' }))).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('per-source mute suppresses a pty-exit even when critical; other sources fire', () => {
    kv.set(KV_OS_PER_SOURCE, JSON.stringify(['pty']));
    const { notifier, show } = makeNotifier(0);

    // pty-exit maps to source 'pty' → muted, even at critical severity.
    expect(
      notifier.notify(makeNotification({ kind: 'pty-exit', severity: 'critical' })),
    ).toBe(false);
    expect(show).not.toHaveBeenCalled();

    // swarm-broadcast maps to source 'swarm' → not muted → fires.
    expect(
      notifier.notify(makeNotification({ kind: 'swarm-broadcast', severity: 'warn' })),
    ).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
