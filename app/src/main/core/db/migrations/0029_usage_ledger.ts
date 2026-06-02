// P6 FEAT-3 — per-pane / per-workspace usage & cost ledger.
//
// One row per recorded Claude CLI turn, harvested from the `result` envelope
// (`total_cost_usd` + `usage{}`). Only the in-app Jorvis assistant CLI turn
// path emits machine-readable usage today, so rows are keyed by
// `conversation_id` (the assistant has no agent_sessions row); `session_id` is
// reserved for any future PTY-session source and stays NULL for assistant turns.
//   usage_ledger(
//     id                    TEXT PK,
//     session_id            TEXT,            -- agent_sessions.id (NULL for assistant turns)
//     conversation_id       TEXT,            -- conversations.id (set for assistant turns)
//     provider_id           TEXT NOT NULL,   -- 'claude', etc.
//     model_id              TEXT,            -- model name when reported, else NULL
//     input_tokens          INTEGER NOT NULL DEFAULT 0,
//     output_tokens         INTEGER NOT NULL DEFAULT 0,
//     cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
//     cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
//     total_cost_usd        REAL,            -- USD; NULL when the turn was unpriced
//     recorded_at           INTEGER NOT NULL -- epoch ms
//   )
// Indexes:
//   - (session_id, recorded_at) — the per-pane sessionSummary read-path.
//   - (recorded_at)             — the workspace week-to-date window scan.
//
// H-7: NO db.transaction(), BEGIN, COMMIT, or ROLLBACK here — the migration
// runner (migrate.ts) already wraps each migration's up() in ONE transaction;
// a nested BEGIN throws "cannot start a transaction within a transaction" and
// crashes fresh-DB startup. Each statement below is a plain db.exec. The static
// guard in __tests__/migrate.spec.ts enforces the no-self-BEGIN rule.
//
// Idempotent: CREATE TABLE / CREATE INDEX both use IF NOT EXISTS. The `down`
// is reversible (DROP TABLE) so the migration can be rolled back in tooling.

import type Database from 'better-sqlite3';

export const name = '0029_usage_ledger';

// `db.exec` below is the better-sqlite3 SQL runner — NOT child_process.exec.
export function up(db: Database.Database): void {
  const run = (sql: string) => db.exec(sql);
  run(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id                    TEXT NOT NULL PRIMARY KEY,
      session_id            TEXT,
      conversation_id       TEXT,
      provider_id           TEXT NOT NULL,
      model_id              TEXT,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      total_cost_usd        REAL,
      recorded_at           INTEGER NOT NULL
    )
  `);

  run(`
    CREATE INDEX IF NOT EXISTS usage_ledger_session_idx
      ON usage_ledger(session_id, recorded_at)
  `);

  run(`
    CREATE INDEX IF NOT EXISTS usage_ledger_recorded_idx
      ON usage_ledger(recorded_at)
  `);
}

export function down(db: Database.Database): void {
  const run = (sql: string) => db.exec(sql);
  run(`DROP INDEX IF EXISTS usage_ledger_recorded_idx`);
  run(`DROP INDEX IF EXISTS usage_ledger_session_idx`);
  run(`DROP TABLE IF EXISTS usage_ledger`);
}
