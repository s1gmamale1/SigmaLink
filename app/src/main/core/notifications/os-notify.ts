// v1.4.9 #07 — Native OS notification wrapper (D6); P3 (NTF-1) prefs gating.
//
// Encapsulates:
//   - Master toggle gate (`kv['notifications.osEnabled'] === '1'`).
//   - Per-severity gate (`kv['notifications.osSeverities']` JSON array;
//     defaults to `['warn','error','critical']`). Critical is forced-on at
//     the UI layer; this module enforces it at the runtime layer too.
//   - P3 (NTF-1) prefs gate — Do-Not-Disturb (`notifications.dnd`),
//     quiet-hours window (`notifications.quietHours`), and per-source mute
//     (`notifications.osPerSource`) are enforced HERE via the shared pure
//     predicates in `shared/notification-prefs.ts` (identical evaluation in
//     main + renderer). Per-source mute always wins; `critical` bypasses
//     DND/quiet (must-see) but is still silenced by an explicit source mute.
//   - 5-minute throttle per `dedup_key` so a swarm broadcast burst doesn't
//     paint the OS Notification Center with duplicates.
//   - Electron `Notification` lifecycle (icon path, click handler).
//
// The OS notification fires AFTER the in-app notification is persisted —
// click hands off to the renderer via a focus-and-broadcast pattern (the
// same `app:navigate`-style channel the in-app dropdown's click action
// uses; we don't define a new event because the deep-link target is
// identical between in-app and OS-level surfaces).

import path from 'node:path';
import { app, BrowserWindow, Notification } from 'electron';
import { getRawDb } from '../db/client';
import type { Notification as AppNotification, NotificationSeverity } from '../../../shared/types';
import {
  KV_DND,
  KV_QUIET_HOURS,
  KV_OS_PER_SOURCE,
  parseQuietHours,
  parseMutedSources,
  isOsSuppressed,
  notificationSource,
  type NotificationPrefs,
} from '../../../shared/notification-prefs';

export const KV_OS_ENABLED = 'notifications.osEnabled';
export const KV_OS_SEVERITIES = 'notifications.osSeverities';
// Re-export the shared per-source KV key so prior consumers of
// `os-notify`'s `KV_OS_PER_SOURCE` keep resolving (single source of truth
// now lives in `shared/notification-prefs.ts`).
export { KV_OS_PER_SOURCE };

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
    /** 2026-07-02 fix C — always true: the app soundscape owns audio; the
     *  native ding bypassed master-sound/mute/DND and double-played. */
    silent: boolean;
  }) => { show: () => void; on: (event: 'click', cb: () => void) => void };
  /** Window-focus hook; falls back to BrowserWindow.getAllWindows() in prod. */
  focusWindow?: () => void;
  /** Icon path resolver — defaults to `<appPath>/build/icon.png`. */
  resolveIconPath?: () => string | undefined;
  /** 2026-07-02 fix C — presence probe. When ANY app window is focused the
   *  operator is IN the app (toast + bell + tone already carry the event), so
   *  the OS banner is suppressed — ALL severities; presence ≠ DND. Defaults
   *  to `BrowserWindow.getFocusedWindow() !== null`. */
  isAppFocused?: () => boolean;
}

export class OsNotifier {
  private readonly now: () => number;
  private readonly notificationFactory: NonNullable<OsNotifierDeps['notificationFactory']>;
  private readonly focusWindow: () => void;
  private readonly resolveIconPath: () => string | undefined;
  private readonly isAppFocused: () => boolean;
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
          silent: input.silent,
        });
        return n;
      });
    this.isAppFocused =
      deps.isAppFocused ?? (() => BrowserWindow.getFocusedWindow() !== null);
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
          const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
          return path.join(app.getAppPath(), 'build', iconFile);
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
    // 2026-07-02 fix C — presence gate: no OS banner while the operator is IN
    // the app (all severities — the in-app toast/bell/tone carry it; presence
    // is not DND, so no critical bypass). Fail OPEN: a broken probe must not
    // silence away-notifications.
    try {
      if (this.isAppFocused()) return false;
    } catch {
      /* fail open */
    }
    const allowed = readAllowedSeverities();
    if (!allowed.has(notification.severity)) return false;
    // P3 (NTF-1) — DND / quiet-hours / per-source mute gate. Read prefs from
    // KV and evaluate the shared pure predicate. `isOsSuppressed` already
    // encodes the policy (per-source mute always wins; `critical` bypasses
    // DND/quiet) — do not re-implement severity special-casing here.
    const prefs: NotificationPrefs = {
      dnd: readKv(KV_DND) === '1',
      quietHours: parseQuietHours(readKv(KV_QUIET_HOURS)),
      mutedSources: parseMutedSources(readKv(KV_OS_PER_SOURCE)),
    };
    const d = new Date(this.now());
    const nowMin = d.getHours() * 60 + d.getMinutes();
    if (
      isOsSuppressed(
        prefs,
        { source: notificationSource(notification.kind), severity: notification.severity },
        nowMin,
      )
    ) {
      return false;
    }
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
      silent: true, // fix C — the app soundscape owns audio
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
