// BrowserManager unit tests (DEV-2).
//
// better-sqlite3 cannot load under vitest (Electron ABI). We use a MockDb that
// captures SQL mutations and returns canned data for SELECT calls. The approach
// mirrors the nearest existing tests in db/migrations/.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Electron — BrowserManager imports `electron` lazily inside ensureView,
// but the constructor doesn't. We still need to stub `getDb` and Drizzle.
// ─────────────────────────────────────────────────────────────────────────────

// Rows stored by the MockDb.
interface TabRow {
  id: string;
  workspace_id: string;
  url: string;
  title: string;
  active: number;
  created_at: number;
  last_visited_at: number;
  closed_at: number | null;
}

let dbRows: TabRow[] = [];

// Minimal Drizzle-style fluent-builder result stubs.
const makeDb = () => ({
  select: () => ({
    from: () => ({
      where: () => ({
        all: () => dbRows.map((r) => ({
          id: r.id,
          workspaceId: r.workspace_id,
          url: r.url,
          title: r.title,
          active: r.active,
          createdAt: r.created_at,
          lastVisitedAt: r.last_visited_at,
          closedAt: r.closed_at ?? null,
        })),
        orderBy: () => ({
          limit: () => ({
            all: () => dbRows
              .filter((r) => r.workspace_id === 'ws-test' && r.closed_at !== null)
              .sort((a, b) => b.last_visited_at - a.last_visited_at)
              .slice(0, 30)
              .map((r) => ({
                url: r.url,
                title: r.title,
                lastVisitedAt: r.last_visited_at,
              })),
          }),
        }),
      }),
    }),
  }),
  insert: () => ({
    values: (vals: Record<string, unknown>) => ({
      run: () => {
        dbRows.push({
          id: vals.id as string,
          workspace_id: vals.workspaceId as string,
          url: vals.url as string,
          title: (vals.title as string) || '',
          active: (vals.active as number) ?? 0,
          created_at: (vals.createdAt as number) ?? Date.now(),
          last_visited_at: (vals.lastVisitedAt as number) ?? Date.now(),
          closed_at: null,
        });
      },
    }),
  }),
  update: () => ({
    set: (vals: Record<string, unknown>) => ({
      where: () => ({
        run: () => {
          // Apply updates to all rows (simplified: no WHERE filtering in mock).
          // Drizzle calls set() with camelCase field names.
          for (const r of dbRows) {
            if ('closedAt' in vals) r.closed_at = vals.closedAt as number | null;
            if ('active' in vals) r.active = vals.active as number;
            if ('lastVisitedAt' in vals) r.last_visited_at = vals.lastVisitedAt as number;
          }
        },
      }),
    }),
  }),
  delete: () => ({
    where: () => ({
      run: () => {
        // Hard delete — the old path. If this is still called it means the
        // soft-delete fix was not applied.
        dbRows = dbRows.filter(() => false);
      },
    }),
  }),
});

vi.mock('../db/client', () => ({
  getDb: () => makeDb(),
}));

// Drizzle helpers used by manager.ts — return passthrough objects.
vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...orig,
    eq: (_col: unknown, _val: unknown) => ({ _eq: [_col, _val] }),
    and: (...args: unknown[]) => ({ _and: args }),
    isNull: (_col: unknown) => ({ _isNull: _col }),
    isNotNull: (_col: unknown) => ({ _isNotNull: _col }),
    desc: (_col: unknown) => ({ _desc: _col }),
  };
});

// Stub the schema.
vi.mock('../db/schema', () => ({
  browserTabs: { workspaceId: 'col:workspace_id', id: 'col:id', closedAt: 'col:closed_at' },
}));

// Stub electron — never called in non-UI paths.
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(),
}));

// Stub CDP.
vi.mock('./cdp', () => ({ attachDebugger: vi.fn() }));

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

import { BrowserManager } from './manager';

function makeManager() {
  const fakeWindow = {} as unknown as import('electron').BrowserWindow;
  return new BrowserManager({ workspaceId: 'ws-test', window: fakeWindow });
}

beforeEach(() => {
  dbRows = [];
});

describe('BrowserManager — closeTab soft-delete (DEV-2)', () => {
  it('closeTab soft-deletes (sets closed_at) instead of hard-deleting', async () => {
    // Seed a row directly so hydrateFromDb picks it up.
    const now = Date.now();
    dbRows.push({
      id: 't1',
      workspace_id: 'ws-test',
      url: 'https://example.com',
      title: 'Example',
      active: 1,
      created_at: now,
      last_visited_at: now,
      closed_at: null,
    });

    const manager = makeManager();
    // Manager should have loaded the tab from the mock db.
    expect(manager.listTabs().map((t) => t.id)).toContain('t1');

    await manager.closeTab('t1');

    // The row must still exist with closed_at set.
    const row = dbRows.find((r) => r.id === 't1');
    expect(row).toBeDefined();
    expect(row!.closed_at).not.toBeNull();
    expect(row!.closed_at).toBeGreaterThan(0);

    // listTabs() must NOT include the closed tab.
    expect(manager.listTabs().map((t) => t.id)).not.toContain('t1');
  });

  it('listRecents returns recently-closed tab URLs', async () => {
    const now = Date.now();
    dbRows.push({
      id: 'closed-1',
      workspace_id: 'ws-test',
      url: 'https://example.com/page',
      title: 'Example',
      active: 0,
      created_at: now - 5000,
      last_visited_at: now - 1000,
      closed_at: now - 500, // already closed
    });

    const manager = makeManager();
    const recents = manager.listRecents();
    expect(recents.some((r) => r.url.includes('example.com'))).toBe(true);
  });
});
