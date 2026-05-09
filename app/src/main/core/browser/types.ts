// Browser Room — main-process domain types.
//
// These types model the per-workspace browser state that the renderer hydrates
// from the `browser:state` event and the `browser.getState` RPC. They are kept
// independent of the SQLite row shape (see `core/db/schema.ts`) so a future
// schema change does not bleed into the IPC contract.

import type {
  BrowserTab as SharedBrowserTab,
  BrowserState as SharedBrowserState,
  LockOwner as SharedLockOwner,
  TabId,
  WorkspaceId,
} from '../../../shared/types';

export type { TabId, WorkspaceId };
export type BrowserTab = SharedBrowserTab;
export type BrowserState = SharedBrowserState;
export type LockOwner = SharedLockOwner;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Default landing page for a freshly-opened tab. `about:blank` keeps the
 * pane quiet until the user types a URL — matching Chrome's New Tab default
 * for embed scenarios where we don't want to ship a custom NTP yet.
 */
export const DEFAULT_TAB_URL = 'about:blank';
