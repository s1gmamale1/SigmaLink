// Per-workspace BrowserManager.
//
// One instance per active workspace (singleton-per-workspace) is held by the
// router. The manager owns:
//   • An `Electron.WebContentsView` per tab.
//   • The active tab id, the list of open tabs, and the SQLite mirror.
//   • A semaphore-style `lockOwner` to surface "agent is driving" in the UI.
//   • A reference to the shared `PlaywrightMcpSupervisor` so we can return
//     the per-workspace MCP url without re-spawning.
//   • The current renderer-supplied bounds — when the user switches away
//     from the Browser room, the renderer sends `bounds=null` and we pop
//     the WebContentsView off the window.
//
// State changes fan out through `emit('state', ...)` which the router wraps
// into the `browser:state` IPC event.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { eq, and } from 'drizzle-orm';
import {
  type BrowserWindow,
  type WebContentsView as TWebContentsView,
} from 'electron';
import { getDb } from '../db/client';
import { browserTabs } from '../db/schema';
import {
  DEFAULT_TAB_URL,
  type Bounds,
  type BrowserState,
  type BrowserTab,
  type LockOwner,
} from './types';
import { attachDebugger } from './cdp';

interface ManagerDeps {
  workspaceId: string;
  window: BrowserWindow;
}

interface TabRecord {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  lastVisitedAt: number;
  view: TWebContentsView;
}

export class BrowserManager extends EventEmitter {
  private readonly workspaceId: string;
  private window: BrowserWindow;

  private readonly tabs = new Map<string, TabRecord>();
  private activeTabId: string | null = null;
  private lockOwner: LockOwner | null = null;
  private bounds: Bounds | null = null;

  constructor(deps: ManagerDeps) {
    super();
    this.workspaceId = deps.workspaceId;
    this.window = deps.window;
    this.hydrateFromDb();
  }

  // ─────────────────────────────────────────── lifecycle ──

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  /**
   * Lazily load persisted tabs from `browser_tabs`. Views are NOT created
   * here — we only build them when the user actually views a tab, so that
   * a workspace with 30 saved tabs doesn't spawn 30 Chromiums on launch.
   */
  private hydrateFromDb(): void {
    try {
      const db = getDb();
      const rows = db
        .select()
        .from(browserTabs)
        .where(eq(browserTabs.workspaceId, this.workspaceId))
        .all();
      for (const r of rows) {
        // Defer view creation until activate.
        this.tabs.set(r.id, {
          id: r.id,
          url: r.url || DEFAULT_TAB_URL,
          title: r.title || '',
          createdAt: r.createdAt,
          lastVisitedAt: r.lastVisitedAt,
          // The `view` is created on demand via `ensureView()`.
          view: null as unknown as TWebContentsView,
        });
        if (r.active === 1) this.activeTabId = r.id;
      }
      // If no active tab was persisted but tabs exist, pick the first.
      if (!this.activeTabId && this.tabs.size > 0) {
        this.activeTabId = this.tabs.keys().next().value ?? null;
      }
    } catch {
      /* db not ready or schema missing — start blank */
    }
  }

  // ─────────────────────────────────────────── tabs ──

  async openTab(url?: string): Promise<BrowserTab> {
    const id = randomUUID();
    const now = Date.now();
    const target = url && url.length > 0 ? url : DEFAULT_TAB_URL;
    const rec: TabRecord = {
      id,
      url: target,
      title: '',
      createdAt: now,
      lastVisitedAt: now,
      view: null as unknown as TWebContentsView,
    };
    this.tabs.set(id, rec);
    this.persistTab(rec, true);
    await this.setActiveTab(id);
    this.broadcast();
    return this.toBrowserTab(rec);
  }

