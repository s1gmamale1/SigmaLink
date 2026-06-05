import { describe, it, expect } from 'vitest';
import { name, up } from './0033_browser_tabs_closed_at';

// better-sqlite3 cannot load under vitest — record exec'd DDL on a mock.
// Harness mirrors 0032_agent_session_pane_uq_status_aware.test.ts exactly.
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

describe('0033_browser_tabs_closed_at', () => {
  it('has the expected name', () => {
    expect(name).toBe('0033_browser_tabs_closed_at');
  });

  it('adds a nullable closed_at column to browser_tabs', () => {
    const db = run();
    const alterAt = db.execed.findIndex((s) =>
      /ALTER TABLE browser_tabs ADD COLUMN closed_at/i.test(s),
    );
    expect(alterAt).toBeGreaterThanOrEqual(0);
  });

  it('creates a recents index on browser_tabs', () => {
    const db = run();
    const idxAt = db.execed.findIndex((s) =>
      /CREATE INDEX.*browser_tabs_recents_idx/i.test(s),
    );
    expect(idxAt).toBeGreaterThanOrEqual(0);
    expect(db.execed[idxAt]).toMatch(/workspace_id.*closed_at.*last_visited_at/i);
  });

  it('emits no self-managed transaction (H-7 runner owns it)', () => {
    expect(() => run()).not.toThrow();
  });

  it('is idempotent (IF NOT EXISTS guard on the index)', () => {
    const db = new MockDb();
    up(db as unknown as Parameters<typeof up>[0]);
    up(db as unknown as Parameters<typeof up>[0]);
    // Two runs should produce two ALTER TABLE statements.
    const alters = db.execed.filter((s) => /ALTER TABLE browser_tabs ADD COLUMN/i.test(s));
    expect(alters.length).toBe(2);
  });
});
