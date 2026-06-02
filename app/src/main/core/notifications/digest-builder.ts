// P4.2 NTF-DIGEST — daily summary builder. Once a day (fired by DailyScheduler)
// this rolls up the notifications created since local midnight into a single
// compact summary notification (`kind: 'daily-summary'`, severity `info`).
//
// PURE-ish: the row source is injected as `queryDay(sinceMs, untilMs)` so the
// builder is unit-testable against an in-memory array (never `new Database()`).
// The wiring in rpc-router supplies a `getRawDb()`-backed query. The summary is
// posted through the NotificationsManager (so it inherits dedup / OS-notify /
// the bell), and `notificationSource('daily-summary')` routes it to the
// 'system' mute source.
//
// The dedupKey is `daily-summary:<YYYY-MM-DD>` — the SAME key all day — so if
// the builder somehow fires twice (clock skew, manual re-arm) the manager's
// D3 dedup folds the second into the first rather than double-buzzing the OS.

import type { NotificationSeverity } from '../../../shared/types';

/** Minimal shape the builder needs from the manager (keeps the test surface
 *  tiny — only `add` is exercised). */
export interface DigestNotificationsSink {
  add: (input: {
    workspaceId: string | null;
    kind: string;
    severity: NotificationSeverity;
    title: string;
    body?: string | null;
    dedupKey: string;
    sourceEvent?: string | null;
  }) => unknown;
}

/** A row as needed for grouping — a narrow projection of the notifications
 *  table (the injected query may return more columns; only these are read). */
export interface DigestRow {
  kind: string;
  severity: NotificationSeverity;
}

export interface DigestBuilderDeps {
  /** Post the summary row. Typically the NotificationsManager. */
  notifications: DigestNotificationsSink;
  /** Return the rows created in `[sinceMs, untilMs)` (local-day window).
   *  Excludes prior `daily-summary` rows so a summary never summarizes itself. */
  queryDay: (sinceMs: number, untilMs: number) => DigestRow[];
}

/** Local `YYYY-MM-DD` for the dedupKey + title. */
function dayStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Start-of-local-day ms for `date`. */
function startOfLocalDay(date: Date): number {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const SEVERITY_ORDER: NotificationSeverity[] = ['critical', 'error', 'warn', 'info'];

/**
 * Build + post the once-daily summary notification. No-ops (returns false) when
 * there were zero events today, so an idle day doesn't fire an empty buzz.
 * Returns true when a summary was posted.
 */
export function buildDailySummary(deps: DigestBuilderDeps, now: Date): boolean {
  const since = startOfLocalDay(now);
  const until = now.getTime();
  const rows = deps.queryDay(since, until);
  if (rows.length === 0) return false;

  // Group counts by kind and by severity.
  const byKind = new Map<string, number>();
  const bySeverity = new Map<NotificationSeverity, number>();
  for (const r of rows) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    bySeverity.set(r.severity, (bySeverity.get(r.severity) ?? 0) + 1);
  }

  const total = rows.length;
  const dateStr = dayStr(now);

  // Title: compact severity rollup, highest-severity-first, omitting zeros.
  const sevParts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const c = bySeverity.get(sev);
    if (c) sevParts.push(`${c} ${sev}`);
  }
  const title = `Daily summary — ${total} event${total === 1 ? '' : 's'}`;

  // Body: one line per kind, descending by count then kind name for stability.
  const kindLines = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind}: ${count}`);
  const body = [sevParts.join(', '), ...kindLines].filter(Boolean).join('\n');

  deps.notifications.add({
    workspaceId: null,
    kind: 'daily-summary',
    severity: 'info',
    title,
    body: body || null,
    dedupKey: `daily-summary:${dateStr}`,
    sourceEvent: 'digest:daily',
  });
  return true;
}
