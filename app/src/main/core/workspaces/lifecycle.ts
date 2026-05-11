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
    workspaceIds: openWorkspaceIds,
  });
  broadcast(payload);
}

export function getOpenWorkspaceIds(): string[] {
  return [...openWorkspaceIds];
}

export function replaceOpenWorkspaces(workspaceIds: string[]): boolean {
  const next = normalizeWorkspaceIds(workspaceIds);
  if (idsEqual(openWorkspaceIds, next)) return false;
  openWorkspaceIds = next;
  emitOpenWorkspacesChanged();
  return true;
}

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
}
