// v1.4.9 #07 — NotificationsManager unit tests. The manager fires SQL that
// the generic `db-fake-raw` doesn't parse (IS NULL, ORDER BY, LIMIT, partial
// indexes, DELETE-WHERE-IN), so this test ships a focused in-memory fake
// scoped to the manager's exact statement set rather than reusing the
// generic shim. The point of these tests is the D1–D6 taxonomy semantics —
// dedup window, severity bump, hard-cap eviction order, GC TTL — NOT SQL
// engine fidelity.
// v1.5.1-C caveat 5 — Added soft-cap collapse SQL handlers + tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getRawDb: vi.fn(),
  getDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getRawDb } from '../db/client';
import {
  DEDUP_WINDOW_MS,
  HARD_CAP_TOTAL,
  NotificationsManager,
  READ_TTL_MS,
  SOFT_CAP_PER_KIND_WS,
  SOFT_CAP_COLLAPSE_BATCH,
} from './manager';
import type {
  Notification,
  NotificationSeverity,
  NotificationsDelta,
} from '../../../shared/types';

interface Row {
  id: string;
  workspace_id: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  payload: string | null;
  source_event: string | null;
  dedup_key: string;
  dup_count: number;
  created_at: number;
  read_at: number | null;
}

class NotificationsTestDb {
  rows: Row[] = [];
  revision = 0;
  failRevisionUpdate = false;

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      const rowsBefore = this.rows.map((row) => ({ ...row }));
      const revisionBefore = this.revision;
      try {
        return fn(...args);
      } catch (error) {
        this.rows = rowsBefore;
        this.revision = revisionBefore;
        throw error;
      }
    };
  }

  prepare(sql: string) {
    const s = sql.replace(/\s+/g, ' ').trim();
    // ── INSERT ────────────────────────────────────────────────────────
    if (s.startsWith('INSERT INTO notifications')) {
      return {
        run: (...args: unknown[]): { changes: number; lastInsertRowid: number } => {
          this.rows.push({
            id: args[0] as string,
            workspace_id: args[1] as string | null,
            kind: args[2] as string,
            severity: args[3] as NotificationSeverity,
            title: args[4] as string,
            body: args[5] as string | null,
            payload: args[6] as string | null,
            source_event: args[7] as string | null,
            dedup_key: args[8] as string,
            dup_count: args[9] as number,
            created_at: args[10] as number,
            read_at: args[11] as number | null,
          });
          return { changes: 1, lastInsertRowid: this.rows.length };
        },
      };
    }
    // ── SELECT (dedup match — global) ────────────────────────────────
    if (s.includes('workspace_id IS NULL') && s.includes('dedup_key = ?')) {
      return {
        get: (dedupKey: string, since: number): Row | undefined => {
          const candidates = this.rows.filter(
            (r) =>
              r.workspace_id === null &&
              r.dedup_key === dedupKey &&
              r.read_at === null &&
              r.created_at >= since,
          );
          candidates.sort((a, b) => b.created_at - a.created_at);
          return candidates[0];
        },
      };
    }
    // ── SELECT (dedup match — workspace) ──────────────────────────────
    if (
      s.includes('workspace_id = ?') &&
      s.includes('dedup_key = ?') &&
      s.includes('read_at IS NULL') &&
      s.includes('LIMIT 1')
    ) {
      return {
        get: (workspaceId: string, dedupKey: string, since: number): Row | undefined => {
          const candidates = this.rows.filter(
            (r) =>
              r.workspace_id === workspaceId &&
              r.dedup_key === dedupKey &&
              r.read_at === null &&
              r.created_at >= since,
          );
          candidates.sort((a, b) => b.created_at - a.created_at);
          return candidates[0];
        },
      };
    }
    // ── UPDATE (dedup absorb) ─────────────────────────────────────────
    if (s.startsWith('UPDATE notifications SET dup_count =')) {
      return {
        run: (
          dupCount: number,
          createdAt: number,
          body: string,
          severity: NotificationSeverity,
          title: string,
          id: string,
        ): { changes: number } => {
          const row = this.rows.find((r) => r.id === id);
          if (!row) return { changes: 0 };
          row.dup_count = dupCount;
          row.created_at = createdAt;
          row.body = body;
          row.severity = severity;
          row.title = title;
          return { changes: 1 };
        },
      };
    }
    // ── SELECT * WHERE id = ? (refresh) ───────────────────────────────
    if (/^SELECT \* FROM notifications WHERE id = \?$/.test(s)) {
      return {
        get: (id: string): Row | undefined => this.rows.find((r) => r.id === id),
      };
    }
    // ── SELECT * unread (markAllRead read-state snapshot) ─────────────
    if (/^SELECT \* FROM notifications WHERE read_at IS NULL$/.test(s)) {
      return {
        all: (): Row[] => this.rows.filter((r) => r.read_at === null),
      };
    }
    // ── COUNT unread ──────────────────────────────────────────────────
    if (s.includes('SELECT severity, COUNT(*) AS n') && s.includes('GROUP BY severity')) {
      return {
        all: (): { severity: NotificationSeverity; n: number }[] => {
          const counts = new Map<NotificationSeverity, number>();
          for (const row of this.rows) {
            if (row.read_at !== null) continue;
            counts.set(row.severity, (counts.get(row.severity) ?? 0) + 1);
          }
          return Array.from(counts, ([severity, n]) => ({ severity, n }));
        },
      };
    }
    if (s.includes('COUNT(*) as n FROM notifications WHERE read_at IS NULL')) {
      return {
        get: (): { n: number } => ({
          n: this.rows.filter((r) => r.read_at === null).length,
        }),
      };
    }
    if (
      s.startsWith('UPDATE notification_state SET revision = revision + 1') &&
      s.includes('RETURNING revision')
    ) {
      return {
        get: (): { revision: number } => {
          if (this.failRevisionUpdate) throw new Error('forced revision failure');
          return { revision: ++this.revision };
        },
      };
    }
    if (s === 'SELECT revision FROM notification_state WHERE singleton = 1') {
      return {
        get: (): { revision: number } => ({ revision: this.revision }),
      };
    }
    // ── COUNT all ────────────────────────────────────────────────────
    if (s === 'SELECT COUNT(*) as n FROM notifications') {
      return {
        get: (): { n: number } => ({ n: this.rows.length }),
      };
    }
    // ── UPDATE markRead (single row, only if unread) ──────────────────
    if (
      /^UPDATE notifications SET read_at = \? WHERE id = \? AND read_at IS NULL$/.test(s)
    ) {
      return {
        run: (ts: number, id: string): { changes: number } => {
          const row = this.rows.find((r) => r.id === id && r.read_at === null);
          if (!row) return { changes: 0 };
          row.read_at = ts;
          return { changes: 1 };
        },
      };
    }
    // ── UPDATE markAllRead ────────────────────────────────────────────
    if (
      /^UPDATE notifications SET read_at = \? WHERE read_at IS NULL$/.test(s)
    ) {
      return {
        run: (ts: number): { changes: number } => {
          let changes = 0;
          for (const r of this.rows) {
            if (r.read_at === null) {
              r.read_at = ts;
              changes++;
            }
          }
          return { changes };
        },
      };
    }
    // ── UPDATE markUnread ─────────────────────────────────────────────
    if (
      /^UPDATE notifications SET read_at = NULL WHERE id = \? AND read_at IS NOT NULL$/.test(
        s,
      )
    ) {
      return {
        run: (id: string): { changes: number } => {
          const row = this.rows.find((r) => r.id === id && r.read_at !== null);
          if (!row) return { changes: 0 };
          row.read_at = null;
          return { changes: 1 };
        },
      };
    }
    // ── DELETE single ────────────────────────────────────────────────
    if (/^DELETE FROM notifications WHERE id = \?$/.test(s)) {
      return {
        run: (id: string): { changes: number } => {
          const idx = this.rows.findIndex((r) => r.id === id);
          if (idx < 0) return { changes: 0 };
          this.rows.splice(idx, 1);
          return { changes: 1 };
        },
      };
    }
    // ── SELECT id FROM read (clearRead enumerate) ─────────────────────
    if (
      /^SELECT id FROM notifications WHERE read_at IS NOT NULL$/.test(s)
    ) {
      return {
        all: (): { id: string }[] =>
          this.rows.filter((r) => r.read_at !== null).map((r) => ({ id: r.id })),
      };
    }
    // ── DELETE clearRead ─────────────────────────────────────────────
    if (/^DELETE FROM notifications WHERE read_at IS NOT NULL$/.test(s)) {
      return {
        run: (): { changes: number } => {
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => r.read_at === null);
          return { changes: before - this.rows.length };
        },
      };
    }
    // ── GC select (read older than cutoff) ────────────────────────────
    if (
      /^SELECT id FROM notifications WHERE read_at IS NOT NULL AND created_at < \?$/.test(
        s,
      )
    ) {
      return {
        all: (cutoff: number): { id: string }[] =>
          this.rows
            .filter((r) => r.read_at !== null && r.created_at < cutoff)
            .map((r) => ({ id: r.id })),
      };
    }
    if (
      /^DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < \?$/.test(
        s,
      )
    ) {
      return {
        run: (cutoff: number): { changes: number } => {
          const before = this.rows.length;
          this.rows = this.rows.filter(
            (r) => !(r.read_at !== null && r.created_at < cutoff),
          );
          return { changes: before - this.rows.length };
        },
      };
    }
    // ── Eviction passes ──────────────────────────────────────────────
    if (
      s.includes('WHERE read_at IS NOT NULL') &&
      s.includes('ORDER BY created_at ASC') &&
      s.includes('LIMIT ?')
    ) {
      return {
        all: (lim: number): { id: string }[] => {
          const sorted = this.rows
            .filter((r) => r.read_at !== null)
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, lim);
          return sorted.map((r) => ({ id: r.id }));
        },
      };
    }
    if (
      s.includes("severity NOT IN ('warn', 'error', 'critical')") &&
      s.includes('read_at IS NULL') &&
      s.includes('ORDER BY created_at ASC') &&
      s.includes('LIMIT ?')
    ) {
      return {
        all: (lim: number): { id: string }[] => {
          const sorted = this.rows
            .filter(
              (r) =>
                r.read_at === null &&
                r.severity !== 'warn' &&
                r.severity !== 'error' &&
                r.severity !== 'critical',
            )
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, lim);
          return sorted.map((r) => ({ id: r.id }));
        },
      };
    }
    if (
      s.includes("severity = 'warn'") &&
      s.includes('read_at IS NULL') &&
      s.includes('ORDER BY created_at ASC') &&
      s.includes('LIMIT ?')
    ) {
      return {
        all: (lim: number): { id: string }[] => {
          const sorted = this.rows
            .filter((r) => r.read_at === null && r.severity === 'warn')
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, lim);
          return sorted.map((r) => ({ id: r.id }));
        },
      };
    }
    // ── DELETE IN (eviction) ─────────────────────────────────────────
    if (/^DELETE FROM notifications WHERE id IN \(/.test(s)) {
      return {
        run: (...ids: string[]): { changes: number } => {
          const set = new Set(ids);
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => !set.has(r.id));
          return { changes: before - this.rows.length };
        },
      };
    }
    // ── Soft-cap COUNT (workspace) — softCapCollapse ─────────────────
    if (
      s.includes('COUNT(*) AS n FROM notifications') &&
      s.includes('workspace_id = ?') &&
      s.includes('kind = ?') &&
      s.includes('read_at IS NULL')
    ) {
      return {
        get: (workspaceId: string, kind: string): { n: number } => ({
          n: this.rows.filter(
            (r) =>
              r.workspace_id === workspaceId &&
              r.kind === kind &&
              r.read_at === null,
          ).length,
        }),
      };
    }
    // ── Soft-cap COUNT (global) — softCapCollapse ─────────────────────
    if (
      s.includes('COUNT(*) AS n FROM notifications') &&
      s.includes('workspace_id IS NULL') &&
      s.includes('kind = ?') &&
      s.includes('read_at IS NULL')
    ) {
      return {
        get: (kind: string): { n: number } => ({
          n: this.rows.filter(
            (r) => r.workspace_id === null && r.kind === kind && r.read_at === null,
          ).length,
        }),
      };
    }
    // ── Soft-cap victim SELECT (workspace) ────────────────────────────
    if (
      s.includes('workspace_id = ?') &&
      s.includes('kind = ?') &&
      s.includes('read_at IS NULL') &&
      s.includes('ORDER BY created_at ASC') &&
      s.includes('LIMIT ?')
    ) {
      return {
        all: (workspaceId: string, kind: string, lim: number): { id: string }[] => {
          const sorted = this.rows
            .filter(
              (r) =>
                r.workspace_id === workspaceId &&
                r.kind === kind &&
                r.read_at === null &&
                r.severity !== 'error' &&
                r.severity !== 'critical',
            )
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, lim);
          return sorted.map((r) => ({ id: r.id }));
        },
      };
    }
    // ── Soft-cap victim SELECT (global) ───────────────────────────────
    if (
      s.includes('workspace_id IS NULL') &&
      s.includes('kind = ?') &&
      s.includes('read_at IS NULL') &&
      s.includes('ORDER BY created_at ASC') &&
      s.includes('LIMIT ?')
    ) {
      return {
        all: (kind: string, lim: number): { id: string }[] => {
          const sorted = this.rows
            .filter(
              (r) =>
                r.workspace_id === null &&
                r.kind === kind &&
                r.read_at === null &&
                r.severity !== 'error' &&
                r.severity !== 'critical',
            )
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, lim);
          return sorted.map((r) => ({ id: r.id }));
        },
      };
    }

    // ── KEYSET PAGE query ────────────────────────────────────────────
    if (
      s.startsWith('SELECT * FROM notifications') &&
      s.includes('ORDER BY created_at DESC, id DESC')
    ) {
      return {
        all: (...args: unknown[]): Row[] => {
          let pos = 0;
          let filtered = this.rows.slice();
          if (s.includes('workspace_id = ?')) {
            const wsId = args[pos++] as string;
            filtered = filtered.filter((r) => r.workspace_id === wsId);
          } else if (s.includes('workspace_id IS NULL')) {
            filtered = filtered.filter((r) => r.workspace_id === null);
          }
          const sevMatch = s.match(/(?:END|severity) IN \((\?(?:,\?)*)\)/);
          if (sevMatch) {
            const count = sevMatch[1].split(',').length;
            const severities = args.slice(pos, pos + count) as NotificationSeverity[];
            pos += count;
            filtered = filtered.filter((r) =>
              severities.includes(
                r.severity === 'info' ||
                  r.severity === 'warn' ||
                  r.severity === 'error' ||
                  r.severity === 'critical'
                  ? r.severity
                  : 'info',
              ),
            );
          }
          if (s.includes('(created_at < ? OR (created_at = ? AND id < ?))')) {
            const createdAt = args[pos++] as number;
            pos++;
            const id = args[pos++] as string;
            filtered = filtered.filter(
              (row) =>
                row.created_at < createdAt ||
                (row.created_at === createdAt && row.id < id),
            );
          }
          const limit = args[pos] as number;
          filtered.sort((a, b) => {
            if (a.created_at !== b.created_at) return b.created_at - a.created_at;
            if (a.id === b.id) return 0;
            return a.id > b.id ? -1 : 1;
          });
          return filtered.slice(0, limit);
        },
      };
    }

    // ── LIST query ───────────────────────────────────────────────────
    if (s.startsWith('SELECT * FROM notifications') && s.includes('ORDER BY created_at DESC')) {
      return {
        all: (...args: unknown[]): Row[] => {
          // params end with limit, offset
          let pos = 0;
          let filtered = this.rows.slice();
          // The list() builder may inject `workspace_id = ?` or `workspace_id IS NULL`
          // plus `severity IN (?, ?, ...)` clauses. Parse them dynamically.
          if (s.includes('workspace_id = ?')) {
            const wsId = args[pos++] as string;
            filtered = filtered.filter((r) => r.workspace_id === wsId);
          } else if (s.includes('workspace_id IS NULL')) {
            filtered = filtered.filter((r) => r.workspace_id === null);
          }
          const sevMatch = s.match(/(?:END|severity) IN \((\?(?:,\?)*)\)/);
          if (sevMatch) {
            const count = sevMatch[1].split(',').length;
            const sevs = args.slice(pos, pos + count) as NotificationSeverity[];
            pos += count;
            filtered = filtered.filter((r) =>
              sevs.includes(
                r.severity === 'info' ||
                  r.severity === 'warn' ||
                  r.severity === 'error' ||
                  r.severity === 'critical'
                  ? r.severity
                  : 'info',
              ),
            );
          }
          const limit = args[args.length - 2] as number;
          const offset = args[args.length - 1] as number;
          void pos;
          filtered.sort((a, b) => b.created_at - a.created_at);
          return filtered.slice(offset, offset + limit);
        },
      };
    }
    throw new Error('Unhandled SQL: ' + s);
  }
}

