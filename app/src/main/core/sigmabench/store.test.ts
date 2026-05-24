// C-12 SigmaBench — store tests (in-memory better-sqlite3 + the 0023 migration).

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as migrate0023 } from '../db/migrations/0023_benchmark_runs';
import { createRun, finishRun, getRun, listRuns } from './store';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate0023(db);
  return db;
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
