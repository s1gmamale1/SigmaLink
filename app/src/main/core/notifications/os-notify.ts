// v1.4.9 #07 — Native OS notification wrapper (D6).
//
// Encapsulates:
//   - Master toggle gate (`kv['notifications.osEnabled'] === '1'`).
//   - Per-severity gate (`kv['notifications.osSeverities']` JSON array;
//     defaults to `['warn','error','critical']`). Critical is forced-on at
//     the UI layer; this module enforces it at the runtime layer too.
//   - 5-minute throttle per `dedup_key` so a swarm broadcast burst doesn't
//     paint the OS Notification Center with duplicates.
//   - Electron `Notification` lifecycle (icon path, click handler).
//
// The OS notification fires AFTER the in-app notification is persisted —
// click hands off to the renderer via a focus-and-broadcast pattern (the
// same `app:navigate`-style channel the in-app dropdown's click action
// uses; we don't define a new event because the deep-link target is
// identical between in-app and OS-level surfaces).
//
// Quiet hours and per-source toggles are explicitly out of scope for v1.4.9
// (D6). The kv key `notifications.osPerSource` is scaffolded but unused so
// v1.4.10+ can wire it without a schema change.

import path from 'node:path';
import { app, BrowserWindow, Notification } from 'electron';
import { getRawDb } from '../db/client';
import type { Notification as AppNotification, NotificationSeverity } from '../../../shared/types';

export const KV_OS_ENABLED = 'notifications.osEnabled';
export const KV_OS_SEVERITIES = 'notifications.osSeverities';
/** Scaffolded per D6 §6 — read by future v1.5+ per-source UI; unused in v1. */
export const KV_OS_PER_SOURCE = 'notifications.osPerSource';

/** D6 — 5 minute throttle window per dedup_key. */
export const OS_THROTTLE_MS = 5 * 60 * 1000;

const DEFAULT_SEVERITIES: NotificationSeverity[] = ['warn', 'error', 'critical'];

function readKv(key: string): string | null {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function isEnabled(): boolean {
  return readKv(KV_OS_ENABLED) === '1';
}

function readAllowedSeverities(): Set<NotificationSeverity> {
  const raw = readKv(KV_OS_SEVERITIES);
  if (!raw) return new Set(DEFAULT_SEVERITIES);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid: NotificationSeverity[] = parsed.filter(
        (s): s is NotificationSeverity =>
          s === 'info' || s === 'warn' || s === 'error' || s === 'critical',
      );
      // D6 — critical is FORCED on regardless of stored array.
      if (!valid.includes('critical')) valid.push('critical');
      return new Set(valid);
    }
  } catch {
    /* malformed kv — fall through to defaults */
  }
  return new Set(DEFAULT_SEVERITIES);
}

export interface OsNotifierDeps {
  /** Wall-clock override for tests. */
  now?: () => number;
  /** Override the Electron Notification ctor for tests. */
  notificationFactory?: (input: {
    title: string;
    body: string;
    icon?: string;
  }) => { show: () => void; on: (event: 'click', cb: () => void) => void };
  /** Window-focus hook; falls back to BrowserWindow.getAllWindows() in prod. */
  focusWindow?: () => void;
  /** Icon path resolver — defaults to `<appPath>/build/icon.png`. */
  resolveIconPath?: () => string | undefined;
}

export class OsNotifier {
  private readonly now: () => number;
  private readonly notificationFactory: NonNullable<OsNotifierDeps['notificationFactory']>;
  private readonly focusWindow: () => void;
  private readonly resolveIconPath: () => string | undefined;
  /** `dedup_key → last fire ts`. Pruned lazily on lookup so a long-lived
   *  app doesn't accumulate unbounded throttle entries. */
  private readonly lastFireByKey = new Map<string, number>();

  constructor(deps: OsNotifierDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.notificationFactory =
      deps.notificationFactory ??
      ((input) => {
        const n = new Notification({
          title: input.title,
          body: input.body,
          icon: input.icon,
          silent: false,
        });
        return n;
      });
    this.focusWindow =
      deps.focusWindow ??
      (() => {
        const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
        const target = BrowserWindow.getFocusedWindow() ?? all[0];
        if (target) {
          if (target.isMinimized()) target.restore();
          target.focus();
        }
      });
    this.resolveIconPath =
      deps.resolveIconPath ??
      (() => {
        try {
          return path.join(app.getAppPath(), 'build', 'icon.png');
        } catch {
          return undefined;
        }
      });
  }

  /** Fire an OS notification if the gates allow it. Returns whether the
   *  notification was shown so tests can assert throttle behaviour. */
  notify(notification: AppNotification): boolean {
    if (!Notification.isSupported()) return false;
    if (!isEnabled()) return false;
    const allowed = readAllowedSeverities();
    if (!allowed.has(notification.severity)) return false;
    // Throttle on dedupKey.
    const last = this.lastFireByKey.get(notification.dedupKey);
    const ts = this.now();
    if (last !== undefined && ts - last < OS_THROTTLE_MS) return false;
    this.lastFireByKey.set(notification.dedupKey, ts);
    // Prune stale throttle entries opportunistically.
    if (this.lastFireByKey.size > 200) this.prune(ts);

    const native = this.notificationFactory({
      title: notification.title,
      body: notification.body ?? '',
      icon: this.resolveIconPath(),
    });
    native.on('click', () => {
      try {
        this.focusWindow();
      } catch {
        /* focus best-effort */
      }
    });
    try {
      native.show();
    } catch {
      return false;
    }
    return true;
  }

  private prune(nowTs: number): void {
    for (const [key, ts] of this.lastFireByKey.entries()) {
      if (nowTs - ts >= OS_THROTTLE_MS) this.lastFireByKey.delete(key);
    }
  }

  /** Test-only — clear the throttle state. */
  resetThrottleForTests(): void {
    this.lastFireByKey.clear();
  }
}