let fakeDb: NotificationsTestDb;
let emitted: NotificationsDelta[];
let now: number;

function makeManager(): NotificationsManager {
  return new NotificationsManager({
    emit: (delta) => emitted.push(delta),
    now: () => now,
  });
}

beforeEach(() => {
  fakeDb = new NotificationsTestDb();
  vi.mocked(getRawDb).mockReturnValue(fakeDb as unknown as ReturnType<typeof getRawDb>);
  emitted = [];
  now = 1_000_000_000_000;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('NotificationsManager.add', () => {
  it('inserts a fresh row when no dedup match exists', () => {
    const mgr = makeManager();
    const out = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      dedupKey: 'pty-exit:s-1',
    });
    expect(out.severity).toBe('info');
    expect(out.dupCount).toBe(1);
    expect(fakeDb.rows).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].unreadCount).toBe(1);
    expect(emitted[0].added).toHaveLength(1);
  });

  it('folds a dup into the existing row within the 30s window (D3)', () => {
    const mgr = makeManager();
    const first = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      body: 'code 0',
      dedupKey: 'pty-exit:s-1',
    });
    now += 5_000;
    const second = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      body: 'code 0',
      dedupKey: 'pty-exit:s-1',
    });
    expect(fakeDb.rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.dupCount).toBe(2);
    expect(second.body).toBe('code 0 (×2)');
  });

  it('does NOT dedup outside the 30s window (D3)', () => {
    const mgr = makeManager();
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      dedupKey: 'pty-exit:s-1',
    });
    now += DEDUP_WINDOW_MS + 1_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      dedupKey: 'pty-exit:s-1',
    });
    expect(fakeDb.rows).toHaveLength(2);
  });

  it('critical severity NEVER dedups (D3 bypass)', () => {
    const mgr = makeManager();
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'auth-invalid',
      severity: 'critical',
      title: 'API key invalid',
      dedupKey: 'auth-invalid:global',
    });
    now += 1_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'auth-invalid',
      severity: 'critical',
      title: 'API key invalid',
      dedupKey: 'auth-invalid:global',
    });
    expect(fakeDb.rows).toHaveLength(2);
  });

  it('bumps severity on dedup absorb (warn over info)', () => {
    const mgr = makeManager();
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      dedupKey: 'pty-exit:s-1',
    });
    now += 1_000;
    const second = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'warn',
      title: 'shell exited',
      dedupKey: 'pty-exit:s-1',
    });
    expect(second.severity).toBe('warn');
    expect(fakeDb.rows).toHaveLength(1);
  });

  it('rejects an empty dedupKey', () => {
    const mgr = makeManager();
    expect(() =>
      mgr.add({
        workspaceId: 'ws-1',
        kind: 'pty-exit',
        severity: 'info',
        title: 'oops',
        dedupKey: '',
      }),
    ).toThrow(/dedupKey is required/);
  });

  it('rejects an unknown severity', () => {
    const mgr = makeManager();
    expect(() =>
      mgr.add({
        workspaceId: 'ws-1',
        kind: 'x',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        severity: 'fatal' as any,
        title: 'oops',
        dedupKey: 'x:1',
      }),
    ).toThrow(/invalid severity/);
  });

  it('preserves a read row from absorbing — read rows do NOT absorb (D3)', () => {
    const mgr = makeManager();
    const first = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      dedupKey: 'pty-exit:s-1',
    });
    mgr.markRead(first.id);
    now += 1_000;
    const second = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      dedupKey: 'pty-exit:s-1',
    });
    // First row is read — the new event creates a fresh row, not absorbed.
    expect(fakeDb.rows).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
  });

  it('emits authoritative unread counts for every severity', () => {
    const mgr = makeManager();
    const severities: NotificationSeverity[] = [
      'info',
      'warn',
      'error',
      'critical',
    ];
    for (const severity of severities) {
      mgr.add({
        workspaceId: 'ws-1',
        kind: `kind-${severity}`,
        severity,
        title: severity,
        dedupKey: `counts-${severity}`,
      });
      now += 1;
    }

    expect(emitted.at(-1)?.counts).toEqual({
      unread: 4,
      unreadBySeverity: {
        info: 1,
        warn: 1,
        error: 1,
        critical: 1,
      },
    });
  });

  it('counts legacy unknown severities as info instead of dropping unread rows', () => {
    fakeDb.rows.push(
      {
        id: 'valid-info-severity',
        workspace_id: 'ws-1',
        kind: 'current',
        severity: 'info',
        title: 'current row',
        body: null,
        payload: null,
        source_event: null,
        dedup_key: 'valid-info-severity',
        dup_count: 1,
        created_at: now,
        read_at: null,
      },
      {
        id: 'legacy-unknown-severity',
        workspace_id: 'ws-1',
        kind: 'legacy',
        severity: 'fatal' as NotificationSeverity,
        title: 'legacy row',
        body: null,
        payload: null,
        source_event: null,
        dedup_key: 'legacy-unknown-severity',
        dup_count: 1,
        created_at: now - 1,
        read_at: null,
      },
    );

    expect(makeManager().unreadCounts()).toEqual({
      unread: 2,
      unreadBySeverity: { info: 2, warn: 0, error: 0, critical: 0 },
    });
  });

  it('advances revision exactly once per changing mutation and never for no-ops', () => {
    const mgr = makeManager();
    const row = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'shell exited',
      dedupKey: 'revision-row',
    });
    mgr.markRead(row.id);
    mgr.markRead(row.id);
    mgr.dismiss('missing-id');

    expect(emitted.map((delta) => delta.revision)).toEqual([1, 2]);
  });
});

