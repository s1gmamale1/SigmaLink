// v1.4.9 #07 — Notifications manager. Single owner of every read/write to
// the `notifications` table. Encapsulates the locked D1–D6 taxonomy from
// `docs/03-plan/v1.4.8-bundle/07-notifications-bell.md`:
//
//   D1 — 4-level severity (`info | warn | error | critical`).
//   D2 — Rolling window: hard cap N=500 global + 200/kind/workspace soft cap;
//        30d TTL on read; severity-aware eviction (never auto-drop error or
//        critical). IPC delta `{added, removed, unreadCount}` — NOT full list.
//        v1.5.1-C: soft-cap-collapse implemented (D2.2 framing):
//          When unread rows per (workspace_id, kind) exceeds SOFT_CAP_PER_KIND_WS,
//          the oldest 50 unread rows are deleted and replaced with a single
//          `<kind>-summary` row whose body states how many were collapsed.
//   D3 — Dedup tuple `(workspace_id, kind, dedup_key)` within 30s window;
//        critical never dedups; matches only `read_at IS NULL` rows.
//   D4 — Per-row `read_at`; no auto-mark-on-open.
//   D5 — Click navigates + marks read; `dismiss` DELETEs; `markUnread` clears.
//   D6 — OS notifications: opt-in, per-severity gates, 5min throttle (lives
//        in `os-notify.ts`; the manager only signals via the change emit).
//
// The manager owns the lifecycle invariant: every public mutation rebuilds
// the renderer-visible delta and emits exactly one `notifications:changed`
// payload. Callers MUST NOT issue raw SQL elsewhere.

import { randomUUID } from 'node:crypto';
import { getRawDb } from '../db/client';
import type {
  Notification,
  NotificationSeverity,
  NotificationsDelta,
} from '../../../shared/types';

/** D3 — 30 second collapse window. Outside this window a duplicate becomes a
 *  fresh row (the operator has had time to react to the first one). */
export const DEDUP_WINDOW_MS = 30_000;

/** D2 — hard cap on total rows (global). When the table exceeds this, the
 *  eviction pass drops oldest read rows first, then oldest `info` unread. */
export const HARD_CAP_TOTAL = 500;

/** D2 — soft per-workspace, per-kind cap. When unread rows per
 *  (workspace_id, kind) exceeds this threshold, the manager collapses the
 *  oldest 50 unread rows into a single summary row (D2.2 framing). This
 *  prevents unbounded queue growth without losing the operator's attention. */
export const SOFT_CAP_PER_KIND_WS = 200;

/** D2.2 — number of oldest unread rows to delete when soft-cap fires. */
export const SOFT_CAP_COLLAPSE_BATCH = 50;

/** D2 — TTL on read rows (30 days). Boot GC runs this. */
export const READ_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface NotificationRowSql {
  id: string;
  workspace_id: string | null;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  payload: string | null;
  source_event: string | null;
  dedup_key: string;
  dup_count: number;
  created_at: number;
  read_at: number | null;
}

export interface AddInput {
  workspaceId: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
  sourceEvent?: string | null;
  dedupKey: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  workspaceId?: string | null;
  /** When set, restricts to severity in this set. */
  severities?: NotificationSeverity[];
}

export interface NotificationsManagerDeps {
  emit: (delta: NotificationsDelta) => void;
  /** Override for the wall-clock; tests inject a fixed clock. */
  now?: () => number;
}

const VALID_SEVERITIES = new Set<NotificationSeverity>([
  'info',
  'warn',
  'error',
  'critical',
]);

