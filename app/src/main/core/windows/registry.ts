// Multi-window topology source of truth (design: WISHLIST [windows/UX], 2026-06-12).
// Owns: windowId → handle, workspaceId → windowId ownership, and the
// sessionId → workspaceId routing cache used to deliver pty:data only to the
// window that owns the session's workspace. Pure-DI: Electron BrowserWindows
// are adapted to WindowHandle at the main.ts boundary so tests inject fakes.
//
// Callers must call forgetSession(sessionId) on session close to evict stale
// routing entries.

import { isAllowedEvent } from '../../../shared/rpc-channels';

export interface WindowHandle {
  readonly id: number;
  isDestroyed(): boolean;
  send(event: string, payload: unknown): void;
  focus(): void;
  /** Multi-window B2 — close the OS window. Used by redock to dispose the now-
   *  empty former-owner secondary window; guarded by isDestroyed in main.ts. */
  close(): void;
}

export interface WindowRegistryDeps {
  /** Resolve a session's workspace (agent_sessions.workspace_id). Null = unknown. */
  lookupSessionWorkspace: (sessionId: string) => string | null;
}

export interface WindowScope {
  windowId: number;
  isMain: boolean;
  workspaceIds: string[];
}

const SCOPE_EVENT = 'app:window-scope-changed';

export class WindowRegistry {
  private readonly windows = new Map<number, { handle: WindowHandle; isMain: boolean }>();
  private readonly ownership = new Map<string, number>(); // workspaceId → windowId
  // cache stores string | null — null = "looked up, no workspace" (scratch shells,
  // pre-INSERT launcher window); negative entries stop per-chunk DB re-queries.
  // A null entry is re-resolved only after forgetSession(sessionId); until then
  // delivery falls back to sendToAll (correct, just broadcast).
  private readonly sessionWorkspace = new Map<string, string | null>();
  private readonly deps: WindowRegistryDeps;

  constructor(deps: WindowRegistryDeps) {
    this.deps = deps;
  }

  /**
   * Register a window. Re-registration with an existing id replaces the
   * handle (idempotent-by-replacement); workspace ownership is untouched.
   */
  registerWindow(handle: WindowHandle, opts: { isMain: boolean }): void {
    this.windows.set(handle.id, { handle, isMain: opts.isMain });
  }

  /** Drop a window; returns the workspaceIds it owned (caller re-docks them). */
  // O(workspaces) — acceptable on window-close; add inverse index if workspace counts grow.
  unregisterWindow(windowId: number): string[] {
    this.windows.delete(windowId);
    const released: string[] = [];
    for (const [wsId, ownerId] of this.ownership) {
      if (ownerId === windowId) released.push(wsId);
    }
    for (const wsId of released) this.ownership.delete(wsId);
    return released;
  }

  assignWorkspace(workspaceId: string, windowId: number): void {
    if (!this.windows.has(windowId)) throw new Error(`WindowRegistry.assignWorkspace: unknown windowId ${windowId}`);
    this.ownership.set(workspaceId, windowId);
  }

  releaseWorkspace(workspaceId: string): void {
    this.ownership.delete(workspaceId);
  }

  ownerWindowIdFor(workspaceId: string): number | null {
    const id = this.ownership.get(workspaceId);
    return id != null && this.windows.has(id) ? id : null;
  }

  mainWindow(): WindowHandle | null {
    for (const { handle, isMain } of this.windows.values()) {
      if (isMain && !handle.isDestroyed()) return handle;
    }
    return null;
  }

  windowById(windowId: number): WindowHandle | null {
    const rec = this.windows.get(windowId);
    return rec && !rec.handle.isDestroyed() ? rec.handle : null;
  }

  sendToAll(event: string, payload: unknown): void {
    for (const { handle } of this.windows.values()) {
      if (!handle.isDestroyed()) handle.send(event, payload);
    }
  }

  /** Routed delivery: owner window, falling back to all (unowned/destroyed). */
  sendToWorkspaceOwner(workspaceId: string, event: string, payload: unknown): void {
    const ownerId = this.ownerWindowIdFor(workspaceId);
    const owner = ownerId != null ? this.windowById(ownerId) : null;
    if (owner) {
      owner.send(event, payload);
      return;
    }
    this.sendToAll(event, payload);
  }

  /** pty:data/pty:exit fast path: cache → DB lookup → fallback broadcast.
   *  Negative results ARE cached (has()-gated) so workspace-less sessions
   *  (scratch shells) don't re-run the DB lookup on every coalescer flush. */
  sendToSessionOwner(sessionId: string, event: string, payload: unknown): void {
    if (!this.sessionWorkspace.has(sessionId)) {
      this.sessionWorkspace.set(sessionId, this.deps.lookupSessionWorkspace(sessionId));
    }
    const wsId = this.sessionWorkspace.get(sessionId) ?? null;
    if (wsId == null) {
      this.sendToAll(event, payload);
      return;
    }
    this.sendToWorkspaceOwner(wsId, event, payload);
  }

  forgetSession(sessionId: string): void {
    this.sessionWorkspace.delete(sessionId);
  }

  // workspaceIds order is ownership-insertion order (Map-stable, not sorted).
  scopes(): WindowScope[] {
    const byWindow = new Map<number, string[]>();
    for (const id of this.windows.keys()) byWindow.set(id, []);
    for (const [wsId, windowId] of this.ownership) {
      byWindow.get(windowId)?.push(wsId);
    }
    return [...this.windows.entries()].map(([windowId, rec]) => ({
      windowId,
      isMain: rec.isMain,
      workspaceIds: byWindow.get(windowId) ?? [],
    }));
  }

  /** Push the full scope table to every window (renderers filter locally). */
  broadcastScopes(): void {
    if (!isAllowedEvent(SCOPE_EVENT)) return;
    this.sendToAll(SCOPE_EVENT, { scopes: this.scopes() });
  }
}

// Process-wide singleton, mirroring lifecycle.ts's module pattern. main.ts
// seeds the real lookup at boot; the default null-lookup keeps unit tests
// of OTHER modules (which import this transitively) inert.
let instance: WindowRegistry | null = null;

export function initWindowRegistry(deps: WindowRegistryDeps): WindowRegistry {
  instance = new WindowRegistry(deps);
  return instance;
}

export function getWindowRegistry(): WindowRegistry {
  if (!instance) instance = new WindowRegistry({ lookupSessionWorkspace: () => null });
  return instance;
}

export function __resetWindowRegistryForTests(): void {
  instance = null;
}