describe('NotificationsManager.markRead / markAllRead / markUnread', () => {
  it('markRead clears unread for one row and emits delta', () => {
    const mgr = makeManager();
    const a = mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 't',
      dedupKey: 'k1',
    });
    emitted.length = 0;
    mgr.markRead(a.id);
    expect(fakeDb.rows[0].read_at).toBe(now);
    expect(emitted[0].unreadCount).toBe(0);
  });

  it('markAllRead clears every unread row', () => {
    const mgr = makeManager();
    mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    mgr.add({ workspaceId: 'ws-1', kind: 'b', severity: 'warn', title: 't', dedupKey: 'k2' });
    emitted.length = 0;
    mgr.markAllRead();
    expect(fakeDb.rows.every((r) => r.read_at !== null)).toBe(true);
    expect(emitted[0].unreadCount).toBe(0);
  });

  it('markUnread re-opens a row (D5)', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    mgr.markRead(a.id);
    emitted.length = 0;
    mgr.markUnread(a.id);
    expect(fakeDb.rows[0].read_at).toBeNull();
    expect(emitted[0].unreadCount).toBe(1);
  });

  // 2026-07-02 review fix A — read-state mutations must carry the mutated
  // row(s) so every window reconciles row STYLING, not just the badge. They
  // ride the delta's `updated` lane: reconcile-only, never alert (`added`
  // drives toast/tone/OS-banner and must stay empty here).
  it('markRead emits the mutated row in updated with readAt set', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    emitted.length = 0;
    mgr.markRead(a.id);
    expect(emitted[0].updated).toHaveLength(1);
    expect(emitted[0].updated![0]!.id).toBe(a.id);
    expect(emitted[0].updated![0]!.readAt).toBe(now);
    expect(emitted[0].added).toHaveLength(0);
  });

  it('markAllRead emits every previously-unread row in updated (already-read rows excluded)', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    const b = mgr.add({ workspaceId: 'ws-1', kind: 'b', severity: 'warn', title: 't', dedupKey: 'k2' });
    mgr.markRead(a.id); // pre-read — must NOT re-surface in the delta
    emitted.length = 0;
    mgr.markAllRead();
    expect(emitted[0].updated?.map((n) => n.id)).toEqual([b.id]);
    expect(emitted[0].updated![0]!.readAt).toBe(now);
    expect(emitted[0].added).toHaveLength(0);
  });

  it('markUnread emits the row in updated with readAt null (no re-alert via added)', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    mgr.markRead(a.id);
    emitted.length = 0;
    mgr.markUnread(a.id);
    expect(emitted[0].updated).toHaveLength(1);
    expect(emitted[0].updated![0]!.readAt).toBeNull();
    expect(emitted[0].added).toHaveLength(0);
  });

  it('markRead is a no-op on already-read rows (no event)', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    mgr.markRead(a.id);
    emitted.length = 0;
    mgr.markRead(a.id);
    expect(emitted).toHaveLength(0);
  });
});

