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
    // ── COUNT unread ──────────────────────────────────────────────────
    if (s.includes('COUNT(*) as n FROM notifications WHERE read_at IS NULL')) {
      return {
        get: (): { n: number } => ({
          n: this.rows.filter((r) => r.read_at === null).length,
        }),
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
      s.includes("severity = 'info'") &&
      s.includes('read_at IS NULL') &&
      s.includes('ORDER BY created_at ASC') &&
      s.includes('LIMIT ?')
    ) {
      return {
        all: (lim: number): { id: string }[] => {
          const sorted = this.rows
            .filter((r) => r.read_at === null && r.severity === 'info')
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
                r.read_at === null,
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
            .filter((r) => r.workspace_id === null && r.kind === kind && r.read_at === null)
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, lim);
          return sorted.map((r) => ({ id: r.id }));
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
          const sevMatch = s.match(/severity IN \(([^)]+)\)/);
          if (sevMatch) {
            const count = sevMatch[1].split(',').length;
            const sevs = args.slice(pos, pos + count) as NotificationSeverity[];
            pos += count;
            filtered = filtered.filter((r) => sevs.includes(r.severity));
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
});
