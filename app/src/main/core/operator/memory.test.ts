// P2 Task 2 — memory DAO tests. Two halves: CRUD (rememberMemory /
// updateMemory / forgetMemory / listMemories) runs over the shared
// createDbFake() drizzle shim, mirroring missions/dao.test.ts. recallMemories
// is raw SQL (FTS5 MATCH via getRawDb()), so it gets an SQL-shape test that
// records the prepared statement text + bound params — mirrors
// memory/db.test.ts's searchMemoriesFts (PERF-14) coverage: query text
// assertions, bound (never-interpolated) params, and fail-soft-to-[] on a
// throwing prepare/all.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { createDbFake, type DbFake, type DrizzleTable } from '@/test-utils/db-fake';
import { jorvisMemory } from '../db/schema';
import * as memory from './memory';

/**
 * The shared createDbFake() drizzle shim (src/test-utils/db-fake-drizzle.ts)
 * implements select/insert/update but not delete() — extending that shared
 * fake is out of this task's 2-file scope. Patch a minimal delete() onto the
 * fake's drizzle object for THIS test file only: reuse the fake's own
 * (already-correct) eq-predicate matching via select() to find the doomed
 * row(s), then splice them out of the backing store directly.
 */
function patchDelete(fake: DbFake): void {
  const drizzle = fake.drizzle as unknown as {
    delete: (table: DrizzleTable) => { where: (pred?: unknown) => { run: () => void } };
  };
  drizzle.delete = () => ({
    where: (pred?: unknown) => ({
      run: () => {
        const doomed = fake.drizzle
          .select()
          .from(jorvisMemory as unknown as DrizzleTable)
          .where(pred as never)
          .all();
        const doomedIds = new Set(doomed.map((r) => r.id));
        const rows = fake.store.tables.get('jorvis_memory');
        if (!rows) return;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (doomedIds.has(rows[i].id)) rows.splice(i, 1);
        }
      },
    }),
  });
}

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  patchDelete(fake);
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

