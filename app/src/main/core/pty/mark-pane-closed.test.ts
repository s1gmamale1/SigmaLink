import { describe, it, expect } from 'vitest';
import { markPaneClosed } from './mark-pane-closed';

class MockStmt {
  sql: string;
  private sink: Array<{ sql: string; args: unknown[] }>;
  constructor(sql: string, sink: Array<{ sql: string; args: unknown[] }>) {
    this.sql = sql;
    this.sink = sink;
  }
  run(...args: unknown[]): void {
    this.sink.push({ sql: this.sql.replace(/\s+/g, ' ').trim(), args });
  }
}
class MockDb {
  calls: Array<{ sql: string; args: unknown[] }> = [];
  prepare(sql: string): MockStmt {
    return new MockStmt(sql, this.calls);
  }
}

describe('markPaneClosed', () => {
  it('writes closed_at only when still NULL (idempotent), keyed by id', () => {
    const db = new MockDb();
    markPaneClosed(db as never, 'sess-1', 1234);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toBe(
      'UPDATE agent_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL',
    );
    expect(db.calls[0].args).toEqual([1234, 'sess-1']);
  });
});
