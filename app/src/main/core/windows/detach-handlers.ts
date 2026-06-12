// Multi-window B2 — RPC handler logic, DI'd so rpc-router stays thin and the
// Electron window factory (main.ts) is injectable in tests.

import type { WindowRegistry, WindowHandle } from './registry';

export interface DetachDeps {
  registry: WindowRegistry;
  /** main.ts createSecondaryWindow, adapted to WindowHandle. */
  createSecondaryWindow: (workspaceId: string, workspaceName: string) => WindowHandle;
  /** Resolve a display name (workspaces table). Null = unknown id. */
  getWorkspaceName: (workspaceId: string) => string | null;
}

/**
 * Detach a workspace into its own OS window. Note: accepts ANY workspace row
 * in the DB — detaching a CLOSED workspace opens it scoped to the new window
 * (detach-as-open, mirroring `workspaces.open` semantics); the sidebar only
 * offers the action on open workspaces, but the RPC surface is wider.
 */
export function buildDetachWorkspace(deps: DetachDeps) {
  return async ({ workspaceId }: { workspaceId: string }): Promise<{ windowId: number }> => {
    const existing = deps.registry.ownerWindowIdFor(workspaceId);
    if (existing != null) {
      const win = deps.registry.windowById(existing);
      const isMainOwner = deps.registry.mainWindow()?.id === existing;
      if (win && !isMainOwner) {
        win.focus(); // already detached — jump to it
        return { windowId: existing };
      }
    }
    const name = deps.getWorkspaceName(workspaceId);
    if (!name) throw new Error(`windows.detachWorkspace: unknown workspace ${workspaceId}`);
    const win = deps.createSecondaryWindow(workspaceId, name);
    // factory assigns ownership + broadcasts scopes + refreshes the open list (B1)
    return { windowId: win.id };
  };
}

export function buildRedockWorkspace(deps: {
  registry: WindowRegistry;
  /** lifecycle.ts markWorkspaceOpened — A4 continuity rule (seed BEFORE the
   *  registry stops reporting the workspace detached, or the union drops it). */
  markWorkspaceOpened: (workspaceId: string) => void;
  /** lifecycle.ts refreshOpenWorkspaces — re-broadcast the union (the replace
   *  short-circuit only diffs the RAW echoed list). */
  refreshOpenWorkspaces: () => void;
}) {
  return async ({ workspaceId }: { workspaceId: string }): Promise<void> => {
    const reg = deps.registry;
    const ownerId = reg.ownerWindowIdFor(workspaceId);
    const main = reg.mainWindow();
    if (!main) return;
    if (ownerId == null || ownerId === main.id) return; // already docked / undetached
    // Capture the former owner BEFORE we reassign ownership — afterwards the
    // registry no longer associates it with this workspace.
    const formerOwner = reg.windowById(ownerId);
    deps.markWorkspaceOpened(workspaceId); // BEFORE ownership flips (A4)
    reg.assignWorkspace(workspaceId, main.id);
    reg.broadcastScopes();
    deps.refreshOpenWorkspaces();
    main.focus();
    // Dispose the now-empty secondary window. Its B1 `closed` handler then
    // re-docks everything IT owned — but ownership for this workspace already
    // moved to main, so that window's owned list is empty: the re-dock loops
    // skip and it just re-broadcasts scopes + refreshes the open list (harmless,
    // idempotent). Verified against electron/main.ts createSecondaryWindow's
    // closed handler.
    formerOwner?.close();
  };
}