  async closeTab(tabId: string): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec) return;
    this.detachView(rec);
    this.tabs.delete(tabId);
    try {
      const db = getDb();
      db.delete(browserTabs).where(eq(browserTabs.id, tabId)).run();
    } catch {
      /* ignore */
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.keys().next().value ?? null;
      if (this.activeTabId) await this.setActiveTab(this.activeTabId);
    }
    this.broadcast();
  }

  async setActiveTab(tabId: string): Promise<void> {
    if (!this.tabs.has(tabId)) return;
    // Detach current active view, attach the new one.
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prev = this.tabs.get(this.activeTabId);
      if (prev) this.detachView(prev);
    }
    this.activeTabId = tabId;
    const rec = this.tabs.get(tabId)!;
    await this.ensureView(rec);
    this.applyBounds();
    try {
      const db = getDb();
      db.update(browserTabs)
        .set({ active: 0 })
        .where(eq(browserTabs.workspaceId, this.workspaceId))
        .run();
      db.update(browserTabs)
        .set({ active: 1, lastVisitedAt: Date.now() })
        .where(and(eq(browserTabs.workspaceId, this.workspaceId), eq(browserTabs.id, tabId)))
        .run();
    } catch {
      /* ignore */
    }
    this.broadcast();
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec) return;
    await this.ensureView(rec);
    rec.url = url;
    rec.lastVisitedAt = Date.now();
    try {
      await rec.view.webContents.loadURL(url);
    } catch {
      /* surface via state */
    }
    this.persistTab(rec, false);
    this.broadcast();
  }

  async back(tabId: string): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec || !rec.view) return;
    const wc = rec.view.webContents;
    // Electron 30+ exposes navigationHistory; older paths use goBack().
    const nav = (wc as unknown as { navigationHistory?: { goBack: () => void } })
      .navigationHistory;
    try {
      if (nav && typeof nav.goBack === 'function') nav.goBack();
      else (wc as unknown as { goBack: () => void }).goBack();
    } catch {
      /* ignore */
    }
  }

  async forward(tabId: string): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec || !rec.view) return;
    const wc = rec.view.webContents;
    const nav = (wc as unknown as { navigationHistory?: { goForward: () => void } })
      .navigationHistory;
    try {
      if (nav && typeof nav.goForward === 'function') nav.goForward();
      else (wc as unknown as { goForward: () => void }).goForward();
    } catch {
      /* ignore */
    }
  }

  async reload(tabId: string): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec || !rec.view) return;
    try {
      rec.view.webContents.reload();
    } catch {
      /* ignore */
    }
  }

  async stop(tabId: string): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec || !rec.view) return;
    try {
      rec.view.webContents.stop();
    } catch {
      /* ignore */
    }
  }

  listTabs(): BrowserTab[] {
    return Array.from(this.tabs.values()).map((r) => this.toBrowserTab(r));
  }

  getActiveTab(): BrowserTab | null {
    if (!this.activeTabId) return null;
    const rec = this.tabs.get(this.activeTabId);
    return rec ? this.toBrowserTab(rec) : null;
  }

  /**
   * V3-W14-001 — surfaces the underlying `WebContentsView` for a tab so the
   * Design-mode element-picker can inject its overlay script. The view is
   * lazily constructed on first activate; callers are expected to invoke
   * `setActiveTab` before reaching for the view to guarantee it exists.
   */
  async getViewForTab(tabId: string): Promise<TWebContentsView | null> {
    const rec = this.tabs.get(tabId);
    if (!rec) return null;
    if (!rec.view) await this.ensureView(rec);
    return rec.view ?? null;
  }

  // ─────────────────────────────────────────── bounds ──

  setBounds(b: Bounds | null): void {
    this.bounds = b;
    this.applyBounds();
  }

  private applyBounds(): void {
    if (!this.activeTabId) return;
    const rec = this.tabs.get(this.activeTabId);
    if (!rec || !rec.view) return;
    if (!this.bounds) {
      // Hide the view by parking it off-screen — Electron's WebContentsView
      // does not have a setVisible(); zero-sized works for our purposes.
      try {
        rec.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      rec.view.setBounds({
        x: Math.round(this.bounds.x),
        y: Math.round(this.bounds.y),
        width: Math.max(1, Math.round(this.bounds.width)),
        height: Math.max(1, Math.round(this.bounds.height)),
      });
    } catch {
      /* ignore */
    }
  }

  // ─────────────────────────────────────────── lock ──

  claimDriver(agentKey: string, label?: string): void {
    this.lockOwner = { agentKey, claimedAt: Date.now(), label };
    this.broadcast();
    this.emit('lockClaimed', this.lockOwner);
  }

  releaseDriver(): void {
    if (!this.lockOwner) return;
    this.lockOwner = null;
    this.broadcast();
    this.emit('lockReleased');
  }

  // ─────────────────────────────────────────── state ──

  getState(): BrowserState {
    return {
      workspaceId: this.workspaceId,
      tabs: this.listTabs(),
      activeTabId: this.activeTabId,
      lockOwner: this.lockOwner,
      mcpUrl: null,
    };
  }

  teardown(): void {
    for (const rec of this.tabs.values()) this.detachView(rec);
    this.tabs.clear();
    this.activeTabId = null;
    this.lockOwner = null;
    this.bounds = null;

  }

  // ─────────────────────────────────────────── internal ──

  private async ensureView(rec: TabRecord): Promise<void> {
    if (rec.view) return;
    // Lazy import so tests / non-Electron contexts don't blow up.
    const { WebContentsView } = (await import('electron')) as typeof import('electron');
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    rec.view = view;

    const wc = view.webContents;
    wc.on('page-title-updated', (_e, title) => {
      rec.title = title;
      this.persistTab(rec, false);
      this.broadcast();
    });
    wc.on('did-navigate', (_e, url) => {
      rec.url = url;
      rec.lastVisitedAt = Date.now();
      this.persistTab(rec, false);
      this.broadcast();
    });
    wc.on('did-navigate-in-page', (_e, url) => {
      rec.url = url;
      rec.lastVisitedAt = Date.now();
      this.persistTab(rec, false);
      this.broadcast();
    });

    // Best-effort CDP attach so future commands can use it.
    attachDebugger(view);

    // Mount the view on the window's contentView; setBounds is what makes
    // it visible. We attach now and rely on `applyBounds` to size it.
    try {
      this.window.contentView.addChildView(view);
    } catch {
      /* window may have been closed; the manager will be torn down soon */
    }

    try {
      await wc.loadURL(rec.url || DEFAULT_TAB_URL);
    } catch {
      /* ignore — bad URL etc., state will reflect via did-fail-load */
    }
  }

  private detachView(rec: TabRecord): void {
    if (!rec.view) return;
    try {
      this.window.contentView.removeChildView(rec.view);
    } catch {
      /* ignore */
    }
    try {
      // Force release of GPU resources by destroying the contents.
      const wc = rec.view.webContents as unknown as { close?: () => void; destroy?: () => void };
      if (typeof wc.close === 'function') wc.close();
      else if (typeof wc.destroy === 'function') wc.destroy();
    } catch {
      /* ignore */
    }
    rec.view = null as unknown as TWebContentsView;
  }

  private persistTab(rec: TabRecord, isInsert: boolean): void {
    try {
      const db = getDb();
      if (isInsert) {
        db.insert(browserTabs)
          .values({
            id: rec.id,
            workspaceId: this.workspaceId,
            url: rec.url,
            title: rec.title,
            active: 0,
            createdAt: rec.createdAt,
            lastVisitedAt: rec.lastVisitedAt,
          })
          .run();
      } else {
        db.update(browserTabs)
          .set({
            url: rec.url,
            title: rec.title,
            lastVisitedAt: rec.lastVisitedAt,
          })
          .where(eq(browserTabs.id, rec.id))
          .run();
      }
    } catch {
      /* ignore */
    }
  }

  private toBrowserTab(rec: TabRecord): BrowserTab {
    return {
      id: rec.id,
      workspaceId: this.workspaceId,
      url: rec.url,
      title: rec.title,
      active: rec.id === this.activeTabId,
      createdAt: rec.createdAt,
      lastVisitedAt: rec.lastVisitedAt,
    };
  }

  private broadcast(): void {
    this.emit('state', this.getState());
  }
}

