// DOM terminal presenter P2 — extracted VERBATIM from Terminal.tsx so both
// the xterm host AND DomTerminalView can route a clicked PTY-pane link without
// an import cycle (Terminal → DomTerminalView → routeLinkClick).

import { rpc, rpcSilent } from '@/renderer/lib/rpc';

/**
 * V3-W13-002 — when the user clicks a link inside a PTY pane, prefer
 * routing through the active workspace's built-in browser. Falls back to
 * `window.open` (which Electron forwards to the OS) if anything goes wrong
 * or the gate kv is `'0'`.
 *
 * Note: lives at module scope so the function identity is stable. The
 * cache's link-handler closure captures it once at first cache miss; the
 * `workspaceId` argument is read from a mutable holder the host updates
 * on every workspace change.
 */
export function routeLinkClick(
  url: string,
  workspaceId: string | undefined,
  surfaceBrowser?: () => void,
): void {
  void (async () => {
    let captureEnabled = true;
    try {
      const raw = await rpcSilent.kv.get('browser.captureLinks');
      captureEnabled = raw === null || raw === undefined ? true : raw === '1';
    } catch {
      /* default ON when kv unreachable */
    }
    if (!captureEnabled || !workspaceId) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      const state = await rpcSilent.browser.getState(workspaceId);
      if (state.activeTabId) {
        await rpc.browser.navigate({ workspaceId, tabId: state.activeTabId, url });
      } else {
        await rpc.browser.openTab({ workspaceId, url });
      }
      // C-8: surface the browser tab in the right rail after navigation.
      surfaceBrowser?.();
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  })();
}