function rowToNotification(row: NotificationRowSql): Notification {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      /* malformed payload — surface as null rather than crash the manager */
    }
  }
  const severity = (
    VALID_SEVERITIES.has(row.severity as NotificationSeverity)
      ? row.severity
      : 'info'
  ) as NotificationSeverity;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    severity,
    title: row.title,
    body: row.body,
    payload,
    sourceEvent: row.source_event,
    dedupKey: row.dedup_key,
    dupCount: row.dup_count,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export class NotificationsManager {
  private readonly emit: (delta: NotificationsDelta) => void;
  private readonly now: () => number;

  constructor(deps: NotificationsManagerDeps) {
    this.emit = deps.emit;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Insert or fold a notification per D3 dedup rules. Returns the row that
   *  the operator should see (either freshly inserted or the absorbing row).
   *
   *  Side-effect: emits `notifications:changed` with the delta. Hard-cap
   *  eviction runs synchronously after the insert so the emitted unreadCount
   *  matches the post-eviction table.
   */
  add(input: AddInput): Notification {
    if (!input.dedupKey || typeof input.dedupKey !== 'string') {
      throw new Error('NotificationsManager.add: dedupKey is required');
    }
    if (!VALID_SEVERITIES.has(input.severity)) {
      throw new Error(`NotificationsManager.add: invalid severity ${input.severity}`);
    }
    const db = getRawDb();
    const now = this.now();
    const removed: string[] = [];

    // D3 — critical bypasses dedup; every critical event gets its own row.
    let absorbed: Notification | null = null;
    if (input.severity !== 'critical') {
      const since = now - DEDUP_WINDOW_MS;
      // Workspace match uses IS NULL for global rows; SQL's `=` rejects NULLs.
      const match = (input.workspaceId === null
        ? db
            .prepare(
              `SELECT * FROM notifications
               WHERE workspace_id IS NULL
                 AND dedup_key = ?
                 AND read_at IS NULL
                 AND created_at >= ?
               ORDER BY created_at DESC
               LIMIT 1`,
            )
            .get(input.dedupKey, since)
        : db
            .prepare(
              `SELECT * FROM notifications
               WHERE workspace_id = ?
                 AND dedup_key = ?
                 AND read_at IS NULL
                 AND created_at >= ?
               ORDER BY created_at DESC
               LIMIT 1`,
            )
            .get(input.workspaceId, input.dedupKey, since)) as
        | NotificationRowSql
        | undefined;
      if (match) {
        const dupCount = match.dup_count + 1;
        // Severity bump: a warn arriving on top of an info dup should reflect
        // the higher severity so the badge colour escalates as more dups
        // accumulate. error/critical bumps follow the same rule.
        const newSeverity = pickHigherSeverity(
          match.severity as NotificationSeverity,
          input.severity,
        );
        const baseBody =
          stripDupSuffix(match.body) ?? stripDupSuffix(input.body ?? null) ?? null;
        const newBody = baseBody ? `${baseBody} (×${dupCount})` : `(×${dupCount})`;
        db.prepare(
          `UPDATE notifications
           SET dup_count = ?,
               created_at = ?,
               body = ?,
               severity = ?,
               title = ?
           WHERE id = ?`,
        ).run(dupCount, now, newBody, newSeverity, input.title, match.id);
        const refreshed = db
          .prepare(`SELECT * FROM notifications WHERE id = ?`)
          .get(match.id) as NotificationRowSql;
        absorbed = rowToNotification(refreshed);
      }
    }

    let inserted: Notification;
    if (absorbed) {
      inserted = absorbed;
      // No new id — the delta surfaces the absorbing row as `added` so the
      // renderer reconciles via the reducer's id-keyed upsert.
    } else {
      const id = randomUUID();
      const row: NotificationRowSql = {
        id,
        workspace_id: input.workspaceId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body ?? null,
        payload: input.payload ? JSON.stringify(input.payload) : null,
        source_event: input.sourceEvent ?? null,
        dedup_key: input.dedupKey,
        dup_count: 1,
        created_at: now,
        read_at: null,
      };
      db.prepare(
        `INSERT INTO notifications
          (id, workspace_id, kind, severity, title, body, payload, source_event, dedup_key, dup_count, created_at, read_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.workspace_id,
        row.kind,
        row.severity,
        row.title,
        row.body,
        row.payload,
        row.source_event,
        row.dedup_key,
        row.dup_count,
        row.created_at,
        row.read_at,
      );
      inserted = rowToNotification(row);
    }

    // D2.2 — soft-cap collapse. Run after dedup/insert but before hard-cap
    // eviction so the summary row itself counts toward the hard cap.
    removed.push(...this.softCapCollapse(input.workspaceId, input.kind));

    // D2 — hard-cap eviction. Run synchronously so the emitted unreadCount
    // matches the post-eviction state.
    removed.push(...this.evictOverHardCap());

    this.broadcast({ added: [inserted], removed });
    return inserted;
  }

  /** D2 — paginated list for the dropdown initial mount. */
  list(opts: ListOptions = {}): Notification[] {
    const db = getRawDb();
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const offset = Math.max(0, opts.offset ?? 0);

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (opts.workspaceId !== undefined) {
      if (opts.workspaceId === null) {
        clauses.push('workspace_id IS NULL');
      } else {
        clauses.push('workspace_id = ?');
        params.push(opts.workspaceId);
      }
    }
    if (opts.severities && opts.severities.length > 0) {
      const placeholders = opts.severities.map(() => '?').join(',');
      clauses.push(`severity IN (${placeholders})`);
      params.push(...opts.severities);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM notifications
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as NotificationRowSql[];
    return rows.map(rowToNotification);
  }

  /** Current unread count (for badge math + boot snapshot). */
  unreadCount(): number {
    const row = getRawDb()
      .prepare(`SELECT COUNT(*) as n FROM notifications WHERE read_at IS NULL`)
      .get() as { n: number };
    return row.n;
  }

  /** D4 — mark a single row read (no-op if already read). */
  markRead(id: string): void {
    const now = this.now();
    const res = getRawDb()
      .prepare(
        `UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`,
      )
      .run(now, id);
    if (res.changes > 0) this.broadcast({});
  }

  /** D4 — mark every unread row read. */
  markAllRead(): void {
    const now = this.now();
    const res = getRawDb()
      .prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`)
      .run(now);
    if (res.changes > 0) this.broadcast({});
  }

  /** D5 — clear `read_at` on a single row (operator "Mark unread"). */
  markUnread(id: string): void {
    const res = getRawDb()
      .prepare(
        `UPDATE notifications SET read_at = NULL WHERE id = ? AND read_at IS NOT NULL`,
      )
      .run(id);
    if (res.changes > 0) this.broadcast({});
  }

  /** D5 — DELETE the row outright. The dropdown removes it from view. */
  dismiss(id: string): void {
    const res = getRawDb()
      .prepare(`DELETE FROM notifications WHERE id = ?`)
      .run(id);
    if (res.changes > 0) this.broadcast({ removed: [id] });
  }

  /** D2 — bulk DELETE every read row. Operator "Clear read". */
  clearRead(): string[] {
    const db = getRawDb();
    const rows = db
      .prepare(`SELECT id FROM notifications WHERE read_at IS NOT NULL`)
      .all() as { id: string }[];
    if (rows.length === 0) return [];
    db.prepare(`DELETE FROM notifications WHERE read_at IS NOT NULL`).run();
    const removed = rows.map((r) => r.id);
    this.broadcast({ removed });
    return removed;
  }

  /** D2 — boot-time GC. Drops read rows older than `READ_TTL_MS`. */
  gc(): string[] {
    const cutoff = this.now() - READ_TTL_MS;
    const db = getRawDb();
    const rows = db
      .prepare(
        `SELECT id FROM notifications WHERE read_at IS NOT NULL AND created_at < ?`,
      )
      .all(cutoff) as { id: string }[];
    if (rows.length === 0) return [];
    db.prepare(
      `DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?`,
    ).run(cutoff);
    const removed = rows.map((r) => r.id);
    this.broadcast({ removed });
    return removed;
  }

  /**
   * D2.2 — Soft-cap collapse. When unread rows for a given (workspace_id, kind)
   * exceed SOFT_CAP_PER_KIND_WS, delete the oldest SOFT_CAP_COLLAPSE_BATCH
   * unread rows and INSERT a single `<kind>-summary` row describing how many
   * were collapsed.
   *
   * Returns the ids of the collapsed rows (to include in the broadcast delta).
   * The summary row is NOT included in the returned ids — it is emitted via
   * the caller's `added` payload.
   */
  private softCapCollapse(workspaceId: string | null, kind: string): string[] {
    const db = getRawDb();
    const countRow = (
      workspaceId === null
        ? db
            .prepare(
              `SELECT COUNT(*) AS n FROM notifications
               WHERE workspace_id IS NULL AND kind = ? AND read_at IS NULL`,
            )
            .get(kind)
        : db
            .prepare(
              `SELECT COUNT(*) AS n FROM notifications
               WHERE workspace_id = ? AND kind = ? AND read_at IS NULL`,
            )
            .get(workspaceId, kind)
    ) as { n: number };

    if (countRow.n <= SOFT_CAP_PER_KIND_WS) return [];

    // Find the oldest SOFT_CAP_COLLAPSE_BATCH unread rows for this (ws, kind).
    const victims = (
      workspaceId === null
        ? db
            .prepare(
              `SELECT id FROM notifications
               WHERE workspace_id IS NULL AND kind = ? AND read_at IS NULL
               ORDER BY created_at ASC LIMIT ?`,
            )
            .all(kind, SOFT_CAP_COLLAPSE_BATCH)
        : db
            .prepare(
              `SELECT id FROM notifications
               WHERE workspace_id = ? AND kind = ? AND read_at IS NULL
               ORDER BY created_at ASC LIMIT ?`,
            )
            .all(workspaceId, kind, SOFT_CAP_COLLAPSE_BATCH)
    ) as { id: string }[];

    if (victims.length === 0) return [];

    const victimIds = victims.map((v) => v.id);
    const placeholders = victimIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM notifications WHERE id IN (${placeholders})`).run(...victimIds);

    // Insert a summary row. The count reflects how many rows we actually
    // removed from the user's view (= victims.length). The summary row
    // itself becomes one of the visible notifications, so net: 50 rows
    // removed → 1 summary inserted → 49 fewer visible rows, but the
    // surfaced text reports the work done (50 collapsed) to match the
    // brief D2.2 user-visible accounting.
    const collapsed = victims.length;
    const summaryId = randomUUID();
    const now = this.now();
    db.prepare(
      `INSERT INTO notifications
        (id, workspace_id, kind, severity, title, body, payload, source_event, dedup_key, dup_count, created_at, read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      summaryId,
      workspaceId,
      `${kind}-summary`,
      'info',
      `${collapsed} ${kind} notifications collapsed`,
      `${collapsed} more ${kind} notifications collapsed`,
      null,
      null,
      `${kind}-summary:${now}`,
      1,
      now,
      null,
    );

    return victimIds;
  }

  /** D2 — hard-cap eviction. Returns deleted ids. Severity-aware: never
   *  auto-drops `error` or `critical` (operator must dismiss). */
  private evictOverHardCap(): string[] {
    const db = getRawDb();
    const { n } = db
      .prepare(`SELECT COUNT(*) as n FROM notifications`)
      .get() as { n: number };
    if (n <= HARD_CAP_TOTAL) return [];

    const over = n - HARD_CAP_TOTAL;
    const removed: string[] = [];

    // Pass 1 — drop oldest READ rows.
    const readVictims = db
      .prepare(
        `SELECT id FROM notifications
         WHERE read_at IS NOT NULL
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(over) as { id: string }[];
    if (readVictims.length > 0) {
      const placeholders = readVictims.map(() => '?').join(',');
      db.prepare(`DELETE FROM notifications WHERE id IN (${placeholders})`).run(
        ...readVictims.map((v) => v.id),
      );
      removed.push(...readVictims.map((v) => v.id));
    }

    // Pass 2 — still over? Drop oldest INFO unread (warn/error/critical kept).
    let stillOver = over - readVictims.length;
    if (stillOver > 0) {
      const infoVictims = db
        .prepare(
          `SELECT id FROM notifications
           WHERE read_at IS NULL AND severity = 'info'
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(stillOver) as { id: string }[];
      if (infoVictims.length > 0) {
        const placeholders = infoVictims.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM notifications WHERE id IN (${placeholders})`,
        ).run(...infoVictims.map((v) => v.id));
        removed.push(...infoVictims.map((v) => v.id));
        stillOver -= infoVictims.length;
      }
    }

    // Pass 3 — STILL over? Drop oldest WARN unread (error/critical never
    // auto-evicted per D2). This is a degenerate case (500+ unread warns)
    // but the cap must hold; otherwise dropdown UX breaks.
    if (stillOver > 0) {
      const warnVictims = db
        .prepare(
          `SELECT id FROM notifications
           WHERE read_at IS NULL AND severity = 'warn'
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(stillOver) as { id: string }[];
      if (warnVictims.length > 0) {
        const placeholders = warnVictims.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM notifications WHERE id IN (${placeholders})`,
        ).run(...warnVictims.map((v) => v.id));
        removed.push(...warnVictims.map((v) => v.id));
      }
    }
    // If we're STILL over after pass 3, every remaining row is error or
    // critical; we deliberately do NOT evict them — the operator must
    // dismiss (D2 contract). The cap soft-breaks and the dropdown stays
    // overweight until the operator clears errors.

    return removed;
  }

  /** Build + emit the delta envelope. `added`/`removed` default to []; the
   *  unreadCount is always queried fresh so the renderer reducer can trust
   *  it as the source of truth. */
  private broadcast(partial: Partial<Omit<NotificationsDelta, 'unreadCount'>>): void {
    const delta: NotificationsDelta = {
      added: partial.added ?? [],
      removed: partial.removed ?? [],
      unreadCount: this.unreadCount(),
    };
    try {
      this.emit(delta);
    } catch {
      /* renderer broadcast is fire-and-forget; never block on it */
    }
  }
}

/** Compare two severities and return the higher. Used during dedup absorb
 *  so a warn → info dup escalates the absorbing row's severity. */
function pickHigherSeverity(
  a: NotificationSeverity,
  b: NotificationSeverity,
): NotificationSeverity {
  const order: NotificationSeverity[] = ['info', 'warn', 'error', 'critical'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** Pull the trailing ` (×N)` suffix off the body if dedup added it; lets us
 *  re-compose `<original> (×M)` cleanly without compounding suffixes. */
function stripDupSuffix(body: string | null): string | null {
  if (!body) return body;
  const m = body.match(/^(.*?)\s*\(×\d+\)\s*$/);
  return m ? m[1] : body;
}
