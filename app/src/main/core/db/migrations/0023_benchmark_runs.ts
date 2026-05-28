// C-12 SigmaBench — benchmark run + per-provider result persistence.
//
// SigmaBench measures the "worktree-swarm = no merge conflicts" thesis: it
// dispatches the SAME task to N providers, each in its own isolated worktree,
// then scores how much each agent's changed-file set overlaps the others.
// A run records the prompt + category; one result row per provider captures
// that provider's changed files (JSON array), its conflict score, and the
// agent's PTY exit code.
//
// Schema:
//   benchmark_runs(
//     id          TEXT PK,
//     created_at  INTEGER NOT NULL,   -- epoch ms
//     category    TEXT NOT NULL,      -- e.g. 'multi-agent-conflict'
//     task_prompt TEXT NOT NULL,      -- the prompt sent to every provider
//     status      TEXT NOT NULL       -- 'running' | 'done' | 'error'
//   )
//   benchmark_results(
//     run_id        TEXT NOT NULL,
//     session_id    TEXT NOT NULL,
//     provider      TEXT NOT NULL,
//     changed_files TEXT NOT NULL,    -- JSON array string
//     conflict_score INTEGER,         -- NULL while the run is still in flight
//     exit_code     INTEGER,          -- NULL until the agent's PTY exits
//     PRIMARY KEY(run_id, session_id)
//   )
//
// Idempotent: CREATE TABLE IF NOT EXISTS for both tables.

import type Database from 'better-sqlite3';

export const name = '0023_benchmark_runs';

// `db.exec` below is the better-sqlite3 SQL runner — NOT child_process.exec.
export function up(db: Database.Database): void {
  const run = (sql: string) => db.exec(sql);
  run(`
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id          TEXT NOT NULL PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      category    TEXT NOT NULL,
      task_prompt TEXT NOT NULL,
      status      TEXT NOT NULL
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS benchmark_results (
      run_id         TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      provider       TEXT NOT NULL,
      changed_files  TEXT NOT NULL,
      conflict_score INTEGER,
      exit_code      INTEGER,
      PRIMARY KEY(run_id, session_id)
    )
  `);
}
