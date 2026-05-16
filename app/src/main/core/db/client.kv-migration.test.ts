// Tests for the v1.4.1 bridge → sigma kv key migration logic embedded in
// initializeDatabase (client.ts). Because better-sqlite3 is compiled for the
// Electron runtime (not the host Node.js), these tests use a hand-rolled
// in-memory sqlite fake — the same pattern as 0014_sigma_pane_events.test.ts
// and 0015_agent_session_sigma_monitor.test.ts.
//
// runKvMigrations below is a faithful transcription of the two try/catch blocks
// in client.ts. Any change to the production logic must be mirrored here so
// the tests remain a meaningful guard.

import { describe, expect, it } from 'vitest';

// ── Minimal sqlite fake ──────────────────────────────────────────────────────
// Supports the exact SQL shapes the kv migration uses:
//   SELECT value FROM kv WHERE key = '<literal>'
//   SELECT 1     FROM kv WHERE key = '<literal>'
//   INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
//   DELETE FROM kv WHERE key = '<literal>'
//
// The table may be "absent" (throws on any prepare) to simulate the
// boot-safety scenario where the kv table does not exist on very old schemas.

type KvRow = { key: string; value: string; updated_at: number };

const SELECT_VALUE_RE = /^SELECT value FROM kv WHERE key = '([^']+)'$/i;
const SELECT_ONE_RE = /^SELECT 1 FROM kv WHERE key = '([^']+)'$/i;
const INSERT_KV_RE =
  /^INSERT INTO kv \(key, value, updated_at\) VALUES \(\?, \?, \?\)$/i;
const DELETE_KV_RE = /^DELETE FROM kv WHERE key = '([^']+)'$/i;

interface Statement {
  run: (...params: unknown[]) => void;
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
}

class KvFakeSqlite {
  private rows: KvRow[] = [];
  private _broken = false;

  /** Simulate a missing kv table — all prepare() calls will throw. */
  breakTable(): void {
    this._broken = true;
  }

  seed(key: string, value: string): void {
    const existing = this.rows.find((r) => r.key === key);
    if (existing) {
      existing.value = value;
    } else {
      this.rows.push({ key, value, updated_at: Date.now() });
    }
  }

  has(key: string): boolean {
    return this.rows.some((r) => r.key === key);
  }

  get(key: string): string | undefined {
    return this.rows.find((r) => r.key === key)?.value;
  }

  /** Row count for a given key (used to assert no duplication). */
  count(key: string): number {
    return this.rows.filter((r) => r.key === key).length;
  }

  prepare(sql: string): Statement {
    if (this._broken) throw new Error('no such table: kv');

    const trimmed = sql.trim();

    // SELECT value FROM kv WHERE key = '<literal>'
    const selValue = SELECT_VALUE_RE.exec(trimmed);
    if (selValue) {
      const targetKey = selValue[1];
      return {
        get: () => {
          const row = this.rows.find((r) => r.key === targetKey);
          return row ? { value: row.value } : undefined;
        },
        run: () => { throw new Error('run on SELECT'); },
      };
    }

    // SELECT 1 FROM kv WHERE key = '<literal>'
    const selOne = SELECT_ONE_RE.exec(trimmed);
    if (selOne) {
      const targetKey = selOne[1];
      return {
        get: () => {
          const row = this.rows.find((r) => r.key === targetKey);
          return row ? { 1: 1 } : undefined;
        },
        run: () => { throw new Error('run on SELECT'); },
      };
    }

    // INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    if (INSERT_KV_RE.test(trimmed)) {
      return {
        get: () => { throw new Error('get on INSERT'); },
        run: (...params) => {
          const [key, value, updated_at] = params as [string, string, number];
          // Only insert if key absent (production code checks before inserting,
          // but the fake enforces the contract too).
          if (!this.rows.some((r) => r.key === key)) {
            this.rows.push({ key, value, updated_at });
          }
        },
      };
    }

    // DELETE FROM kv WHERE key = '<literal>'
    const del = DELETE_KV_RE.exec(trimmed);
    if (del) {
      const targetKey = del[1];
      return {
        get: () => { throw new Error('get on DELETE'); },
        run: () => {
          this.rows = this.rows.filter((r) => r.key !== targetKey);
        },
      };
    }

    throw new Error(`KvFakeSqlite: unhandled SQL: ${sql}`);
  }
}

