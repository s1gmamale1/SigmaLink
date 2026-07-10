// P2 Task 3 — durable memory tools (remember / recall / update_memory /
// forget). Same harness as tools.missions.test.ts (vi.mock('../db/client') +
// createDbFake), driven through `findTool(id)!.handler(args, ctx)` so these
// exercise the SAME parse/handler path the assistant CLI uses. `remember` /
// `update_memory` / `forget` ride the real memory DAO's drizzle CRUD
// (mirrors memory.test.ts's patchDelete shim — the shared db-fake doesn't
// implement delete()); `recall` is raw SQL (FTS5), so it gets a recording
// getRawDb fake mirroring memory.test.ts's SQL-shape coverage.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
vi.mock('../browser/cdp', () => ({
  runCDP: vi.fn(),
  attachDebugger: vi.fn(() => true),
  detachDebugger: vi.fn(),
}));
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(async () => ({ sessions: [] })),
}));

import { getDb, getRawDb } from '../db/client';
import { createDbFake, type DbFake, type DrizzleTable } from '@/test-utils/db-fake';
import { jorvisMemory } from '../db/schema';
import { findTool } from './tools';
import type { ToolContext } from './tools';
import * as memoryDao from '../operator/memory';

function makeCtx(extra?: Partial<ToolContext>): ToolContext {
  return {
    pty: { list: () => [] },
    worktreePool: {},
    mailbox: {},
    memory: {},
    tasks: {},
    browserRegistry: {},
    defaultWorkspaceId: 'ws-1',
    userDataDir: '/tmp/sigmalink-test',
    ...extra,
  } as unknown as ToolContext;
}

/**
 * The shared createDbFake() drizzle shim implements select/insert/update but
 * not delete() — mirrors memory.test.ts's patchDelete exactly (test-only,
 * out of the shared fake's 2-file scope).
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

describe('memory tools — remember / update_memory / forget (drizzle CRUD)', () => {
  it('remember persists a memory and returns its id', async () => {
    const out = (await findTool('remember')!.handler(
      { kind: 'fact', title: 'always verify', body: 'never trust ok:true', tags: ['discipline'] },
      makeCtx(),
    )) as { memoryId: string };
    expect(out.memoryId).toBeTruthy();
    const stored = memoryDao.listMemories().find((m) => m.id === out.memoryId);
    expect(stored?.title).toBe('always verify');
    expect(stored?.kind).toBe('fact');
    expect(stored?.tags).toEqual(['discipline']);
  });

  it('remember honors an explicit workspaceId', async () => {
    const out = (await findTool('remember')!.handler(
      { kind: 'preference', title: 't', body: 'b', workspaceId: 'ws-9' },
      makeCtx(),
    )) as { memoryId: string };
    const stored = memoryDao.listMemories().find((m) => m.id === out.memoryId);
    expect(stored?.workspaceId).toBe('ws-9');
  });

  it('update_memory patches fields and returns {ok: true}', async () => {
    const created = memoryDao.rememberMemory({ kind: 'fact', title: 'orig', body: 'orig body' });
    const out = (await findTool('update_memory')!.handler(
      { memoryId: created.id, title: 'renamed', confidence: 0.9 },
      makeCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    const reread = memoryDao.listMemories().find((m) => m.id === created.id);
    expect(reread?.title).toBe('renamed');
    expect(reread?.confidence).toBe(0.9);
    expect(reread?.body).toBe('orig body'); // untouched field preserved
  });

  it('update_memory of an unknown id throws (DAO error propagates)', async () => {
    await expect(
      findTool('update_memory')!.handler({ memoryId: 'nope' }, makeCtx()),
    ).rejects.toThrow(/not found/);
  });

  it('forget deletes the memory and returns {ok: true}', async () => {
    const created = memoryDao.rememberMemory({ kind: 'fact', title: 't', body: 'b' });
    const out = (await findTool('forget')!.handler({ memoryId: created.id }, makeCtx())) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);
    expect(memoryDao.listMemories().map((m) => m.id)).not.toContain(created.id);
  });

  it('forget of an unknown id throws (DAO error propagates, mirrors move_mission_task)', async () => {
    await expect(
      findTool('forget')!.handler({ memoryId: 'nope' }, makeCtx()),
    ).rejects.toThrow(/not found/);
  });
});

// ── recall — raw SQL FTS5 (SQL-shape test, mirrors memory.test.ts) ─────────

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

const RAW_ROW = {
  id: 'mem-a',
  kind: 'playbook',
  title: 'deploy checklist',
  body: 'run the gate before tagging',
  tags: '[]',
  workspace_id: null,
  confidence: 0.7,
  created_at: 100,
  updated_at: 200,
  last_used_at: null,
};

describe('memory tools — recall (raw SQL FTS5)', () => {
  beforeEach(() => {
    vi.mocked(getRawDb).mockReset();
  });

  it('passes k through to the FTS query as the bound LIMIT param', async () => {
    const { raw, calls } = makeRecordingRaw([RAW_ROW]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    await findTool('recall')!.handler({ query: 'deploy checklist', k: 7 }, makeCtx());
    const [select] = calls;
    expect(select.sql).toContain('jorvis_memory_fts');
    expect(select.sql).toContain('MATCH');
    expect(select.params[select.params.length - 1]).toBe(7);
  });

  it('returns {memories: JorvisMemory[]} mapped from the raw rows', async () => {
    const { raw } = makeRecordingRaw([RAW_ROW]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    const out = (await findTool('recall')!.handler({ query: 'deploy' }, makeCtx())) as {
      memories: Array<{ id: string; title: string }>;
    };
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]).toMatchObject({ id: 'mem-a', title: 'deploy checklist' });
  });

  it('passes an optional kind filter through', async () => {
    const { raw, calls } = makeRecordingRaw([]);
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);
    await findTool('recall')!.handler({ query: 'hello', kind: 'postmortem' }, makeCtx());
    expect(calls[0].sql).toContain('m.kind = ?');
    expect(calls[0].params).toContain('postmortem');
  });

  it('degrades to an empty list when the FTS lookup throws (fail-soft, never a tool failure)', async () => {
    vi.mocked(getRawDb).mockReturnValue({
      prepare: () => {
        throw new Error('no such table: jorvis_memory_fts');
      },
    } as unknown as ReturnType<typeof getRawDb>);
    const out = (await findTool('recall')!.handler({ query: 'hello' }, makeCtx())) as {
      memories: unknown[];
    };
    expect(out.memories).toEqual([]);
  });
});