describe('NotificationsManager.dismiss / clearRead', () => {
  it('dismiss DELETEs the row (D5 — not the same as markRead)', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    emitted.length = 0;
    mgr.dismiss(a.id);
    expect(fakeDb.rows).toHaveLength(0);
    expect(emitted[0].removed).toEqual([a.id]);
  });

  it('clearRead bulk-DELETEs read rows', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    const b = mgr.add({ workspaceId: 'ws-1', kind: 'b', severity: 'info', title: 't', dedupKey: 'k2' });
    mgr.markRead(a.id);
    emitted.length = 0;
    const removed = mgr.clearRead();
    expect(removed).toEqual([a.id]);
    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.rows[0].id).toBe(b.id);
  });
});

describe('NotificationsManager.gc', () => {
  it('drops read rows older than 30 days (D2 TTL)', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    mgr.markRead(a.id);
    // Advance time past the TTL — read_at and created_at are both before cutoff.
    now += READ_TTL_MS + 1_000;
    const removed = mgr.gc();
    expect(removed).toEqual([a.id]);
    expect(fakeDb.rows).toHaveLength(0);
  });

  it('keeps recent read rows (still within TTL)', () => {
    const mgr = makeManager();
    const a = mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'k1' });
    mgr.markRead(a.id);
    now += 1_000;
    const removed = mgr.gc();
    expect(removed).toEqual([]);
    expect(fakeDb.rows).toHaveLength(1);
  });

  it('never drops unread rows even when far older than TTL', () => {
    const mgr = makeManager();
    mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'error', title: 't', dedupKey: 'k1' });
    now += READ_TTL_MS * 2;
    const removed = mgr.gc();
    expect(removed).toEqual([]);
    expect(fakeDb.rows).toHaveLength(1);
  });
});

