// P4.2 MEM-7 — tests for MemoryManager.findUnlinkedMentions.
//
// DB CONSTRAINT: better-sqlite3 cannot load under vitest, so we mock
// `../db/client` and feed the same hand-rolled in-memory Fake used by db.test.ts
// (drizzle chain over plain arrays). The manager reads through db.ts
// (getMemoryRowByName / listMemoryRows) and its own in-memory index, so driving
// the Fake exercises the real scan + exclusion logic end-to-end.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
}));

// `requireRoot` falls back to a workspaces lookup when no resolver is provided;
// we always pass resolveWorkspaceRoot so this is never hit. ensureHubSync is
// tolerated-on-failure inside hydrate(), but stub the storage module so the test
// never touches the real filesystem.
vi.mock('./storage', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ensureHubSync: vi.fn() };
});

import { getDb, getRawDb } from '../db/client';
import { MemoryManager } from './manager';
import { memories, memoryLinks, memoryTags } from '../db/schema';

type AnyRow = Record<string, unknown>;

function tableKey(table: unknown): 'memories' | 'memory_links' | 'memory_tags' {
  if (table === memories) return 'memories';
  if (table === memoryLinks) return 'memory_links';
  if (table === memoryTags) return 'memory_tags';
  throw new Error('fake: unknown table');
}

const COLUMN_JS_KEY: Record<string, string> = {
  id: 'id',
  workspace_id: 'workspaceId',
  name: 'name',
  from_memory_id: 'fromMemoryId',
  to_memory_name: 'toMemoryName',
  memory_id: 'memoryId',
};

type Token = { kind: 'col'; jsKey: string } | { kind: 'val'; value: unknown } | { kind: 'frag'; text: string };

function tokenize(chunks: unknown[]): Token[] {
  const out: Token[] = [];
  for (const chunk of chunks) {
    if (chunk == null) continue;
    if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
      out.push({ kind: 'val', value: chunk });
      continue;
    }
    if (typeof chunk !== 'object') continue;
    const c = chunk as AnyRow;
    if (Array.isArray(c.queryChunks)) { out.push(...tokenize(c.queryChunks as unknown[])); continue; }
    if (c.table && typeof c.name === 'string') { out.push({ kind: 'col', jsKey: COLUMN_JS_KEY[c.name] ?? c.name }); continue; }
    if ('encoder' in c) { out.push({ kind: 'val', value: c.value }); continue; }
    if (Array.isArray(c.value)) { out.push({ kind: 'frag', text: (c.value as string[]).join('') }); continue; }
  }
  return out;
}

interface Clause { jsKey: string; values: unknown[]; nocase: boolean }

function predicateFor(pred: unknown): (row: AnyRow) => boolean {
  if (!pred || typeof pred !== 'object') return () => true;
  const chunks = (pred as AnyRow).queryChunks as unknown[] | undefined;
  if (!chunks) return () => true;
  const tokens = tokenize(chunks);
  const nocase = tokens.some((t) => t.kind === 'frag' && /COLLATE\s+NOCASE/i.test(t.text));
  const clauses: Clause[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== 'col') continue;
    const values: unknown[] = [];
    let j = i + 1;
    for (; j < tokens.length && tokens[j].kind !== 'col'; j++) {
      const t = tokens[j];
      if (t.kind === 'val') values.push(t.value);
    }
    if (values.length > 0) clauses.push({ jsKey: tok.jsKey, values, nocase });
    i = j - 1;
  }
  if (clauses.length === 0) return () => true;
  return (row) =>
    clauses.every((c) =>
      c.values.some((v) =>
        c.nocase && typeof row[c.jsKey] === 'string' && typeof v === 'string'
          ? (row[c.jsKey] as string).toLowerCase() === (v as string).toLowerCase()
          : row[c.jsKey] === v,
      ),
    );
}

class Fake {
  memories: AnyRow[] = [];
  memory_links: AnyRow[] = [];
  memory_tags: AnyRow[] = [];
  private rows(table: unknown): AnyRow[] { return this[tableKey(table)]; }
  select() {
    return {
      from: (table: unknown) => {
        const data = this.rows(table);
        const chain = (pred?: unknown) => {
          const p = predicateFor(pred);
          const filtered = data.filter(p);
          return {
            orderBy: () => ({ all: () => filtered.map((r) => ({ ...r })), get: () => filtered[0] }),
            all: () => filtered.map((r) => ({ ...r })),
            get: () => (filtered[0] ? { ...filtered[0] } : undefined),
          };
        };
        return {
          where: (pred?: unknown) => chain(pred),
          orderBy: () => chain(),
          all: () => data.map((r) => ({ ...r })),
          get: () => (data[0] ? { ...data[0] } : undefined),
        };
      },
    };
  }
  insert(table: unknown) { const data = this.rows(table); return { values: (v: AnyRow) => ({ run: () => data.push({ ...v }) }) }; }
  update(table: unknown) {
    const data = this.rows(table);
    return { set: (patch: AnyRow) => {
      const apply = (pred?: unknown): void => { const p = predicateFor(pred); for (const row of data) if (p(row)) Object.assign(row, patch); };
      return { where: (pred?: unknown) => ({ run: () => apply(pred) }), run: () => apply() };
    } };
  }
  delete(table: unknown) {
    const key = tableKey(table);
    return { where: (pred?: unknown) => ({ run: () => { const p = predicateFor(pred); this[key] = this[key].filter((r) => !p(r)); } }) };
  }
}

