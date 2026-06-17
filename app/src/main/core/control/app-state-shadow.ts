// src/main/core/control/app-state-shadow.ts
//
// Main-side mirror of the few renderer-only "what is the human looking at"
// facts. The renderer echoes changes via rpc.control.reportViewport; get_app_state
// reads this. Stale across process reload — surfaced via viewportStale.

export interface ViewportShadow {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  focusedPaneId: string | null;
  room: string | null;
  activeSwarmId: string | null;
  viewportStale: boolean;
}

export type ViewportPatch = Partial<Omit<ViewportShadow, 'viewportStale'>>;

export interface ViewportShadowHandle {
  get(): ViewportShadow;
  report(patch: ViewportPatch): void;
}

export function createViewportShadow(): ViewportShadowHandle {
  const state: ViewportShadow = {
    activeWorkspaceId: null, activeSessionId: null, focusedPaneId: null,
    room: null, activeSwarmId: null, viewportStale: true,
  };
  return {
    get: () => ({ ...state }),
    report: (patch) => {
      if (patch.activeWorkspaceId !== undefined) state.activeWorkspaceId = patch.activeWorkspaceId;
      if (patch.activeSessionId !== undefined) state.activeSessionId = patch.activeSessionId;
      if (patch.focusedPaneId !== undefined) state.focusedPaneId = patch.focusedPaneId;
      if (patch.room !== undefined) state.room = patch.room;
      if (patch.activeSwarmId !== undefined) state.activeSwarmId = patch.activeSwarmId;
      state.viewportStale = false;
    },
  };
}
