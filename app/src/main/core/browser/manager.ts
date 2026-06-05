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
import { eq, and, isNull, isNotNull, desc } from 'drizzle-orm';
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
  /** BSP-B2 — true while the active tab's view lives in a detached window. */
  private detachedState = false;
  /** BSP-B2 — the secondary BrowserWindow that hosts the detached view. */
  private detachedWindow: BrowserWindow | null = null;
  /**
   * BSP-B2 — the ORIGINAL main window captured at detach time. We must reattach
   * the view to THIS window, not `this.window` — the registry calls
   * `setWindow(getFocusedWindow())` on every RPC, so while detached + the
   * detached window is focused, `this.window` is stomped to the detached
   * window. Reattaching into `this.window` would put the view back into the
   * closing/wrong window. Captured on detach, cleared on reattach + teardown.
   */
  private mainWindow: BrowserWindow | null = null;

  constructor(deps: ManagerDeps) {
    super();
    this.workspaceId = deps.workspaceId;
    this.window = deps.window;
    this.hydrateFromDb();
  }

  // ─────────────────────────────────────────── lifecycle ──

  setWindow(win: BrowserWindow): void {
    // BSP-B2 belt-and-suspenders: the registry calls this with
    // `getFocusedWindow()` on every RPC. While detached, the detached window
    // may be the focused one — never let it overwrite `this.window`, or the
    // main-window reference (and `applyBounds`) would target the wrong window.
    if (this.detachedWindow && win === this.detachedWindow) return;
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
      // DEV-2: exclude soft-deleted (closed) tabs from the active tab set.
      const rows = db
        .select()
        .from(browserTabs)
        .where(and(eq(browserTabs.workspaceId, this.workspaceId), isNull(browserTabs.closedAt)))
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
      // DEV-2: soft-delete — keep the row for Recents; mark with epoch-ms.
      db.update(browserTabs)
        .set({ closedAt: Date.now(), active: 0 })
        .where(eq(browserTabs.id, tabId))
        .run();
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

  /** Most-recent closed tabs for the Recents panel, newest first (DEV-2). */
  listRecents(limit = 30): Array<{ url: string; title: string; lastVisitedAt: number }> {
    try {
      const db = getDb();
      const rows = db
        .select()
        .from(browserTabs)
        .where(
          and(
            eq(browserTabs.workspaceId, this.workspaceId),
            isNotNull(browserTabs.closedAt),
          ),
        )
        .orderBy(desc(browserTabs.lastVisitedAt))
        .limit(limit)
        .all();
      return rows.map((r) => ({ url: r.url, title: r.title, lastVisitedAt: r.lastVisitedAt }));
    } catch {
      return [];
    }
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

  // ─────────────────────────────────────────── focus (BSP-B4) ──

  /**
   * BSP-B4 — Forward keyboard/pointer focus to the active tab's embedded
   * WebContentsView so web form fields (input, textarea, etc.) receive input.
   *
   * Root cause: `ensureView` mounts the view and calls `setBounds`, but never
   * calls `webContents.focus()`. The renderer's React SPA therefore keeps focus,
   * and key/pointer events are eaten before they reach the web page.
   */
  focusView(): void {
    if (!this.activeTabId) return;
    const rec = this.tabs.get(this.activeTabId);
    if (!rec || !rec.view) return;
    try {
      rec.view.webContents.focus();
    } catch {
      /* view may have been destroyed; ignore */
    }
  }

  // ─────────────────────────────────────────── detach (BSP-B2) ──

  /**
   * BSP-B2 — Low-level helper used by tests to drive the detached/attached
   * state flag without creating real Electron windows. The public `detachToWindow`
   * and `reattach` methods manage the real window lifecycle; this drives the
   * shared state + broadcast so tests can assert cleanly.
   */
  setDetached(value: boolean): void {
    this.detachedState = value;
    this.broadcast();
  }

  /**
   * BSP-B2 — Move the active tab's WebContentsView from the main window to a
   * new minimal BrowserWindow so it can live on a second monitor while the
   * user continues working in SigmaLink.
   *
   * The detached window shows a lightweight toolbar HTML (URL display + Back /
   * Forward / Reattach buttons) in a thin top strip. Closing the window
   * automatically reattaches, preserving session continuity.
   */
  async detachToWindow(): Promise<void> {
    if (this.detachedState) return; // already detached
    if (!this.activeTabId) return;
    const rec = this.tabs.get(this.activeTabId);
    if (!rec) return;
    await this.ensureView(rec);

    // BSP-B2 — capture the ORIGINAL main window NOW, before the registry can
    // stomp `this.window` to the detached window (it calls
    // `setWindow(getFocusedWindow())` on every RPC). Reattach targets THIS.
    this.mainWindow = this.window;

    // Lazy-import Electron so unit tests (which stub the module) can run
    // without a real Electron process.
    const { BrowserWindow: ElectronBrowserWindow } = (
      await import('electron')
    ) as typeof import('electron');

    // Build a minimal detached window — frameless with a small top bar for
    // the toolbar HTML, then the WebContentsView fills the rest.
    const detWin = new ElectronBrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 400,
      minHeight: 300,
      title: rec.url || 'SigmaLink Browser',
      // Show native titlebar so the user has OS chrome to drag/resize/close.
      frame: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Remove view from the main window's contentView.
    try {
      this.window.contentView.removeChildView(rec.view);
    } catch {
      /* ignore if already removed */
    }

    // Attach the view to the detached window. Reserve 40px at top for the
    // toolbar; the rest of the window is the page.
    const TOOLBAR_H = 40;
    try {
      detWin.contentView.addChildView(rec.view);
      const [w, h] = detWin.getContentSize();
      rec.view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(1, h - TOOLBAR_H) });
    } catch {
      /* ignore layout errors */
    }

    // Load a minimal toolbar HTML into the window's webContents.
    // The toolbar posts messages back via contextBridge/IPC for back/fwd/reattach.
    const toolbarHtml = buildDetachedToolbarHtml(rec.url || '');
    try {
      await detWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toolbarHtml)}`);
    } catch {
      /* non-fatal — the page is still usable without the toolbar overlay */
    }

    // Keep the toolbar pinned at the top when the user resizes the window.
    detWin.on('resize', () => {
      try {
        const [w, h] = detWin.getContentSize();
        rec.view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(1, h - TOOLBAR_H) });
      } catch {
        /* ignore */
      }
    });

    // Reattach automatically when the user closes the detached window. We do
    // NOT null `this.detachedWindow` here — `_reattachView` reads it (and skips
    // closing it since the window is already gone), then clears it itself.
    detWin.on('closed', () => {
      if (this.detachedState) {
        void this._reattachView(rec);
      }
    });

    // Update the window title whenever the page navigates.
    rec.view.webContents.on('page-title-updated', (_e, title) => {
      try { detWin.setTitle(title || 'SigmaLink Browser'); } catch { /* ignore */ }
    });

    this.detachedWindow = detWin;
    this.setDetached(true);
  }

  /**
   * BSP-B2 — Move the detached WebContentsView back to the main window and
   * close the secondary BrowserWindow.
   */
  async reattach(): Promise<void> {
    if (!this.detachedState) return;
    if (!this.activeTabId) return;
    const rec = this.tabs.get(this.activeTabId);
    if (!rec) return;
    await this._reattachView(rec);
  }

  /** Shared logic for both explicit reattach and close-window auto-reattach. */
  private async _reattachView(rec: { view: TWebContentsView }): Promise<void> {
    const detWin = this.detachedWindow;
    // BSP-B2 — resolve the ORIGINAL main window. NEVER use `this.window`: the
    // registry stomps it to the focused window (possibly the detached one) on
    // every RPC. `this.mainWindow` was captured at detach time. If it's gone
    // (closed/destroyed), fall back to `this.window` only when that isn't the
    // detached window.
    let target: BrowserWindow | null = null;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      target = this.mainWindow;
    } else if (this.window !== detWin) {
      target = this.window;
    }

    if (rec.view) {
      try { detWin?.contentView.removeChildView(rec.view); } catch { /* ignore */ }
      try { target?.contentView.addChildView(rec.view); } catch { /* ignore */ }
    }
    if (detWin && !detWin.isDestroyed()) {
      try { detWin.close(); } catch { /* ignore */ }
    }
    // Restore the main window as the manager's active window so subsequent
    // `applyBounds()` targets it (the registry may have left `this.window`
    // pointing at the now-closed detached window).
    if (target) this.window = target;
    this.detachedWindow = null;
    this.mainWindow = null;
    this.setDetached(false);
    // Re-apply the last known bounds so the view re-appears in the right place.
    this.applyBounds();
  }

  // ─────────────────────────────────────────── state ──

  getState(): BrowserState {
    return {
      workspaceId: this.workspaceId,
      tabs: this.listTabs(),
      activeTabId: this.activeTabId,
      lockOwner: this.lockOwner,
      mcpUrl: null,
      detached: this.detachedState,
    };
  }

  teardown(): void {
    // Close any detached window before tearing down.
    if (this.detachedWindow && !this.detachedWindow.isDestroyed()) {
      try { this.detachedWindow.close(); } catch { /* ignore */ }
    }
    this.detachedWindow = null;
    this.mainWindow = null;
    this.detachedState = false;
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

// ─────────────────────────────────────────── detached toolbar ──

/**
 * BSP-B2 — Build the minimal toolbar HTML that loads into the detached
 * window's main webContents (the top 40px strip). The toolbar shows the
 * current URL and a working Reattach button.
 *
 * NOTE: No back/forward buttons. `history.back()/forward()` here would run in
 * THIS toolbar's webContents (the data-URL strip) — which has no navigation
 * history — not the page's WebContentsView, so they'd be silent no-ops. Wiring
 * real back/forward needs a preload + IPC bridge on the detached window (out of
 * scope for B2). Page navigation is via the page's own UI / keyboard shortcuts.
 *
 * Design: apple-design, frontend-design — translucent dark bar on a near-black
 * background matching SigmaLink's glass aesthetic. The "Reattach" button calls
 * `window.close()`, which triggers the `closed` event on the BrowserWindow →
 * automatic reattach in `BrowserManager`.
 */
function buildDetachedToolbarHtml(currentUrl: string): string {
  const safeUrl = currentUrl
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    height: 40px; overflow: hidden;
    background: rgba(12,12,14,0.92);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
    -webkit-app-region: drag;
    user-select: none;
  }
  .bar {
    display: flex; align-items: center;
    gap: 6px; padding: 0 12px; height: 40px;
  }
  button {
    -webkit-app-region: no-drag;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: rgba(255,255,255,0.85);
    font-size: 11px; line-height: 1;
    padding: 4px 8px; cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: rgba(255,255,255,0.15); }
  .url {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 11px; color: rgba(255,255,255,0.5);
    padding: 0 6px;
  }
  .reattach {
    background: rgba(185,102,245,0.2);
    border-color: rgba(185,102,245,0.3);
    color: rgba(185,102,245,1);
  }
  .reattach:hover { background: rgba(185,102,245,0.35); }
</style>
</head>
<body>
<div class="bar">
  <span class="url" title="${safeUrl}">${safeUrl}</span>
  <button class="reattach" onclick="window.close()" title="Reattach to SigmaLink">Reattach</button>
</div>
</body>
</html>`;
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
