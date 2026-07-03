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

// 2026-07-02 review fix C — no banner while the operator is IN the app (the
// in-app toast + bell + tone already carry it), and the native notification
// is silent (the app soundscape owns audio; the OS ding bypassed every pref).
describe('OsNotifier — focus gate + silent banner', () => {
  function makeFocusNotifier(focused: () => boolean) {
    const show = vi.fn();
    const factory = vi.fn(() => ({ show, on: vi.fn() }));
    const notifier = new OsNotifier({
      now: () => 0,
      resolveIconPath: () => undefined,
      notificationFactory: factory,
      isAppFocused: focused,
    });
    return { notifier, show, factory };
  }

  it('suppresses the OS banner while an app window is focused', () => {
    const { notifier, show } = makeFocusNotifier(() => true);
    expect(notifier.notify(makeNotification({ severity: 'warn' }))).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('fires when no window is focused', () => {
    const { notifier, show } = makeFocusNotifier(() => false);
    expect(notifier.notify(makeNotification({ severity: 'warn' }))).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('suppresses critical too while focused (presence ≠ DND; in-app surfaces carry it)', () => {
    const { notifier, show } = makeFocusNotifier(() => true);
    expect(notifier.notify(makeNotification({ severity: 'critical' }))).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('a throwing focus probe fails OPEN — the banner still fires', () => {
    const { notifier, show } = makeFocusNotifier(() => {
      throw new Error('probe exploded');
    });
    expect(notifier.notify(makeNotification({ severity: 'warn' }))).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('builds the native notification silent — the app soundscape owns audio', () => {
    const { notifier, factory } = makeFocusNotifier(() => false);
    notifier.notify(makeNotification({ severity: 'warn' }));
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
  });
});

// 2026-07-03 (review medium #4) — macOS never surfaces authorization state:
// Notification.isSupported() reports capability, not permission, so Settings
// can say "OS notifications ✓" while nothing ever reaches the screen.
// notifyTest() is the operator's self-verification probe: it bypasses EVERY
// app-level gate (master toggle, severity, DND/quiet/mute, focus, throttle) so
// the ONLY reason nothing appears is the OS itself — which is exactly what the
// Settings hint then tells the operator to fix.
describe('OsNotifier — notifyTest (delivery self-check)', () => {
  function makeTestNotifier(over: { focused?: () => boolean; showThrows?: boolean } = {}) {
    const show = over.showThrows
      ? vi.fn(() => {
          throw new Error('denied');
        })
      : vi.fn();
    const factory = vi.fn(() => ({ show, on: vi.fn() }));
    const notifier = new OsNotifier({
      now: () => 0,
      resolveIconPath: () => undefined,
      notificationFactory: factory,
      isAppFocused: over.focused ?? (() => true),
    });
    return { notifier, show, factory };
  }

  it('fires even with the master OS toggle OFF (bypasses isEnabled)', () => {
    kv.set(KV_OS_ENABLED, '0');
    const { notifier, show } = makeTestNotifier();
    expect(notifier.notifyTest()).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('fires while the app is focused (bypasses the presence gate)', () => {
    const { notifier, show } = makeTestNotifier({ focused: () => true });
    expect(notifier.notifyTest()).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('fires under DND (bypasses the prefs gate)', () => {
    kv.set(KV_DND, '1');
    const { notifier, show } = makeTestNotifier();
    expect(notifier.notifyTest()).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('builds the test notification silent', () => {
    const { notifier, factory } = makeTestNotifier();
    notifier.notifyTest();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
  });

  it('returns false when the native show throws', () => {
    const { notifier } = makeTestNotifier({ showThrows: true });
    expect(notifier.notifyTest()).toBe(false);
  });
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

describe('OsNotifier — default resolveIconPath platform branching', () => {
  const orig = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: orig, writable: true, configurable: true });
  });

  function captureIcon(platform: NodeJS.Platform, dedupKey: string): string | undefined {
    Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
    kv.set(KV_OS_ENABLED, '1');
    let icon: string | undefined;
    const n = new OsNotifier({
      notificationFactory: (i) => { icon = i.icon; return { show: vi.fn(), on: vi.fn() }; },
      focusWindow: () => {},
    });
    n.notify(makeNotification({ severity: 'warn', kind: 'system', workspaceId: null, dedupKey }));
    return icon;
  }

  it('icon.ico on win32', () => {
    expect(captureIcon('win32', 'ico-test')).toMatch(/icon\.ico$/);
  });

  it('icon.png on darwin', () => {
    expect(captureIcon('darwin', 'png-test')).toMatch(/icon\.png$/);
  });
});
