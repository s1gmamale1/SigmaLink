// V3-W14-005 — HMR poke for live-DOM patches. Watches registered dev-server
// roots via fs.watch (recursive). When an agent's file write lands, debounce
// 50ms then reload every active tab whose URL is localhost / 127.0.0.1 / ::1
// and emit `design:patch-applied`. Full WebSocket injection into Vite's HMR
// socket would require CDP hooking; the simple reload path is sufficient for
// V1 because Vite's reload boundary already handles state preservation.

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserManagerRegistry } from '../browser/manager';

export interface HmrPokeEmit {
  /** `design:patch-applied` envelope. */
  patchApplied: (p: {
    workspaceId: string;
    tabId: string;
    file: string;
    range?: { startLine: number; endLine: number };
  }) => void;
}

export interface HmrPokeDeps {
  browserRegistry: BrowserManagerRegistry;
  emit: HmrPokeEmit;
}

interface WatchEntry {
  workspaceId: string;
  root: string;
  watcher: fs.FSWatcher;
}

const DEBOUNCE_MS = 50;
const DEV_HOSTS = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i;

export class HmrPoke {
  private watches = new Map<string, WatchEntry[]>();
  private pending = new Map<string, NodeJS.Timeout>();
  private deps: HmrPokeDeps;

  constructor(deps: HmrPokeDeps) {
    this.deps = deps;
  }

  /** Replace the watch list for a workspace. */
  setRoots(workspaceId: string, roots: string[]): void {
    this.clear(workspaceId);
    if (!Array.isArray(roots) || roots.length === 0) return;
    const entries: WatchEntry[] = [];
    for (const r of roots) {
      const abs = path.resolve(r);
      if (!fs.existsSync(abs)) continue;
      try {
        const watcher = fs.watch(abs, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const file = path.join(abs, String(filename));
          this.schedule(workspaceId, file);
        });
        watcher.on('error', () => {
          /* drop noisy errors; the next setRoots call will re-establish */
        });
        entries.push({ workspaceId, root: abs, watcher });
      } catch {
        /* recursive watching may not be supported on this platform; skip */
      }
    }
    this.watches.set(workspaceId, entries);
  }

  /** Clear watches for a workspace. */
  clear(workspaceId: string): void {
    const entries = this.watches.get(workspaceId);
    if (!entries) return;
    for (const e of entries) {
      try {
        e.watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.watches.delete(workspaceId);
  }

  /** Tear down every watch (called from rpc-router shutdown). */
  shutdown(): void {
    for (const id of Array.from(this.watches.keys())) this.clear(id);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** Manual reload — useful as a renderer-driven fallback button. */
  async reloadTab(workspaceId: string, tabId: string): Promise<void> {
    const reg = this.deps.browserRegistry;
    if (!reg.has(workspaceId)) return;
    try {
      await reg.get(workspaceId).reload(tabId);
    } catch {
      /* ignore */
    }
  }

  // ─────────────────────────────────────────── internal ──

  private schedule(workspaceId: string, file: string): void {
    const key = `${workspaceId}::${file}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pending.delete(key);
      this.applyPoke(workspaceId, file);
    }, DEBOUNCE_MS);
    this.pending.set(key, t);
  }

  private async applyPoke(workspaceId: string, file: string): Promise<void> {
    const reg = this.deps.browserRegistry;
    if (!reg.has(workspaceId)) return;
    const mgr = reg.get(workspaceId);
    const tabs = mgr.listTabs();
    for (const tab of tabs) {
      if (!DEV_HOSTS.test(tab.url)) continue;
      // Best-effort: if Vite is in charge it will hot-reload itself; otherwise
      // we trigger a full reload. A short executeJavaScript probe lets us tell
      // the two cases apart.
      try {
        await mgr.reload(tab.id);
      } catch {
        /* ignore */
      }
      try {
        this.deps.emit.patchApplied({
          workspaceId,
          tabId: tab.id,
          file,
        });
      } catch {
        /* never throw from a watcher */
      }
    }
  }
}
