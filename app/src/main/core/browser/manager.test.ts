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

// ─────────────────────────────────────────────────────────────────────────────
// B4 — focusView: forward focus to the embedded WebContentsView
// ─────────────────────────────────────────────────────────────────────────────

describe('BrowserManager — focusView (BSP-B4)', () => {
  it('focusView calls webContents.focus() on the active tab view', async () => {
    const focusMock = vi.fn();
    const now = Date.now();
    dbRows.push({
      id: 'tab-focus',
      workspace_id: 'ws-test',
      url: 'https://example.com',
      title: 'Test',
      active: 1,
      created_at: now,
      last_visited_at: now,
      closed_at: null,
    });

    const manager = makeManager();

    // Manually inject a fake view so we don't need Electron.
    const fakeView = {
      webContents: { focus: focusMock },
      setBounds: vi.fn(),
    } as unknown as import('electron').WebContentsView;

    // Access the internal tab map via cast to any to inject the fake view.
    const tabsMap = (manager as unknown as { tabs: Map<string, { view: unknown }> }).tabs;
    const tabRec = tabsMap.get('tab-focus');
    if (tabRec) tabRec.view = fakeView;

    manager.focusView();

    expect(focusMock).toHaveBeenCalledOnce();
  });

  it('focusView does nothing (no throw) when there is no active tab', () => {
    const manager = makeManager();
    // No tabs loaded — should not throw.
    expect(() => manager.focusView()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2 — detachToWindow / reattach: state transitions (no real Electron windows)
// ─────────────────────────────────────────────────────────────────────────────

describe('BrowserManager — detachToWindow / reattach state (BSP-B2)', () => {
  it('getState().detached is false initially', () => {
    const manager = makeManager();
    expect(manager.getState().detached).toBe(false);
  });

  it('setDetached(true) emits state with detached=true', () => {
    const manager = makeManager();
    const states: import('../../../shared/types').BrowserState[] = [];
    manager.on('state', (s) => states.push(s));

    manager.setDetached(true);

    expect(manager.getState().detached).toBe(true);
    expect(states.length).toBeGreaterThan(0);
    expect(states[states.length - 1].detached).toBe(true);
  });

  it('setDetached(false) reverts state to not detached', () => {
    const manager = makeManager();
    manager.setDetached(true);
    manager.setDetached(false);
    expect(manager.getState().detached).toBe(false);
  });

  // HIGH-bug regression: reattach must target the ORIGINAL main window, NOT
  // `this.window`. The registry calls `setWindow(getFocusedWindow())` on every
  // RPC, so while detached + the detached window focused, `this.window` is
  // stomped to the detached window. Reattaching into `this.window` would put
  // the page back into the closing/wrong window. We assert the view is added
  // back to the main window even after `setWindow(detachedWindow)`.
  it('reattach() adds the view back to the ORIGINAL main window, not the focused detached window', async () => {
    // Fake windows whose contentView records add/removeChildView targets.
    const makeFakeWindow = (label: string) => {
      const added: unknown[] = [];
      const removed: unknown[] = [];
      const win = {
        label,
        isDestroyed: () => false,
        close: vi.fn(),
        contentView: {
          addChildView: (v: unknown) => added.push(v),
          removeChildView: (v: unknown) => removed.push(v),
        },
      };
      return { win, added, removed };
    };

    const mainWin = makeFakeWindow('main');
    const detachedWin = makeFakeWindow('detached');

    // Seed an active tab so reattach() finds a record + view.
    const now = Date.now();
    dbRows.push({
      id: 'tab-reattach',
      workspace_id: 'ws-test',
      url: 'https://example.com',
      title: 'Test',
      active: 1,
      created_at: now,
      last_visited_at: now,
      closed_at: null,
    });

    const manager = new BrowserManager({
      workspaceId: 'ws-test',
      window: mainWin.win as unknown as import('electron').BrowserWindow,
    });

    const fakeView = {
      webContents: { focus: vi.fn() },
      setBounds: vi.fn(),
    } as unknown as import('electron').WebContentsView;

    // Inject the fake view into the active tab record.
    const tabsMap = (manager as unknown as { tabs: Map<string, { view: unknown }> }).tabs;
    const rec = tabsMap.get('tab-reattach');
    if (rec) rec.view = fakeView;

    // Simulate a completed detach WITHOUT running the real `detachToWindow`
    // (which needs a live Electron BrowserWindow). Set the internal fields the
    // way detachToWindow would: capture the main window, set the detached one,
    // and flip the detached flag.
    const internals = manager as unknown as {
      mainWindow: unknown;
      detachedWindow: unknown;
      detachedState: boolean;
    };
    internals.mainWindow = mainWin.win;
    internals.detachedWindow = detachedWin.win;
    internals.detachedState = true;

    // This is the exact path that broke: registry.get() calls
    // setWindow(getFocusedWindow()) and the detached window is focused →
    // `this.window` gets stomped to the detached window. Belt-and-suspenders
    // setWindow() should IGNORE the detached window, but even if it didn't,
    // reattach must still use the captured mainWindow.
    manager.setWindow(detachedWin.win as unknown as import('electron').BrowserWindow);

    await manager.reattach();

    // The view must have been added back to the MAIN window, never the detached.
    expect(mainWin.added).toContain(fakeView);
    expect(detachedWin.added).not.toContain(fakeView);
    // And the detached window must have been closed.
    expect(detachedWin.win.close).toHaveBeenCalled();
    // State flips back to attached.
    expect(manager.getState().detached).toBe(false);
  });

  it('setWindow() ignores the detached window (does not stomp this.window)', () => {
    const manager = makeManager();
    const detachedWin = { isDestroyed: () => false } as unknown as import('electron').BrowserWindow;
    const otherWin = { isDestroyed: () => false } as unknown as import('electron').BrowserWindow;

    // Mark the detached window on the manager.
    (manager as unknown as { detachedWindow: unknown }).detachedWindow = detachedWin;

    // setWindow(detachedWindow) must be a no-op.
    manager.setWindow(detachedWin);
    expect((manager as unknown as { window: unknown }).window).not.toBe(detachedWin);

    // setWindow(otherWindow) still works normally.
    manager.setWindow(otherWin);
    expect((manager as unknown as { window: unknown }).window).toBe(otherWin);
  });
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
