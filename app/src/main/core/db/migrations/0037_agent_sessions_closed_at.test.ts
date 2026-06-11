import { describe, it, expect } from 'vitest';
import { name, up } from './0037_agent_sessions_closed_at';

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
});
