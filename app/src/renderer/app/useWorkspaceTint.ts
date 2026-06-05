// BSP-T4 — per-workspace tint hook.
//
// Reacts to the active workspace + the global theme changing. When a workspace
// becomes active, reads its persisted `ui.<wsId>.tint` value and applies it
// inline (via `applyTint`). When the workspace changes (or becomes null),
// `clearTint` removes the inline overrides so they never leak to the next
// workspace or to the no-workspace state.
//
// Also re-applies when the global theme changes — `applyTheme` sets a new
// `data-theme` attribute which resets the [data-theme] CSS blocks, but our
// inline style properties have higher specificity so they survive; however
// the cleanup is still needed to keep the hook self-consistent, and any
// workspace with NO tint gets a clearTint after a theme switch.
//
// NO-LEAK INVARIANT: clearTint() is called on every change of `activeWorkspaceId`
// (including when a new workspace is activated — the new workspace's tint is
// read async, and clearTint first, then applyTint if found).

import { useEffect } from 'react';
import { useTheme } from '@/renderer/app/ThemeProvider';
import { readWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import { applyTint, clearTint, parseTint } from '@/renderer/lib/workspace-tint';

export function useWorkspaceTint(activeWorkspaceId: string | null): void {
  const { theme } = useTheme();

  useEffect(() => {
    let alive = true;

    // Always clear first — prevents old workspace tint bleeding through
    // while we fetch the new workspace's persisted tint.
    clearTint();

    if (!activeWorkspaceId) return;

    void readWorkspaceUi(activeWorkspaceId, 'tint').then((raw) => {
      if (!alive) return;
      const t = parseTint(raw);
      if (t) applyTint(t);
      else clearTint();
    });

    return () => {
      alive = false;
    };
  }, [activeWorkspaceId, theme]);
}
