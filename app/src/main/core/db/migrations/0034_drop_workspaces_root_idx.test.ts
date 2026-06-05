import { describe, it, expect } from 'vitest';
import { name, up } from './0034_drop_workspaces_root_idx';

// better-sqlite3 cannot load under vitest (Electron ABI). Record exec'd DDL on
// a mock. Harness mirrors 0033_browser_tabs_closed_at.test.ts exactly.
class MockDb {
  execed: string[] = [];
  exec(sql: string): void {
    const t = sql.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') {
      throw new Error(`migration must not manage its own txn: ${t}`);
    }
    this.execed.push(t.replace(/\s+/g, ' '));
  }
}

function run(): MockDb {
  const db = new MockDb();
  up(db as unknown as Parameters<typeof up>[0]);
  return db;
}

describe('0034_drop_workspaces_root_idx', () => {
  it('has the expected name', () => {
    expect(name).toBe('0034_drop_workspaces_root_idx');
  });

  it('drops the unique workspaces_root_idx', () => {
    const db = run();
    const dropAt = db.execed.findIndex((s) =>
      /DROP INDEX IF EXISTS workspaces_root_idx/i.test(s),
    );
    expect(dropAt).toBeGreaterThanOrEqual(0);
  });

  it('creates a non-unique workspaces_root_lookup_idx', () => {
    const db = run();
    const createAt = db.execed.findIndex((s) =>
      /CREATE INDEX IF NOT EXISTS workspaces_root_lookup_idx/i.test(s),
    );
    expect(createAt).toBeGreaterThanOrEqual(0);
    // Must NOT be a UNIQUE index.
    expect(db.execed[createAt]).not.toMatch(/UNIQUE/i);
    // Must reference the root_path column.
    expect(db.execed[createAt]).toMatch(/root_path/i);
  });

  it('drops the unique index BEFORE creating the non-unique one', () => {
    const db = run();
    const dropAt = db.execed.findIndex((s) =>
      /DROP INDEX IF EXISTS workspaces_root_idx/i.test(s),
    );
    const createAt = db.execed.findIndex((s) =>
      /CREATE INDEX IF NOT EXISTS workspaces_root_lookup_idx/i.test(s),
    );
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
  });

  it('emits no self-managed transaction (H-7 runner owns it)', () => {
    expect(() => run()).not.toThrow();
  });

  it('is idempotent — IF NOT EXISTS / IF EXISTS guards make two runs safe', () => {
    const db = new MockDb();
    // First run.
    up(db as unknown as Parameters<typeof up>[0]);
    // Second run — should NOT throw even though the unique index is already gone
    // and the non-unique index already exists.
    expect(() => up(db as unknown as Parameters<typeof up>[0])).not.toThrow();
    // Two runs: two DROP + two CREATE statements.
    const drops = db.execed.filter((s) => /DROP INDEX IF EXISTS workspaces_root_idx/i.test(s));
    const creates = db.execed.filter((s) =>
      /CREATE INDEX IF NOT EXISTS workspaces_root_lookup_idx/i.test(s),
    );
    expect(drops).toHaveLength(2);
    expect(creates).toHaveLength(2);
  });

  it('does not include BEGIN/COMMIT/ROLLBACK in emitted SQL', () => {
    const db = run();
    for (const sql of db.execed) {
      expect(sql).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK)$/i);
    }
  });
});
