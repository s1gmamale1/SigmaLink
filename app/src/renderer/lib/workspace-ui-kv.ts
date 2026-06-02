// RSP-1 — per-workspace UI persistence, keyed `ui.<workspaceId>.<panel>`.
//
// The `kv` table is global (key-only PK); per-workspace scoping is by key
// convention (the established `provider.autoinstall.consent.<id>` idiom). Reads
// fall through to a legacy GLOBAL key (e.g. `rightRail.width`) so existing,
// pre-RSP-1 widths aren't lost on first run after the migration to per-workspace.

import { rpcSilent } from '@/renderer/lib/rpc';

export function workspaceUiKey(workspaceId: string, panel: string): string {
  return `ui.${workspaceId}.${panel}`;
}

/**
 * Read a per-workspace UI value; if unset, fall through to `legacyGlobalKey`
 * (when provided). Returns null when neither exists / on any error.
 */
export async function readWorkspaceUi(
  workspaceId: string,
  panel: string,
  legacyGlobalKey?: string,
): Promise<string | null> {
  try {
    const scoped = await rpcSilent.kv.get(workspaceUiKey(workspaceId, panel));
    if (scoped !== null && scoped !== undefined) return scoped;
    if (legacyGlobalKey) {
      const legacy = await rpcSilent.kv.get(legacyGlobalKey);
      return legacy ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write a per-workspace UI value (best-effort). */
export async function writeWorkspaceUi(
  workspaceId: string,
  panel: string,
  value: string,
): Promise<void> {
  try {
    await rpcSilent.kv.set(workspaceUiKey(workspaceId, panel), value);
  } catch {
    /* best-effort — layout persistence is non-critical */
  }
}
