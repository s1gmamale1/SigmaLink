// Tests for the BUG-10 frontmatter population + mapping and BUG-12
// case-insensitive backlink resolution in db.ts.
//
// DB CONSTRAINT: better-sqlite3 cannot load under vitest (it is built for
// Electron's ABI), so we NEVER call `new Database()`. Instead we mock
// `../db/client` and feed in a hand-rolled in-memory fake — the same MockDb
// philosophy used by the migration tests (e.g. 0020). The fake models the
// exact drizzle chain calls db.ts makes (select/insert/update/delete inside a
// raw.transaction), holding rows in plain arrays. For backlinks we honour the
// `COLLATE NOCASE` semantics of the WHERE clause so the case-insensitive
// behaviour is observable.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { rowToMemory, upsertMemoryTx, findBacklinks } from './db';
import { memories, memoryLinks, memoryTags } from '../db/schema';

// ── Minimal in-memory fake ────────────────────────────────────────────────────
// Rows are stored per logical table. The drizzle chain methods used by db.ts
// are: select().from(t).where(pred).get()/.all(), insert(t).values(v).run(),
// update(t).set(p).where(pred).run(), delete(t).where(pred).run().
//
// We identify the target table by reference identity against the imported
// schema objects, and translate the drizzle `eq()` / `inArray()` predicate
// objects into JS predicates by walking their query chunks the same way the
// shared db-fake does. For `findBacklinks` we special-case the raw
// `sql\`col = val COLLATE NOCASE\`` predicate so the match is case-insensitive.

type AnyRow = Record<string, unknown>;

function tableKey(table: unknown): 'memories' | 'memory_links' | 'memory_tags' {
  if (table === memories) return 'memories';
  if (table === memoryLinks) return 'memory_links';
  if (table === memoryTags) return 'memory_tags';
  throw new Error('fake: unknown table');
}

// We translate a drizzle predicate (eq / and / inArray / raw COLLATE sql) into a
// JS predicate by flattening its query chunks into a token stream. Probed chunk
// shapes (drizzle-orm v0.x): a Column has `.table`; a bound Param is
// `{ value, encoder }`; a raw interpolated primitive (e.g. the value in a
// `sql\`col = ${val} COLLATE NOCASE\`` template) is a bare string/number; a
// StringChunk has an ARRAY `.value` of literal SQL fragments; a nested SQL has
// `.queryChunks`.

const COLUMN_JS_KEY: Record<string, string> = {
  id: 'id',
  workspace_id: 'workspaceId',
  name: 'name',
  from_memory_id: 'fromMemoryId',
  to_memory_name: 'toMemoryName',
  memory_id: 'memoryId',
};

type Token =
  | { kind: 'col'; jsKey: string }
  | { kind: 'val'; value: unknown }
  | { kind: 'frag'; text: string };

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
    if (Array.isArray(c.queryChunks)) {
      out.push(...tokenize(c.queryChunks as unknown[]));
      continue;
    }
    if (c.table && typeof c.name === 'string') {
      out.push({ kind: 'col', jsKey: COLUMN_JS_KEY[c.name] ?? c.name });
      continue;
    }
    if ('encoder' in c) {
      out.push({ kind: 'val', value: c.value });
      continue;
    }
    if (Array.isArray(c.value)) {
      out.push({ kind: 'frag', text: (c.value as string[]).join('') });
      continue;
    }
  }
  return out;
}

interface Clause {
  jsKey: string;
  values: unknown[]; // 1 value for eq; many for inArray (OR semantics)
  nocase: boolean;
}

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
    // Collect every consecutive value before the next column (eq → 1, inArray → N).
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
    clauses.every((c) => {
      const cell = row[c.jsKey];
      return c.values.some((v) =>
        c.nocase && typeof cell === 'string' && typeof v === 'string'
          ? cell.toLowerCase() === v.toLowerCase()
          : cell === v,
      );
    });
}

class Fake {
  memories: AnyRow[] = [];
  memory_links: AnyRow[] = [];
  memory_tags: AnyRow[] = [];

  private rows(table: unknown): AnyRow[] {
    return this[tableKey(table)];
  }

  // drizzle-like surface ------------------------------------------------------
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
  insert(table: unknown) {
    const data = this.rows(table);
    return { values: (v: AnyRow) => ({ run: () => data.push({ ...v }) }) };
  }
  update(table: unknown) {
    const data = this.rows(table);
    return {
      set: (patch: AnyRow) => {
        const apply = (pred?: unknown): void => {
          const p = predicateFor(pred);
          for (const row of data) if (p(row)) Object.assign(row, patch);
        };
        return { where: (pred?: unknown) => ({ run: () => apply(pred) }), run: () => apply() };
      },
    };
  }
  delete(table: unknown) {
    const key = tableKey(table);
    return {
      where: (pred?: unknown) => ({
        run: () => {
          const p = predicateFor(pred);
          this[key] = this[key].filter((r) => !p(r));
        },
      }),
    };
  }
}

