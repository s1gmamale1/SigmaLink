// Window-scope-aware UI-chrome persistence.
//
// The MAIN window's chrome (sidebar width, right-rail width/open/tab) is a
// GLOBAL preference: it must NOT change when the user switches the active
// workspace. A SCOPED (detached-workspace) window is bound to one fixed
// workspace, so its chrome is keyed per-workspace (`ui.<scope>.<panel>`),
// keeping it independent of the main window — preserving the no-clobber
// property from #177 (tools in scoped windows).
//
// Resolution: getWorkspaceScope() is null in the main window (→ global key)
// and the fixed workspace id in a scoped window (→ per-scope key).

import { rpcSilent } from '@/renderer/lib/rpc';
import { getWorkspaceScope } from '@/renderer/lib/window-context';
import { readWorkspaceUi, writeWorkspaceUi, workspaceUiKey } from '@/renderer/lib/workspace-ui-kv';

/** Resolve the kv key for a chrome panel: the global key in the main window,
 *  or the per-window-scope key (`ui.<scope>.<panel>`) in a scoped window. */
export function chromeUiKey(globalKey: string, panel: string): string {
  const scope = getWorkspaceScope();
  return scope ? workspaceUiKey(scope, panel) : globalKey;
}

/** Read chrome state. Main → global key. Scoped → per-scope key with a
 *  read-through fallback to the global key. Null when unset / on error. */
export async function readChromeUi(globalKey: string, panel: string): Promise<string | null> {
  const scope = getWorkspaceScope();
  if (scope) return readWorkspaceUi(scope, panel, globalKey);
  try {
    const v = await rpcSilent.kv.get(globalKey);
    return v ?? null;
  } catch {
    return null;
  }
}

/** Write chrome state. Main → global key. Scoped → per-scope key. Best-effort. */
export async function writeChromeUi(globalKey: string, panel: string, value: string): Promise<void> {
  const scope = getWorkspaceScope();
  if (scope) {
    await writeWorkspaceUi(scope, panel, value);
    return;
  }
  try {
    await rpcSilent.kv.set(globalKey, value);
  } catch {
    /* best-effort — layout persistence is non-critical */
  }
}
