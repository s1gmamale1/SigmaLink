// Per-workspace dot colour hook — reads/writes `ui.<id>.color` KV keys.
//
// On mount (and whenever `ids` changes) each workspace's persisted hex is
// fetched from the KV store. If no value is stored, `defaultWorkspaceColor`
// provides a deterministic default drawn from WORKSPACE_DOT_HEX_PALETTE.
//
// Setter: `setColor(id, hex)` persists the hex and updates React state.
//         `setColor(id, null)` resets to the default and writes '' to KV.
//
// This is a drop-in companion to the workspace dot in WorkspacesPanel — it
// does NOT touch `--accent`/`--surface-tint` (those are BSP-T4 tint territory).

import { useCallback, useEffect, useState } from 'react';
import { defaultWorkspaceColor } from '@/renderer/lib/workspace-color';
import { rpcSilent } from '@/renderer/lib/rpc';

function colorKvKey(id: string): string {
  return `ui.${id}.color`;
}

export interface WorkspaceColorsHandle {
  /** Returns the resolved hex for a given workspace id (stored or default). */
  colorFor(id: string): string;
  /**
   * Persist a new hex for a workspace and update the local state.
   * Pass `null` to reset to the deterministic default.
   */
  setColor(id: string, hex: string | null): void;
}

export function useWorkspaceColors(ids: string[]): WorkspaceColorsHandle {
  const [colors, setColors] = useState<Record<string, string>>({});

  // Load persisted colours for all current ids whenever the id list changes.
  useEffect(() => {
    let alive = true;

    async function load() {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const stored = await rpcSilent.kv.get(colorKvKey(id));
            const hex = stored && stored !== '' ? stored : defaultWorkspaceColor(id);
            return [id, hex] as const;
          } catch {
            return [id, defaultWorkspaceColor(id)] as const;
          }
        }),
      );
      if (!alive) return;
      setColors(Object.fromEntries(entries));
    }

    void load();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);

  const colorFor = useCallback(
    (id: string): string => {
      return colors[id] ?? defaultWorkspaceColor(id);
    },
    [colors],
  );

  const setColor = useCallback(
    (id: string, hex: string | null): void => {
      const resolved = hex ?? defaultWorkspaceColor(id);
      const stored = hex ?? '';

      // Optimistic local state update.
      setColors((prev) => ({ ...prev, [id]: resolved }));

      // Best-effort persistence — never blocks or throws to the caller.
      rpcSilent.kv.set(colorKvKey(id), stored).catch(() => {});
    },
    [],
  );

  return { colorFor, setColor };
}
