import { describe, it, expect } from 'vitest';
import { name, up } from './0037_agent_sessions_closed_at';

// MockDb answers PRAGMA table_info(agent_sessions) and LEARNS columns from
// exec'd ALTERs (mirrors 0035_agent_sessions_runtime_profile.test.ts) so the
// cross-process re-run guard can be exercised: the second up() sees the column
// the first one added and must skip the ALTER.
class MockDb {
  execed: string[] = [];
  columns = new Set<string>();
  constructor(columns: string[] = []) {
    for (const column of columns) this.columns.add(column);
  }
  prepare(sql: string): { all: () => Array<{ name: string }> } {
    if (/PRAGMA table_info\(agent_sessions\)/i.test(sql)) {
      return { all: () => [...this.columns].map((column) => ({ name: column })) };
    }
    return { all: () => [] };
  }
  exec(sql: string): void {
    const t = sql.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') {
      throw new Error(`migration must not manage its own txn: ${t}`);
    }
    this.execed.push(t.replace(/\s+/g, ' '));
    const addColumn = sql.match(/ADD COLUMN\s+([a-z_]+)/i);
    if (addColumn) this.columns.add(addColumn[1]);
  }
}
function run(): MockDb {
  const db = new MockDb();
  up(db as unknown as Parameters<typeof up>[0]);
  return db;
}

describe('0037_agent_sessions_closed_at', () => {
  it('has the expected name', () => {
    expect(name).toBe('0037_agent_sessions_closed_at');
  });
  it('adds a nullable closed_at column to agent_sessions', () => {
    const db = run();
    const at = db.execed.findIndex((s) =>
      /ALTER TABLE agent_sessions ADD COLUMN closed_at/i.test(s),
    );
    expect(at).toBeGreaterThanOrEqual(0);
  });
  it('creates a recents index keyed on workspace_id, closed_at', () => {
    const db = run();
    const at = db.execed.findIndex((s) =>
      /CREATE INDEX.*agent_sessions_closed_idx/i.test(s),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(db.execed[at]).toMatch(/workspace_id.*closed_at/i);
  });
  it('emits no self-managed transaction (H-7 runner owns it)', () => {
    expect(() => run()).not.toThrow();
  });
  it('is idempotent across a cross-process migrate re-run (no second ALTER)', () => {
    // The MCP memory-server child runs migrate() against the same DB file; a
    // loser that read its `applied` set before the winner committed re-attempts
    // 0037 — the hasColumn guard must turn the second ALTER into a no-op
    // (a bare re-run ALTER would throw `duplicate column name`).
    const db = new MockDb();
    up(db as unknown as Parameters<typeof up>[0]);
    up(db as unknown as Parameters<typeof up>[0]); // PRAGMA now reports closed_at
    const alters = db.execed.filter((s) =>
      /ALTER TABLE agent_sessions ADD COLUMN closed_at/i.test(s),
    );
    expect(alters).toHaveLength(1);
    // The index statement self-guards via IF NOT EXISTS and may repeat.
  });
  it('skips the ALTER when the bootstrap schema already has the column', () => {
    const db = new MockDb(['id', 'closed_at']);
    up(db as unknown as Parameters<typeof up>[0]);
    expect(db.execed.some((s) => /ALTER TABLE/i.test(s))).toBe(false);
    // The self-guarding index is still created (covers column-without-index states).
    expect(
      db.execed.some((s) => /CREATE INDEX.*agent_sessions_closed_idx/i.test(s)),
    ).toBe(true);
  });
});