// ── Migration under test ─────────────────────────────────────────────────────
// Faithful copy of the two try/catch blocks in client.ts initializeDatabase.
// If client.ts changes, update this too.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runKvMigrations(sqlite: any): void {
  // v1.4.1 — bridge.activeConversationId → sigma.activeConversationId
  try {
    const oldRow = sqlite
      .prepare("SELECT value FROM kv WHERE key = 'bridge.activeConversationId'")
      .get() as { value: string } | undefined;
    if (oldRow) {
      const newRow = sqlite
        .prepare("SELECT 1 FROM kv WHERE key = 'sigma.activeConversationId'")
        .get() as { value: string } | undefined;
      if (!newRow) {
        sqlite
          .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
          .run('sigma.activeConversationId', oldRow.value, Date.now());
      }
      sqlite
        .prepare("DELETE FROM kv WHERE key = 'bridge.activeConversationId'")
        .run();
    }
  } catch {
    /* kv table may not exist on very old schemas — ignore */
  }

  // v1.4.1 — bridge.autoFocusOnDispatch → sigma.autoFocusOnDispatch
  try {
    const oldAutoFocusRow = sqlite
      .prepare("SELECT value FROM kv WHERE key = 'bridge.autoFocusOnDispatch'")
      .get() as { value: string } | undefined;
    if (oldAutoFocusRow) {
      const newAutoFocusRow = sqlite
        .prepare("SELECT 1 FROM kv WHERE key = 'sigma.autoFocusOnDispatch'")
        .get() as { value: string } | undefined;
      if (!newAutoFocusRow) {
        sqlite
          .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
          .run('sigma.autoFocusOnDispatch', oldAutoFocusRow.value, Date.now());
      }
      sqlite
        .prepare("DELETE FROM kv WHERE key = 'bridge.autoFocusOnDispatch'")
        .run();
    }
  } catch {
    /* kv table may not exist on very old schemas — ignore */
  }
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('runKvMigrations', () => {
  it('happy path — both old keys present, neither new key present → both migrated, old keys deleted', () => {
    const db = new KvFakeSqlite();
    db.seed('bridge.activeConversationId', 'conv-abc');
    db.seed('bridge.autoFocusOnDispatch', 'true');

    runKvMigrations(db);

    // New keys written with the original values.
    expect(db.get('sigma.activeConversationId')).toBe('conv-abc');
    expect(db.get('sigma.autoFocusOnDispatch')).toBe('true');

    // Old bridge.* keys deleted.
    expect(db.has('bridge.activeConversationId')).toBe(false);
    expect(db.has('bridge.autoFocusOnDispatch')).toBe(false);
  });

  it('idempotent re-run — sigma.* already present → no overwrite, bridge.* keys deleted', () => {
    const db = new KvFakeSqlite();
    db.seed('bridge.activeConversationId', 'conv-old');
    db.seed('bridge.autoFocusOnDispatch', 'false');
    // Simulate a previous migration run that already wrote the new keys.
    db.seed('sigma.activeConversationId', 'conv-new');
    db.seed('sigma.autoFocusOnDispatch', 'true');

    runKvMigrations(db);

    // sigma.* values must not be overwritten by the stale bridge.* values.
    expect(db.get('sigma.activeConversationId')).toBe('conv-new');
    expect(db.get('sigma.autoFocusOnDispatch')).toBe('true');

    // Each new key must appear exactly once.
    expect(db.count('sigma.activeConversationId')).toBe(1);
    expect(db.count('sigma.autoFocusOnDispatch')).toBe(1);

    // Old bridge.* keys still get deleted regardless.
    expect(db.has('bridge.activeConversationId')).toBe(false);
    expect(db.has('bridge.autoFocusOnDispatch')).toBe(false);
  });

  it('mixed state — one old key already migrated, one still pending → only pending key migrated', () => {
    const db = new KvFakeSqlite();
    // bridge.activeConversationId is still present; autoFocusOnDispatch already migrated.
    db.seed('bridge.activeConversationId', 'conv-xyz');
    db.seed('sigma.autoFocusOnDispatch', 'true');
    // bridge.autoFocusOnDispatch is gone (already cleaned up by a prior run).

    runKvMigrations(db);

    // The pending key gets migrated.
    expect(db.get('sigma.activeConversationId')).toBe('conv-xyz');
    // The already-migrated sigma key is unchanged.
    expect(db.get('sigma.autoFocusOnDispatch')).toBe('true');
    expect(db.count('sigma.autoFocusOnDispatch')).toBe(1);

    // The old bridge key is deleted; the absent bridge.autoFocusOnDispatch
    // causes no error (the if-guard simply skips the block).
    expect(db.has('bridge.activeConversationId')).toBe(false);
    expect(db.has('bridge.autoFocusOnDispatch')).toBe(false);
  });

  it('fresh install — neither bridge.* key exists → no-op, no errors, no table writes', () => {
    const db = new KvFakeSqlite();
    // Table exists but is empty — fresh install.

    runKvMigrations(db);

    // Nothing written.
    expect(db.has('sigma.activeConversationId')).toBe(false);
    expect(db.has('sigma.autoFocusOnDispatch')).toBe(false);
    expect(db.has('bridge.activeConversationId')).toBe(false);
    expect(db.has('bridge.autoFocusOnDispatch')).toBe(false);
  });

  it('boot safety — kv table missing → runKvMigrations does not throw', () => {
    const db = new KvFakeSqlite();
    db.breakTable(); // simulate missing kv table: all prepare() calls throw

    // The try/catch wrapping in the migration must swallow the table-not-found
    // error; this call must not propagate an exception.
    expect(() => runKvMigrations(db)).not.toThrow();
  });
});