function makeRaw() { return { transaction: <T extends (...a: unknown[]) => unknown>(fn: T): T => fn }; }

let fake: Fake;
function newManager(): MemoryManager {
  return new MemoryManager({ emit: () => undefined, resolveWorkspaceRoot: () => '/tmp/ws' });
}

beforeEach(() => {
  fake = new Fake();
  vi.mocked(getDb).mockReturnValue(fake as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(makeRaw() as unknown as ReturnType<typeof getRawDb>);
});

function seedNote(o: { id: string; name: string; body: string; aliasesJson?: string | null }): void {
  fake.memories.push({
    id: o.id, workspaceId: 'ws1', name: o.name, body: o.body,
    frontmatterJson: null, aliasesJson: o.aliasesJson ?? null, createdAt: 1, updatedAt: 1,
  });
}
function seedLink(fromId: string, toName: string): void {
  fake.memory_links.push({ id: `l-${fromId}-${toName}`, fromMemoryId: fromId, toMemoryName: toName, createdAt: 1 });
}

describe('MemoryManager.findUnlinkedMentions (MEM-7)', () => {
  it('finds a plain-text mention of the active note name in another body', async () => {
    seedNote({ id: 'tgt', name: 'Alpha', body: 'I am the alpha note.' });
    seedNote({ id: 's1', name: 'Source', body: 'See Alpha for details.' });
    const res = await newManager().findUnlinkedMentions({ workspaceId: 'ws1', name: 'Alpha' });
    expect(res).toHaveLength(1);
    expect(res[0].sourceId).toBe('s1');
    expect(res[0].sourceName).toBe('Source');
    expect(res[0].excerpt).toContain('Alpha');
  });

  it('excludes notes that already have an explicit [[link]] to the active note', async () => {
    seedNote({ id: 'tgt', name: 'Alpha', body: '' });
    seedNote({ id: 's1', name: 'Linked', body: 'mentions Alpha and links [[Alpha]]' });
    seedLink('s1', 'Alpha'); // already linked → excluded
    const res = await newManager().findUnlinkedMentions({ workspaceId: 'ws1', name: 'Alpha' });
    expect(res).toHaveLength(0);
  });

  it('matches MEM-5 aliases as mention strings', async () => {
    seedNote({ id: 'tgt', name: 'Alpha', body: '', aliasesJson: '["AKA"]' });
    seedNote({ id: 's1', name: 'Source', body: 'we call it AKA here' });
    const res = await newManager().findUnlinkedMentions({ workspaceId: 'ws1', name: 'Alpha' });
    expect(res.map((r) => r.sourceId)).toEqual(['s1']);
  });

  it('excludes a note that links via the alias even though it mentions the alias as text', async () => {
    seedNote({ id: 'tgt', name: 'Alpha', body: '', aliasesJson: '["AKA"]' });
    seedNote({ id: 's1', name: 'Source', body: 'AKA appears and [[AKA]] is linked' });
    seedLink('s1', 'AKA'); // links via the alias → excluded
    const res = await newManager().findUnlinkedMentions({ workspaceId: 'ws1', name: 'Alpha' });
    expect(res).toHaveLength(0);
  });

  it('does not match the name inside a larger word (word-boundary)', async () => {
    seedNote({ id: 'tgt', name: 'API', body: '' });
    seedNote({ id: 's1', name: 'Source', body: 'this is RAPID and APIs but no bare term' });
    // "API" appears inside "RAPID"? no — but inside "APIs" it does as a prefix.
    // Boundary test: "APIs" — char after is 's' (word char) → NOT a whole-word hit.
    const res = await newManager().findUnlinkedMentions({ workspaceId: 'ws1', name: 'API' });
    expect(res).toHaveLength(0);
  });

  it('never self-mentions the active note', async () => {
    seedNote({ id: 'tgt', name: 'Alpha', body: 'Alpha talks about Alpha' });
    const res = await newManager().findUnlinkedMentions({ workspaceId: 'ws1', name: 'Alpha' });
    expect(res).toHaveLength(0);
  });

  it('returns [] when the active note does not exist', async () => {
    seedNote({ id: 's1', name: 'Source', body: 'mentions Ghost' });
    const res = await newManager().findUnlinkedMentions({ workspaceId: 'ws1', name: 'Ghost' });
    expect(res).toEqual([]);
  });
});
