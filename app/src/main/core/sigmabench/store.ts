// C-12 SigmaBench — persistence for benchmark runs + per-provider results.
//
// Thin data-access layer over the `benchmark_runs` / `benchmark_results`
// tables (migration 0023). Works directly against a better-sqlite3 handle so
// callers can pass either the production raw DB (`getRawDb()`) or an in-memory
// instance in tests. `changed_files` is stored as a JSON array string and
// parsed back into `string[]` on read.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type BenchRunStatus = 'running' | 'done' | 'error';

export interface BenchResult {
  sessionId: string;
  provider: string;
  changedFiles: string[];
  conflictScore: number | null;
  exitCode: number | null;
}

export interface BenchRun {
  id: string;
  createdAt: number;
  category: string;
  taskPrompt: string;
  status: BenchRunStatus;
  results: BenchResult[];
}

export interface CreateRunInput {
  category: string;
  taskPrompt: string;
  /** One provider per agent — becomes one benchmark_results row each. */
  providers: string[];
}

/** A finished per-agent result the harness hands back to {@link finishRun}. */
export interface FinishResult {
  sessionId: string;
  provider: string;
  changedFiles: string[];
  conflictScore: number | null;
  exitCode: number | null;
}

interface RunRow {
  id: string;
  created_at: number;
  category: string;
  task_prompt: string;
  status: string;
}

interface ResultRow {
  run_id: string;
  session_id: string;
  provider: string;
  changed_files: string;
  conflict_score: number | null;
  exit_code: number | null;
}

function mapResult(row: ResultRow): BenchResult {
  let changedFiles: string[] = [];
  try {
    const parsed = JSON.parse(row.changed_files);
    if (Array.isArray(parsed)) changedFiles = parsed.map(String);
  } catch {
    /* malformed JSON — treat as no changed files */
  }
  return {
    sessionId: row.session_id,
    provider: row.provider,
    changedFiles,
    conflictScore: row.conflict_score,
    exitCode: row.exit_code,
  };
}

function loadResults(db: Database.Database, runId: string): BenchResult[] {
  const rows = db
    .prepare(
      `SELECT run_id, session_id, provider, changed_files, conflict_score, exit_code
         FROM benchmark_results WHERE run_id = ?`,
    )
    .all(runId) as ResultRow[];
  return rows.map(mapResult);
}

/**
 * Insert a `running` run plus one placeholder `benchmark_results` row per
 * provider. The placeholder session id is a fresh UUID; the harness later
 * replaces it (via finishRun) with the agent's real PTY session id. Returns
 * the fully-materialised run so the caller knows each result's session id.
 */
export function createRun(db: Database.Database, input: CreateRunInput): BenchRun {
  const id = randomUUID();
  const createdAt = Date.now();
  const insertRun = db.prepare(
    `INSERT INTO benchmark_runs (id, created_at, category, task_prompt, status)
       VALUES (?, ?, ?, ?, 'running')`,
  );
  const insertResult = db.prepare(
    `INSERT INTO benchmark_results
       (run_id, session_id, provider, changed_files, conflict_score, exit_code)
       VALUES (?, ?, ?, '[]', NULL, NULL)`,
  );

  const tx = db.transaction(() => {
    insertRun.run(id, createdAt, input.category, input.taskPrompt);
    for (const provider of input.providers) {
      // Placeholder session id — replaced when finishRun runs with the
      // harness's real per-agent results.
      insertResult.run(id, randomUUID(), provider);
    }
  });
  tx();

  const run = getRun(db, id);
  if (!run) throw new Error(`createRun: failed to read back run ${id}`);
  return run;
}

/**
 * Replace the run's result rows with the finished per-agent results and flip
 * the run status (default 'done'). The placeholder rows from createRun are
 * deleted and re-inserted keyed by the agent's real session id so the final
 * table reflects the actual swarm sessions.
 */
export function finishRun(
  db: Database.Database,
  runId: string,
  results: FinishResult[],
  opts: { status?: BenchRunStatus } = {},
): void {
  const status: BenchRunStatus = opts.status ?? 'done';
  const deleteResults = db.prepare('DELETE FROM benchmark_results WHERE run_id = ?');
  const insertResult = db.prepare(
    `INSERT INTO benchmark_results
       (run_id, session_id, provider, changed_files, conflict_score, exit_code)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateStatus = db.prepare('UPDATE benchmark_runs SET status = ? WHERE id = ?');

  const tx = db.transaction(() => {
    deleteResults.run(runId);
    for (const r of results) {
      insertResult.run(
        runId,
        r.sessionId,
        r.provider,
        JSON.stringify(r.changedFiles),
        r.conflictScore,
        r.exitCode,
      );
    }
    updateStatus.run(status, runId);
  });
  tx();
}

/** Read a single run (with its results), or null if the id is unknown. */
export function getRun(db: Database.Database, id: string): BenchRun | null {
  const row = db
    .prepare(
      `SELECT id, created_at, category, task_prompt, status
         FROM benchmark_runs WHERE id = ?`,
    )
    .get(id) as RunRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    category: row.category,
    taskPrompt: row.task_prompt,
    status: row.status as BenchRunStatus,
    results: loadResults(db, row.id),
  };
}

/** List every run, newest first, each with its results. */
export function listRuns(db: Database.Database): BenchRun[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, category, task_prompt, status
         FROM benchmark_runs ORDER BY created_at DESC`,
    )
    .all() as RunRow[];
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    category: row.category,
    taskPrompt: row.task_prompt,
    status: row.status as BenchRunStatus,
    results: loadResults(db, row.id),
  }));
}
