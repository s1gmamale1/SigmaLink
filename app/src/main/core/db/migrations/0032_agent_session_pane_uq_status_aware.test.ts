import { describe, it, expect } from 'vitest';
import { name, up } from './0032_agent_session_pane_uq_status_aware';

// better-sqlite3 cannot load under vitest — record exec'd DDL on a mock.
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

describe('0032_agent_session_pane_uq_status_aware', () => {
  it('has the expected name', () => {
    expect(name).toBe('0032_agent_session_pane_uq_status_aware');
  });

  it('drops the old index, then recreates it status-aware', () => {
    const db = run();
    const dropAt = db.execed.findIndex((s) => /DROP INDEX/i.test(s));
    const createAt = db.execed.findIndex((s) => /CREATE UNIQUE INDEX/i.test(s));
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
    expect(db.execed[createAt]).toMatch(
      /agent_sessions_ws_pane_uq.*workspace_id, pane_index.*WHERE pane_index IS NOT NULL AND status IN \('running', 'starting'\)/i,
    );
  });

  it('emits no self-managed transaction (H-7 runner owns it)', () => {
    expect(() => run()).not.toThrow();
  });

  it('is idempotent (IF EXISTS / IF NOT EXISTS) on re-run', () => {
    const db = new MockDb();
    up(db as unknown as Parameters<typeof up>[0]);
    up(db as unknown as Parameters<typeof up>[0]);
    expect(db.execed.filter((s) => /CREATE UNIQUE INDEX/i.test(s)).length).toBe(2);
  });
});
