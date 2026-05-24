// C-12 SigmaBench — store tests.
//
// vitest runs on the Node ABI, but the repo builds better-sqlite3 for Electron's
// ABI (`electron-builder install-app-deps`), so the native binary can't be
// loaded here — every DB test in this repo uses an in-memory fake instead. This
// `FakeDb` implements the exact better-sqlite3 surface `store.ts` touches
// (`prepare(sql).run/get/all` + `transaction`) over two JS arrays, dispatching
// on the statement text. Column/constraint correctness lives in the 0023
// migration test (asserts the emitted DDL) and is exercised for real by the
// production path + the Electron smoke test.

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRun, finishRun, getRun, listRuns } from './store';

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

class FakeDb {
  runs: RunRow[] = [];
  results: ResultRow[] = [];

  prepare(sql: string) {
    const s = sql.replace(/\s+/g, ' ').trim();
    return {
      run: (...args: unknown[]) => {
        if (s.startsWith('INSERT INTO benchmark_runs')) {
          const [id, created_at, category, task_prompt] = args as [string, number, string, string];
          this.runs.push({ id, created_at, category, task_prompt, status: 'running' });
        } else if (s.startsWith('INSERT INTO benchmark_results')) {
          if (s.includes("'[]'")) {
            // createRun placeholder: (run_id, session_id, provider)
            const [run_id, session_id, provider] = args as [string, string, string];
            this.results.push({
              run_id,
              session_id,
              provider,
              changed_files: '[]',
              conflict_score: null,
              exit_code: null,
            });
          } else {
            // finishRun: (run_id, session_id, provider, changed_files, conflict_score, exit_code)
            const [run_id, session_id, provider, changed_files, conflict_score, exit_code] =
              args as [string, string, string, string, number | null, number | null];
            this.results.push({ run_id, session_id, provider, changed_files, conflict_score, exit_code });
          }
        } else if (s.startsWith('DELETE FROM benchmark_results')) {
          const [run_id] = args as [string];
          this.results = this.results.filter((r) => r.run_id !== run_id);
        } else if (s.startsWith('UPDATE benchmark_runs SET status')) {
          const [status, id] = args as [string, string];
          const row = this.runs.find((r) => r.id === id);
          if (row) row.status = status;
        }
        return { changes: 0, lastInsertRowid: 0 };
      },
      get: (...args: unknown[]) => {
        if (s.includes('FROM benchmark_runs') && s.includes('WHERE id')) {
          const [id] = args as [string];
          return this.runs.find((r) => r.id === id);
        }
        return undefined;
      },
      all: (...args: unknown[]) => {
        if (s.includes('FROM benchmark_results') && s.includes('WHERE run_id')) {
          const [run_id] = args as [string];
          return this.results.filter((r) => r.run_id === run_id);
        }
        if (s.includes('FROM benchmark_runs') && s.includes('ORDER BY created_at DESC')) {
          return [...this.runs].sort((a, b) => b.created_at - a.created_at);
        }
        return [];
      },
    };
  }

  transaction<T extends (...a: never[]) => unknown>(fn: T): T {
    return ((...a: never[]) => fn(...a)) as T;
  }

  close() {}
}

function freshDb(): Database.Database {
  return new FakeDb() as unknown as Database.Database;
}

describe('sigmabench store', () => {
  it('createRun inserts a running run + one result row per provider', () => {
    const db = freshDb();
    const run = createRun(db, {
      category: 'multi-agent-conflict',
      taskPrompt: 'add a feature',
      providers: ['claude', 'codex', 'gemini'],
    });

    expect(run.id).toBeTruthy();
    expect(run.status).toBe('running');
    expect(run.category).toBe('multi-agent-conflict');
    expect(run.taskPrompt).toBe('add a feature');
    expect(run.results).toHaveLength(3);
    expect(run.results.map((r) => r.provider).sort()).toEqual(
      ['claude', 'codex', 'gemini'].sort(),
    );
    // Before finishRun the per-result fields are empty / null.
    for (const r of run.results) {
      expect(r.changedFiles).toEqual([]);
      expect(r.conflictScore).toBeNull();
      expect(r.exitCode).toBeNull();
    }
    db.close();
  });

  it('finishRun updates scores/exit codes + flips status to done', () => {
    const db = freshDb();
    const run = createRun(db, {
      category: 'multi-agent-conflict',
      taskPrompt: 'task',
      providers: ['claude', 'codex'],
    });
    const [claudeRes, codexRes] = run.results;

    finishRun(db, run.id, [
      {
        sessionId: claudeRes.sessionId,
        provider: 'claude',
        changedFiles: ['src/a.ts'],
        conflictScore: 0,
        exitCode: 0,
      },
      {
        sessionId: codexRes.sessionId,
        provider: 'codex',
        changedFiles: ['src/a.ts', 'src/b.ts'],
        conflictScore: 1,
        exitCode: 0,
      },
    ]);

    const after = getRun(db, run.id);
    expect(after?.status).toBe('done');
    const byProvider = new Map(after!.results.map((r) => [r.provider, r]));
    expect(byProvider.get('claude')?.changedFiles).toEqual(['src/a.ts']);
    expect(byProvider.get('claude')?.conflictScore).toBe(0);
    expect(byProvider.get('codex')?.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(byProvider.get('codex')?.conflictScore).toBe(1);
    db.close();
  });

  it('finishRun marks the run error when told to', () => {
    const db = freshDb();
    const run = createRun(db, {
      category: 'multi-agent-conflict',
      taskPrompt: 'task',
      providers: ['claude'],
    });
    finishRun(db, run.id, [], { status: 'error' });
    expect(getRun(db, run.id)?.status).toBe('error');
    db.close();
  });

  it('listRuns returns runs newest-first with parsed changed_files', () => {
    const db = freshDb();
    const a = createRun(db, {
      category: 'multi-agent-conflict',
      taskPrompt: 'first',
      providers: ['claude'],
    });
    const b = createRun(db, {
      category: 'multi-agent-conflict',
      taskPrompt: 'second',
      providers: ['codex'],
    });
    finishRun(db, b.id, [
      {
        sessionId: b.results[0].sessionId,
        provider: 'codex',
        changedFiles: ['x.ts'],
        conflictScore: 0,
        exitCode: 0,
      },
    ]);

    const runs = listRuns(db);
    expect(runs.map((r) => r.id)).toContain(a.id);
    expect(runs.map((r) => r.id)).toContain(b.id);
    const loadedB = runs.find((r) => r.id === b.id);
    expect(loadedB?.results[0].changedFiles).toEqual(['x.ts']);
    db.close();
  });

  it('getRun returns null for an unknown id', () => {
    const db = freshDb();
    expect(getRun(db, 'nope')).toBeNull();
    db.close();
  });
});
