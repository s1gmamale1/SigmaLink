// Multi-window (2026-06-12) — typed access to the preload-injected window
// identity. Missing bridge fields (older preload, unit tests) degrade to
// main-window semantics so every existing surface behaves exactly as before.

export interface WindowContext {
  windowId: number | null;
  isMain: boolean;
  workspaceScope: string | null;
}

export function getWindowContext(): WindowContext {
  const raw = (window as unknown as { sigma?: { windowContext?: Partial<WindowContext> } }).sigma?.windowContext;
  const id = raw?.windowId;
  return {
    windowId: typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null,
    isMain: raw?.isMain !== false,
    workspaceScope: typeof raw?.workspaceScope === 'string' && raw.workspaceScope ? raw.workspaceScope : null,
  };
}

export function isMainWindow(): boolean {
  return getWindowContext().isMain;
}

export function getWorkspaceScope(): string | null {
  return getWindowContext().workspaceScope;
}