describe('memory DAO — CRUD (drizzle)', () => {
  it('rememberMemory creates a row with sane defaults', () => {
    const m = memory.rememberMemory({ kind: 'fact', title: 't', body: 'b' });
    expect(m.tags).toEqual([]);
    expect(m.workspaceId).toBeNull();
    expect(m.confidence).toBe(0.7);
    expect(m.lastUsedAt).toBeNull();
    expect(memory.listMemories().map((x) => x.id)).toContain(m.id);
  });

  it('rememberMemory round-trips tags through JSON at the DAO boundary', () => {
    const m = memory.rememberMemory({ kind: 'playbook', title: 't', body: 'b', tags: ['a', 'b'] });
    const reread = memory.listMemories().find((x) => x.id === m.id);
    expect(reread?.tags).toEqual(['a', 'b']);
  });

  it('rememberMemory honors explicit workspaceId + confidence', () => {
    const m = memory.rememberMemory({
      kind: 'preference',
      title: 't',
      body: 'b',
      workspaceId: 'ws-1',
      confidence: 0.3,
    });
    expect(m.workspaceId).toBe('ws-1');
    expect(m.confidence).toBe(0.3);
  });

  it('listMemories filters by kind', () => {
    memory.rememberMemory({ kind: 'fact', title: 'a', body: 'b' });
    memory.rememberMemory({ kind: 'playbook', title: 'c', body: 'd' });
    const facts = memory.listMemories({ kind: 'fact' });
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe('fact');
  });

  it('listMemories respects an explicit limit and sorts most-recently-updated first', () => {
    const a = memory.rememberMemory({ kind: 'fact', title: 'a', body: 'b' });
    memory.rememberMemory({ kind: 'fact', title: 'c', body: 'd' });
    memory.updateMemory(a.id, { title: 'a2' }); // bumps a's updatedAt after the second was created
    const limited = memory.listMemories({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe(a.id);
  });

  it('updateMemory patches provided fields and preserves the rest', () => {
    const m = memory.rememberMemory({ kind: 'fact', title: 'orig', body: 'orig body', tags: ['x'] });
    const updated = memory.updateMemory(m.id, { title: 'renamed', confidence: 0.9 });
    expect(updated.title).toBe('renamed');
    expect(updated.confidence).toBe(0.9);
    expect(updated.body).toBe('orig body');
    expect(updated.tags).toEqual(['x']);
    expect(memory.listMemories().find((x) => x.id === m.id)?.title).toBe('renamed');
  });

  it('updateMemory can replace tags wholesale', () => {
    const m = memory.rememberMemory({ kind: 'fact', title: 't', body: 'b', tags: ['x'] });
    const updated = memory.updateMemory(m.id, { tags: ['y', 'z'] });
    expect(updated.tags).toEqual(['y', 'z']);
  });

  it('updateMemory throws for an unknown id', () => {
    expect(() => memory.updateMemory('nope', { title: 'x' })).toThrowError(/not found/);
  });

  it('forgetMemory hard-deletes the row', () => {
    const m = memory.rememberMemory({ kind: 'fact', title: 't', body: 'b' });
    memory.forgetMemory(m.id);
    expect(memory.listMemories().map((x) => x.id)).not.toContain(m.id);
  });

  it('forgetMemory throws for an unknown id', () => {
    expect(() => memory.forgetMemory('nope')).toThrowError(/not found/);
  });
});

// ── recallMemories — raw SQL FTS5 (SQL-shape tests, mirrors searchMemoriesFts) ──

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function makeRecordingRaw(rows: unknown[]): { raw: { prepare: (sql: string) => unknown }; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const raw = {
    prepare: (sql: string) => ({
      all: (...params: unknown[]) => {
        calls.push({ sql, params });
        return rows;
      },
      run: (...params: unknown[]) => {
        calls.push({ sql, params });
        return { changes: rows.length };
      },
    }),
  };
  return { raw, calls };
}

const RAW_ROW_A = {
  id: 'mem-a',
  kind: 'fact',
  title: 'feat: x-y widget',
  body: 'body about the widget',
  tags: '["x","y"]',
  workspace_id: 'ws-1',
  confidence: 0.8,
  created_at: 100,
  updated_at: 200,
  last_used_at: null,
};

const RAW_ROW_B = { ...RAW_ROW_A, id: 'mem-b', tags: '[]', workspace_id: null };

describe('recallMemories (raw SQL FTS5)', () => {
  beforeEach(() => {
    vi.mocked(getRawDb).mockReset();
  });

  it('returns [] for an empty/whitespace-only query without touching the db', () => {
    expect(memory.recallMemories({ query: '   ' })).toEqual([]);
    expect(getRawDb).not.toHaveBeenCalled();
  });

  it('builds a MATCH + bm25 + LIMIT query and binds the sanitized FTS string (never interpolated)', () => {
    const { raw, calls } = makeRecordingRaw([RAW_ROW_A]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    memory.recallMemories({ query: 'feat: x-y', k: 3 });
    expect(calls).toHaveLength(2); // SELECT + the last_used_at touch UPDATE
    const [select] = calls;
    expect(select.sql).toContain('jorvis_memory_fts');
    expect(select.sql).toContain('MATCH');
    expect(select.sql).toContain('bm25(');
    expect(select.sql).toContain('LIMIT');
    // the raw query text must never be interpolated into the SQL string itself
    expect(select.sql).not.toContain('feat: x-y');
    // whitespace-tokenized + double-quoted so `-`/`:` can't crash MATCH, bound as a param
    expect(select.params[0]).toBe('"feat:" "x-y"');
    expect(select.params[select.params.length - 1]).toBe(3); // k passed through as LIMIT
  });

  it('maps snake_case raw rows into the camelCase JorvisMemory shape, parsing tags JSON', () => {
    const { raw } = makeRecordingRaw([RAW_ROW_A]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    const [hit] = memory.recallMemories({ query: 'widget' });
    expect(hit).toMatchObject({
      id: 'mem-a',
      kind: 'fact',
      title: 'feat: x-y widget',
      body: 'body about the widget',
      tags: ['x', 'y'],
      workspaceId: 'ws-1',
      confidence: 0.8,
      createdAt: 100,
    });
  });

  it('adds an optional kind filter clause + bound param', () => {
    const { raw, calls } = makeRecordingRaw([RAW_ROW_A]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    memory.recallMemories({ query: 'hello', kind: 'playbook' });
    expect(calls[0].sql).toContain('m.kind = ?');
    expect(calls[0].params).toContain('playbook');
  });

  it('adds an optional workspaceId filter — string equals, null means IS NULL', () => {
    const { raw: rawStr, calls: callsStr } = makeRecordingRaw([]);
    vi.mocked(getRawDb).mockReturnValue(rawStr as unknown as ReturnType<typeof getRawDb>);
    memory.recallMemories({ query: 'hello', workspaceId: 'ws-9' });
    expect(callsStr[0].sql).toContain('m.workspace_id = ?');
    expect(callsStr[0].params).toContain('ws-9');

    vi.mocked(getRawDb).mockReset();
    const { raw: rawNull, calls: callsNull } = makeRecordingRaw([]);
    vi.mocked(getRawDb).mockReturnValue(rawNull as unknown as ReturnType<typeof getRawDb>);
    memory.recallMemories({ query: 'hello', workspaceId: null });
    expect(callsNull[0].sql).toContain('m.workspace_id IS NULL');
  });

  it('touches last_used_at for returned ids in one UPDATE ... IN (...)', () => {
    const { raw, calls } = makeRecordingRaw([RAW_ROW_A, RAW_ROW_B]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    const result = memory.recallMemories({ query: 'hello' });
    const [, touch] = calls;
    expect(touch.sql).toContain('UPDATE jorvis_memory');
    expect(touch.sql).toContain('last_used_at');
    expect(touch.sql).toContain('IN (');
    expect(touch.params.slice(1)).toEqual(['mem-a', 'mem-b']);
    expect(result.every((m) => typeof m.lastUsedAt === 'number')).toBe(true);
  });

  it('skips the touch UPDATE when there are no hits', () => {
    const { raw, calls } = makeRecordingRaw([]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    expect(memory.recallMemories({ query: 'hello' })).toEqual([]);
    expect(calls).toHaveLength(1); // SELECT only, no UPDATE
  });

  it('fails soft to [] when prepare throws (a broken FTS index must never throw into a wake)', () => {
    vi.mocked(getRawDb).mockReturnValue({
      prepare: () => {
        throw new Error('no such table: jorvis_memory_fts');
      },
    } as unknown as ReturnType<typeof getRawDb>);
    expect(() => memory.recallMemories({ query: 'hello' })).not.toThrow();
    expect(memory.recallMemories({ query: 'hello' })).toEqual([]);
  });

  it('fails soft to [] when all() throws', () => {
    vi.mocked(getRawDb).mockReturnValue({
      prepare: () => ({
        all: () => {
          throw new Error('fts5: syntax error');
        },
      }),
    } as unknown as ReturnType<typeof getRawDb>);
    expect(memory.recallMemories({ query: 'hello' })).toEqual([]);
  });
});