describe('NotificationsManager hard-cap eviction (D2)', () => {
  // Each seeded row gets its own unique kind (kind-<id>) so no single
  // (workspace, kind) bucket exceeds SOFT_CAP_PER_KIND_WS=200 and
  // soft-cap collapse never fires during hard-cap eviction tests.
  function seedRow(
    fake: NotificationsTestDb,
    partial: Partial<Row> & { id: string; created_at: number; severity: NotificationSeverity },
  ): Row {
    const row: Row = {
      workspace_id: 'ws-1',
      kind: `kind-${partial.id}`,
      title: 't',
      body: null,
      payload: null,
      source_event: null,
      dedup_key: `k-${partial.id}`,
      dup_count: 1,
      read_at: null,
      ...partial,
    };
    fake.rows.push(row);
    return row;
  }

  it('drops oldest READ rows first', () => {
    // Seed N=500 rows; mark the 100 oldest as read.
    for (let i = 0; i < HARD_CAP_TOTAL; i++) {
      seedRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
        severity: 'info',
        read_at: i < 100 ? 200 + i : null,
      });
    }
    const mgr = makeManager();
    // Adding one more pushes us to 501 — eviction must drop a read row.
    now = 2_000_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'fresh',
      dedupKey: 'fresh-1',
    });
    expect(fakeDb.rows).toHaveLength(HARD_CAP_TOTAL);
    // Oldest read row (id r-0000) should be gone.
    expect(fakeDb.rows.find((r) => r.id === 'r-0000')).toBeUndefined();
  });

  it('when all 500 are unread, drops oldest INFO (warn/error/critical survive)', () => {
    for (let i = 0; i < HARD_CAP_TOTAL; i++) {
      // Half info, half error, distributed so the oldest are info.
      const severity: NotificationSeverity = i < 250 ? 'info' : 'error';
      seedRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
        severity,
      });
    }
    const mgr = makeManager();
    now = 2_000_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'fresh',
      dedupKey: 'fresh-1',
    });
    expect(fakeDb.rows).toHaveLength(HARD_CAP_TOTAL);
    // Oldest info (r-0000) evicted. r-0250 (first error) MUST survive.
    expect(fakeDb.rows.find((r) => r.id === 'r-0000')).toBeUndefined();
    expect(fakeDb.rows.find((r) => r.id === 'r-0250')).toBeDefined();
  });

  it('evicts a legacy unknown severity through the normalized INFO lane', () => {
    seedRow(fakeDb, {
      id: 'legacy-unknown',
      created_at: 1,
      severity: 'fatal' as NotificationSeverity,
    });
    for (let i = 1; i < HARD_CAP_TOTAL; i++) {
      seedRow(fakeDb, {
        id: `protected-${i}`,
        created_at: 100 + i,
        severity: 'error',
      });
    }

    const mgr = makeManager();
    now = 2_000_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'critical',
      title: 'fresh',
      dedupKey: 'legacy-eviction-trigger',
    });

    expect(fakeDb.rows).toHaveLength(HARD_CAP_TOTAL);
    expect(fakeDb.rows.find((row) => row.id === 'legacy-unknown')).toBeUndefined();
  });

  it('never auto-evicts critical even under pressure', () => {
    // Half critical so eviction pass 3 (warn) doesn't catch them.
    for (let i = 0; i < HARD_CAP_TOTAL; i++) {
      const severity: NotificationSeverity = i % 2 === 0 ? 'critical' : 'info';
      seedRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
        severity,
      });
    }
    const beforeCriticalCount = fakeDb.rows.filter((r) => r.severity === 'critical').length;
    const mgr = makeManager();
    now = 2_000_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'critical',
      title: 'fresh',
      dedupKey: 'fresh-1',
    });
    const afterCriticalCount = fakeDb.rows.filter((r) => r.severity === 'critical').length;
    // Plus 1 from the fresh insert.
    expect(afterCriticalCount).toBe(beforeCriticalCount + 1);
  });
});

