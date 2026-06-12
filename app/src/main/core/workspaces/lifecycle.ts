// v1.1.3 Step 2 — runtime-open workspace lifecycle.
//
// The database stores every persisted workspace. This module tracks the
// process-local subset that is currently open in the app UI and broadcasts the
// ordered id list whenever it changes.

import { BrowserWindow, ipcMain } from 'electron';
import { isAllowedEvent } from '../../../shared/rpc-channels';
import {
  OpenWorkspacesChangedEventSchema,
  type OpenWorkspacesChangedEvent,
} from '../rpc/schemas';

const EVENT_NAME = 'app:open-workspaces-changed';

let openWorkspaceIds: string[] = [];
let ipcInstalled = false;

// Multi-window A4 — detached workspaces live in secondary windows; the main
// renderer's echo legitimately omits them. The registry is the source of
// truth for "detached"; inject as a provider to keep this module pure.
let detachedIdsProvider: (() => string[]) | null = null;

export function setDetachedWorkspaceIdsProvider(provider: (() => string[]) | null): void {
  detachedIdsProvider = provider;
}

function unionWithDetached(ids: string[]): string[] {
  // Best-effort: this runs inside IPC handlers — a throwing provider must not
  // take down the lifecycle; degrade to the raw echoed list.
  let detached: string[] = [];
  try {
    detached = detachedIdsProvider?.() ?? [];
  } catch {
    detached = [];
  }
  if (detached.length === 0) return [...ids];
  const seen = new Set(ids);
  return [...ids, ...detached.filter((id) => id && !seen.has(id))];
}

function normalizeWorkspaceIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

function idsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function broadcast(payload: OpenWorkspacesChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(EVENT_NAME, payload);
  }
}

function emitOpenWorkspacesChanged(): void {
  if (!isAllowedEvent(EVENT_NAME)) return;
  const payload = OpenWorkspacesChangedEventSchema.parse({
    workspaceIds: unionWithDetached(openWorkspaceIds),
  });
  broadcast(payload);
}

export function getOpenWorkspaceIds(): string[] {
  return unionWithDetached(openWorkspaceIds);
}

/** Re-broadcast the open-list union; call after any registry-side detached-set
 *  change (the replaceOpenWorkspaces short-circuit only diffs the RAW echoed list). */
export function refreshOpenWorkspaces(): void {
  emitOpenWorkspacesChanged();
}

export function replaceOpenWorkspaces(workspaceIds: string[]): boolean {
  const next = normalizeWorkspaceIds(workspaceIds);
  if (idsEqual(openWorkspaceIds, next)) return false;
  openWorkspaceIds = next;
  emitOpenWorkspacesChanged();
  return true;
}

// Multi-window continuity rule (A4): any path that moves a workspace BACK to
// the main window must call markWorkspaceOpened(workspaceId) BEFORE the
// registry stops reporting it detached — otherwise the union transiently
// drops it and the main window's SYNC never re-adds it.
export function markWorkspaceOpened(workspaceId: string): void {
  replaceOpenWorkspaces([workspaceId, ...openWorkspaceIds.filter((id) => id !== workspaceId)]);
}

export function markWorkspaceClosed(workspaceId: string): void {
  replaceOpenWorkspaces(openWorkspaceIds.filter((id) => id !== workspaceId));
}

export function installWorkspaceLifecycleIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  ipcMain.on(EVENT_NAME, (_event, payload: unknown) => {
    if (!isAllowedEvent(EVENT_NAME)) return;
    const parsed = OpenWorkspacesChangedEventSchema.safeParse(payload);
    if (!parsed.success) return;
    replaceOpenWorkspaces(parsed.data.workspaceIds);
  });
}

export function __resetWorkspaceLifecycleForTests(): void {
  openWorkspaceIds = [];
  ipcInstalled = false;
  detachedIdsProvider = null;
}