// ─────────────────────────────────────────── registry ──

interface RegistryDeps {
  windowProvider: () => BrowserWindow | null;
  onState: (state: BrowserState) => void;
}

export class BrowserManagerRegistry {
  private readonly map = new Map<string, BrowserManager>();
  private readonly deps: RegistryDeps;
  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  get(workspaceId: string): BrowserManager {
    let mgr = this.map.get(workspaceId);
    if (mgr) {
      const win = this.deps.windowProvider();
      if (win) mgr.setWindow(win);
      return mgr;
    }
    const win = this.deps.windowProvider();
    if (!win) throw new Error('No active BrowserWindow for workspace ' + workspaceId);
    mgr = new BrowserManager({
      workspaceId,
      window: win,

    });
    mgr.on('state', this.deps.onState);
    this.map.set(workspaceId, mgr);
    return mgr;
  }

  has(workspaceId: string): boolean {
    return this.map.has(workspaceId);
  }

  teardown(workspaceId: string): void {
    const mgr = this.map.get(workspaceId);
    if (!mgr) return;
    try {
      mgr.teardown();
    } catch {
      /* ignore */
    }
    mgr.removeAllListeners();
    this.map.delete(workspaceId);
  }

  teardownAll(): void {
    for (const id of Array.from(this.map.keys())) this.teardown(id);
  }
}