describe('NotificationsManager.list', () => {
  it('paginates by limit + offset (newest first)', () => {
    const mgr = makeManager();
    for (let i = 0; i < 5; i++) {
      mgr.add({
        workspaceId: 'ws-1',
        kind: 'a',
        severity: 'info',
        title: `t${i}`,
        dedupKey: `k${i}`,
      });
      now += 100;
    }
    const page1 = mgr.list({ limit: 2, offset: 0 });
    const page2 = mgr.list({ limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0].title).toBe('t4');
    expect(page2[0].title).toBe('t2');
  });

  it('filters by severity set (Errors-only chip — error + critical)', () => {
    const mgr = makeManager();
    mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 'a', dedupKey: 'k1' });
    mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'warn', title: 'b', dedupKey: 'k2' });
    mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'error', title: 'c', dedupKey: 'k3' });
    mgr.add({ workspaceId: 'ws-1', kind: 'a', severity: 'critical', title: 'd', dedupKey: 'k4' });
    const errs = mgr.list({ severities: ['error', 'critical'] });
    expect(errs.map((n: Notification) => n.title).sort()).toEqual(['c', 'd']);
  });
});

describe('NotificationsManager cursor pages', () => {
  function seedCursorRow(id: string, createdAt: number, severity: NotificationSeverity = 'info') {
    fakeDb.rows.push({
      id,
      workspace_id: 'ws-1',
      kind: 'cursor-test',
      severity,
      title: id,
      body: null,
      payload: null,
      source_event: null,
      dedup_key: `cursor-${id}`,
      dup_count: 1,
      created_at: createdAt,
      read_at: null,
    });
  }

  it('pages equal timestamps deterministically without gaps or duplicates', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) seedCursorRow(id, 100);
    const manager = makeManager();

    const first = manager.page({ limit: 2 });
    const second = manager.page({ limit: 2, cursor: first.nextCursor });
    const third = manager.page({ limit: 2, cursor: second.nextCursor });

    expect(first.items.map((row) => row.id)).toEqual(['e', 'd']);
    expect(second.items.map((row) => row.id)).toEqual(['c', 'b']);
    expect(third.items.map((row) => row.id)).toEqual(['a']);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.id)),
    ).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('rejects a malformed cursor', () => {
    const manager = makeManager();

    expect(() => manager.page({ cursor: 'not-a-valid-cursor' })).toThrow(
      'invalid notification cursor',
    );
  });

  it('reapplies workspace and severity filters to cursor pages', () => {
    seedCursorRow('ws-info', 100, 'info');
    seedCursorRow('ws-error', 101, 'error');
    seedCursorRow('ws-critical', 102, 'critical');
    fakeDb.rows.push({
      ...fakeDb.rows[2],
      id: 'other-critical',
      workspace_id: 'ws-2',
      dedup_key: 'cursor-other-critical',
      created_at: 103,
    });
    const manager = makeManager();

    const page = manager.page({
      workspaceId: 'ws-1',
      severities: ['error', 'critical'],
      limit: 10,
    });

    expect(page.items.map((row) => row.id)).toEqual(['ws-critical', 'ws-error']);
  });

  it('includes a legacy unknown severity in the normalized info page', () => {
    seedCursorRow('legacy-unknown', 100, 'fatal' as NotificationSeverity);

    const page = makeManager().page({ severities: ['info'], limit: 10 });

    expect(page.items).toEqual([
      expect.objectContaining({ id: 'legacy-unknown', severity: 'info' }),
    ]);
  });
});