function makeRaw() {
  return { transaction: <T extends (...a: unknown[]) => unknown>(fn: T): T => fn };
}

let fake: Fake;
beforeEach(() => {
  fake = new Fake();
  vi.mocked(getDb).mockReturnValue(fake as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(makeRaw() as unknown as ReturnType<typeof getRawDb>);
});

// ── rowToMemory frontmatter mapping ───────────────────────────────────────────
describe('rowToMemory frontmatter mapping', () => {
  const baseRow = {
    id: 'm1',
    workspaceId: 'ws1',
    name: 'Note',
    body: 'b',
    createdAt: 1,
    updatedAt: 2,
  };

  it('maps stored JSON back into Memory.frontmatter', () => {
    const m = rowToMemory({ ...baseRow, frontmatterJson: '{"title":"T","n":3}' } as never, [], []);
    expect(m.frontmatter).toEqual({ title: 'T', n: 3 });
  });

  it('null frontmatter_json → null', () => {
    const m = rowToMemory({ ...baseRow, frontmatterJson: null } as never, [], []);
    expect(m.frontmatter).toBeNull();
  });

  it('malformed frontmatter_json → null (no throw)', () => {
    const m = rowToMemory({ ...baseRow, frontmatterJson: 'not json {' } as never, [], []);
    expect(m.frontmatter).toBeNull();
  });
});

// ── frontmatter round-trips through insert → rowToMemory ─────────────────────
describe('upsertMemoryTx frontmatter population (BUG-10)', () => {
  it('insert stores parsed frontmatter as JSON and round-trips via rowToMemory', () => {
    const body = '---\ntitle: Hello\npinned: true\naliases: [a, b]\n---\nthe body';
    const { joined } = upsertMemoryTx({ workspaceId: 'ws1', name: 'Note', body, tags: [] });

    expect(joined.row.frontmatterJson).toBe('{"title":"Hello","pinned":true,"aliases":["a","b"]}');
    const mem = rowToMemory(joined.row, joined.tags, joined.links);
    expect(mem.frontmatter).toEqual({ title: 'Hello', pinned: true, aliases: ['a', 'b'] });
  });

  it('insert with no frontmatter block stores NULL', () => {
    const { joined } = upsertMemoryTx({ workspaceId: 'ws1', name: 'Plain', body: 'no fence here', tags: [] });
    expect(joined.row.frontmatterJson).toBeNull();
    expect(rowToMemory(joined.row, joined.tags, joined.links).frontmatter).toBeNull();
  });

  it('update recomputes frontmatter from the new body', () => {
    upsertMemoryTx({ workspaceId: 'ws1', name: 'Note', body: '---\nv: 1\n---\nbody', tags: [] });
    const { joined } = upsertMemoryTx({ workspaceId: 'ws1', name: 'Note', body: '---\nv: 2\n---\nbody2', tags: [] });
    expect(joined.row.frontmatterJson).toBe('{"v":2}');
    expect(fake.memories).toHaveLength(1); // updated in place, not duplicated
  });

  it('update that removes the frontmatter block clears the cache to NULL', () => {
    upsertMemoryTx({ workspaceId: 'ws1', name: 'Note', body: '---\nv: 1\n---\nbody', tags: [] });
    const { joined } = upsertMemoryTx({ workspaceId: 'ws1', name: 'Note', body: 'now plain', tags: [] });
    expect(joined.row.frontmatterJson).toBeNull();
  });
});

// ── BUG-12 case-insensitive backlinks ────────────────────────────────────────
describe('findBacklinks case-insensitivity (BUG-12)', () => {
  beforeEach(() => {
    // Source note "Source" links to "Foo" (as written).
    fake.memories.push(
      { id: 'src', workspaceId: 'ws1', name: 'Source', body: '[[Foo]]', frontmatterJson: null, createdAt: 1, updatedAt: 1 },
    );
    fake.memory_links.push(
      { id: 'l1', fromMemoryId: 'src', toMemoryName: 'Foo', createdAt: 1 },
    );
  });

  it('resolves a differently-cased query name to the stored link', () => {
    const exact = findBacklinks('ws1', 'Foo');
    const lower = findBacklinks('ws1', 'foo');
    const upper = findBacklinks('ws1', 'FOO');
    expect(exact.map((r) => r.row.id)).toEqual(['src']);
    expect(lower.map((r) => r.row.id)).toEqual(['src']);
    expect(upper.map((r) => r.row.id)).toEqual(['src']);
  });

  it('does not match an unrelated name', () => {
    expect(findBacklinks('ws1', 'Bar')).toHaveLength(0);
  });
});