describe('NotificationsManager.snapshot', () => {
  it('returns one internally consistent revision, count set, and first page', () => {
    const manager = makeManager();
    manager.add({
      workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 'a', dedupKey: 'snapshot-a',
    });
    now += 1;
    manager.add({
      workspaceId: 'ws-1', kind: 'b', severity: 'critical', title: 'b', dedupKey: 'snapshot-b',
    });

    const snapshot = manager.snapshot({ limit: 1 });

    expect(snapshot.revision).toBe(2);
    expect(snapshot.counts).toEqual({
      unread: 2,
      unreadBySeverity: { info: 1, warn: 0, error: 0, critical: 1 },
    });
    expect(snapshot.items.map((row) => row.title)).toEqual(['b']);
    expect(snapshot.nextCursor).not.toBeNull();
  });
});

describe('NotificationsManager soft-cap collapse (D2.2)', () => {
  function seedUnreadRow(
    fake: NotificationsTestDb,
    partial: Partial<Row> & { id: string; created_at: number },
  ): Row {
    const row: Row = {
      workspace_id: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 't',
      body: null,
      payload: null,
      source_event: null,
      dedup_key: `k-${partial.id}`,
      dup_count: 1,
      read_at: null,
      ...partial,
    };
    fake.rows.push(row);
    return row;
  }

  it('does not collapse when under the soft cap', () => {
    const mgr = makeManager();
    // Seed SOFT_CAP_PER_KIND_WS rows (exactly at cap, not over).
    for (let i = 0; i < SOFT_CAP_PER_KIND_WS; i++) {
      seedUnreadRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
      });
    }
    const before = fakeDb.rows.length;
    // Adding one more puts us at cap+1. But collapse only fires when count
    // EXCEEDS the cap (> SOFT_CAP_PER_KIND_WS). At exactly cap+1 it DOES fire.
    // Let's verify by seeding one LESS than cap and adding normally — no collapse.
    fakeDb.rows = []; // reset
    for (let i = 0; i < SOFT_CAP_PER_KIND_WS - 1; i++) {
      seedUnreadRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
      });
    }
    void before;
    now = 2_000_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'new',
      dedupKey: 'dk-new',
    });
    // Count is now exactly SOFT_CAP_PER_KIND_WS — no collapse (not over cap).
    expect(fakeDb.rows.length).toBe(SOFT_CAP_PER_KIND_WS);
    expect(fakeDb.rows.filter((r) => r.kind === 'pty-exit-summary')).toHaveLength(0);
  });

  it('collapses oldest SOFT_CAP_COLLAPSE_BATCH rows and inserts a summary when over cap', () => {
    // Seed SOFT_CAP_PER_KIND_WS + 1 rows (over cap from the start).
    for (let i = 0; i < SOFT_CAP_PER_KIND_WS + 1; i++) {
      seedUnreadRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
      });
    }
    const mgr = makeManager();
    now = 3_000_000;
    // Trigger collapse by adding another row; soft-cap check sees > 200 unread.
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'trigger',
      dedupKey: 'dk-trigger',
    });

    // SOFT_CAP_COLLAPSE_BATCH oldest rows replaced by 1 summary row.
    // Net: (201 + 1 fresh) - 50 victims + 1 summary = 153
    const expectedCount = SOFT_CAP_PER_KIND_WS + 2 - SOFT_CAP_COLLAPSE_BATCH + 1;
    expect(fakeDb.rows.length).toBe(expectedCount);

    // Oldest SOFT_CAP_COLLAPSE_BATCH rows (r-0000 through r-0049) must be gone.
    expect(fakeDb.rows.find((r) => r.id === 'r-0000')).toBeUndefined();
    const lastVictim = `r-${(SOFT_CAP_COLLAPSE_BATCH - 1).toString().padStart(4, '0')}`;
    expect(fakeDb.rows.find((r) => r.id === lastVictim)).toBeUndefined();
    // First survivor must still be present.
    const firstSurvivor = `r-${SOFT_CAP_COLLAPSE_BATCH.toString().padStart(4, '0')}`;
    expect(fakeDb.rows.find((r) => r.id === firstSurvivor)).toBeDefined();

    // One summary row with kind 'pty-exit-summary' must have been inserted.
    const summaryRows = fakeDb.rows.filter((r) => r.kind === 'pty-exit-summary');
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0].body).toContain('collapsed');
  });

  it('preserves protected unread rows during soft-cap collapse', () => {
    const protectedIds: string[] = [];
    for (let i = 0; i < SOFT_CAP_COLLAPSE_BATCH; i++) {
      const id = `protected-${i.toString().padStart(4, '0')}`;
      protectedIds.push(id);
      seedUnreadRow(fakeDb, {
        id,
        created_at: 100 + i,
        severity: i % 2 === 0 ? 'error' : 'critical',
      });
    }
    for (let i = 0; i < SOFT_CAP_PER_KIND_WS - SOFT_CAP_COLLAPSE_BATCH + 1; i++) {
      seedUnreadRow(fakeDb, {
        id: `eligible-${i.toString().padStart(4, '0')}`,
        created_at: 1_000 + i,
        severity: 'info',
      });
    }

    const mgr = makeManager();
    now = 3_000_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'trigger',
      dedupKey: 'dk-protected-trigger',
    });

    expect(
      protectedIds.filter((id) => fakeDb.rows.some((row) => row.id === id)),
    ).toEqual(protectedIds);
  });

  it('collapses a legacy unknown severity through the normalized info lane', () => {
    seedUnreadRow(fakeDb, {
      id: 'legacy-unknown',
      created_at: 1,
      severity: 'fatal' as NotificationSeverity,
    });
    for (let i = 0; i < SOFT_CAP_PER_KIND_WS; i++) {
      seedUnreadRow(fakeDb, {
        id: `protected-${i}`,
        created_at: 100 + i,
        severity: 'error',
      });
    }

    const mgr = makeManager();
    now = 3_000_000;
    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'critical',
      title: 'trigger',
      dedupKey: 'legacy-collapse-trigger',
    });

    expect(fakeDb.rows.find((row) => row.id === 'legacy-unknown')).toBeUndefined();
    expect(fakeDb.rows.filter((row) => row.kind === 'pty-exit-summary')).toHaveLength(1);
  });

  it('emits the soft-cap summary in the added lane', () => {
    for (let i = 0; i < SOFT_CAP_PER_KIND_WS + 1; i++) {
      seedUnreadRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
      });
    }
    const mgr = makeManager();
    now = 3_000_000;

    mgr.add({
      workspaceId: 'ws-1',
      kind: 'pty-exit',
      severity: 'info',
      title: 'trigger',
      dedupKey: 'dk-summary-trigger',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].added.map((row) => row.kind)).toEqual([
      'pty-exit',
      'pty-exit-summary',
    ]);
    expect(emitted[0].removed).toHaveLength(SOFT_CAP_COLLAPSE_BATCH);
  });

  it('rolls back the complete mutation when revision advancement fails', () => {
    for (let i = 0; i < SOFT_CAP_PER_KIND_WS + 1; i++) {
      seedUnreadRow(fakeDb, {
        id: `r-${i.toString().padStart(4, '0')}`,
        created_at: 100 + i,
      });
    }
    const before = fakeDb.rows.map((row) => ({ ...row }));
    fakeDb.failRevisionUpdate = true;
    const mgr = makeManager();
    now = 3_000_000;

    expect(() =>
      mgr.add({
        workspaceId: 'ws-1',
        kind: 'pty-exit',
        severity: 'info',
        title: 'trigger',
        dedupKey: 'dk-rollback-trigger',
      }),
    ).toThrow('forced revision failure');

    expect(fakeDb.rows).toEqual(before);
    expect(fakeDb.revision).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});

describe('NotificationsManager atomic mutations', () => {
  const cases: Array<{
    name: string;
    prepare: (manager: NotificationsManager) => () => unknown;
  }> = [
    {
      name: 'markRead',
      prepare: (manager) => {
        const row = manager.add({
          workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'atomic-read',
        });
        return () => manager.markRead(row.id);
      },
    },
    {
      name: 'markAllRead',
      prepare: (manager) => {
        manager.add({
          workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 'a', dedupKey: 'atomic-all-a',
        });
        manager.add({
          workspaceId: 'ws-1', kind: 'b', severity: 'warn', title: 'b', dedupKey: 'atomic-all-b',
        });
        return () => manager.markAllRead();
      },
    },
    {
      name: 'markUnread',
      prepare: (manager) => {
        const row = manager.add({
          workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'atomic-unread',
        });
        manager.markRead(row.id);
        return () => manager.markUnread(row.id);
      },
    },
    {
      name: 'dismiss',
      prepare: (manager) => {
        const row = manager.add({
          workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'atomic-dismiss',
        });
        return () => manager.dismiss(row.id);
      },
    },
    {
      name: 'clearRead',
      prepare: (manager) => {
        const row = manager.add({
          workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'atomic-clear',
        });
        manager.markRead(row.id);
        return () => manager.clearRead();
      },
    },
    {
      name: 'gc',
      prepare: (manager) => {
        const row = manager.add({
          workspaceId: 'ws-1', kind: 'a', severity: 'info', title: 't', dedupKey: 'atomic-gc',
        });
        manager.markRead(row.id);
        now += READ_TTL_MS + 1;
        return () => manager.gc();
      },
    },
  ];

  it.each(cases)(
    '$name rolls back state when revision advancement fails',
    ({ prepare }) => {
      const manager = makeManager();
      const mutate = prepare(manager);
      const rowsBefore = fakeDb.rows.map((row) => ({ ...row }));
      const revisionBefore = fakeDb.revision;
      emitted.length = 0;
      fakeDb.failRevisionUpdate = true;

      expect(mutate).toThrow('forced revision failure');

      expect(fakeDb.rows).toEqual(rowsBefore);
      expect(fakeDb.revision).toBe(revisionBefore);
      expect(emitted).toHaveLength(0);
    },
  );
});
