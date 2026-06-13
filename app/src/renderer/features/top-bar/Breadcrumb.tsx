// V3-W12-008: top-bar breadcrumb. V3 frame 0185 shows
// `Workspace 10 / matthewmiller` rendered as a single muted line at the top
// of the active room. We replicate that here.
//
// The OS username is not directly available to the renderer (sandbox +
// contextIsolation = true). To avoid plumbing a new RPC channel — owned by
// V3-W12-017 / coder-foundations — we cache a username in kv under
// `app.userName`. If unset on first render we derive it from the active
// workspace's `rootPath` (`/Users/<name>/…` on macOS, `/home/<name>/…` on
// Linux) and persist it. Windows falls back to the empty string (the
// renderer simply omits the `/<user>` half of the breadcrumb).
//
// Workspace number = 1-based index in `state.workspaces`. We deliberately
// match V3 by counting from 1 on display ("Workspace 10").

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { dragStyle, noDragStyle } from '@/renderer/lib/drag-region';
import { IS_WIN32 } from '@/renderer/lib/platform';
import { RufloReadinessPill } from '@/renderer/components/RufloReadinessPill';
import { NotificationBell } from '@/renderer/features/notifications/NotificationBell';
import { RoomsMenuButton } from './RoomsMenuButton';
import { RightRailSwitcher } from './RightRailSwitcher';

// V1.2.0 Windows port — reserve 140px on the right edge so the breadcrumb's
// rightmost cluster (RightRailSwitcher + settings gear) never collides with
// Windows' native Window Caption Overlay (min / max / close buttons) which
// render at top-right when `titleBarStyle: 'default'`. macOS / Linux leave it
// unset because their window controls live on the left / outside the chrome.
const WIN32_WCO_RESERVE_PX = 140;

export function Breadcrumb() {
  // PERF-3 — granular selectors: re-render only when the active workspace or
  // the persisted workspace list changes. Both are referentially-stable slices
  // (the reducer replaces them by reference), so Object.is bail-out holds.
  const dispatch = useAppDispatch();
  const active = useAppStateSelector((s) => s.activeWorkspace);
  const workspaces = useAppStateSelector((s) => s.workspaces);
  const [userName, setUserName] = useState<string>('');

  // BSP-O5 — persistent 1-click shortcut to the memory graph from any room.
  const openMemoryGraph = useCallback(() => {
    dispatch({ type: 'SET_ROOM', room: 'memory' });
    dispatch({ type: 'SET_PENDING_MEMORY_GRAPH_VIEW', pending: true });
  }, [dispatch]);

  // Hydrate kv on mount; if unset, peek at the path on the active workspace.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cached = await rpc.kv.get('app.userName');
        if (!alive) return;
        if (cached && typeof cached === 'string' && cached.trim()) {
          setUserName(cached.trim());
          return;
        }
        // Fall back to extracting from the path. This runs once per app boot
        // and the result is cached, so the cost is negligible.
        const inferred = active ? extractUserFromPath(active.rootPath) : '';
        if (inferred) {
          setUserName(inferred);
          void rpc.kv.set('app.userName', inferred).catch(() => undefined);
        }
      } catch {
        // kv unavailable — leave blank.
      }
    })();
    return () => {
      alive = false;
    };
  }, [active]);

  const workspaceNumber = useMemo(() => {
    if (!active) return null;
    const idx = workspaces.findIndex((w) => w.id === active.id);
    // 1-based; if the active workspace has not landed in the list yet (race
    // on first open), fall back to the workspace count.
    return idx >= 0 ? idx + 1 : workspaces.length;
  }, [active, workspaces]);

  if (!active) {
    // Still render the chrome bar so the layout below does not jump when a
    // workspace opens. The label reads `No workspace open`. The rooms menu
    // button still renders here — Workspaces / Settings / Skills / Sigma are
    // reachable without an active workspace and the user needs a way back to
    // the workspaces room.
    return (
      <div
        className="sl-glass-toolbar flex h-8 items-center gap-2 border-b border-border bg-background/60 px-4 text-xs text-muted-foreground"
        style={{
          ...dragStyle(),
          paddingRight: IS_WIN32 ? WIN32_WCO_RESERVE_PX : undefined,
        }}
        data-testid="breadcrumb-empty"
      >
        <RoomsMenuButton />
        <span>No workspace open</span>
        <NotificationBell />
        <RightRailSwitcher />
      </div>
    );
  }

  return (
    <div
      className="sl-glass-toolbar flex h-8 items-center gap-1 border-b border-border bg-background/60 px-4 text-xs"
      style={{
        ...dragStyle(),
        paddingRight: IS_WIN32 ? WIN32_WCO_RESERVE_PX : undefined,
      }}
      data-testid="breadcrumb"
    >
      <RoomsMenuButton />
      <span className="text-foreground">Workspace {workspaceNumber}</span>
      {userName ? (
        <>
          <span className="text-muted-foreground">/</span>
          <span className="text-muted-foreground">{userName}</span>
        </>
      ) : null}
      <span className="ml-2 truncate text-muted-foreground" title={active.rootPath}>
        — {active.name}
      </span>
      <NotificationBell />
      {/* BSP-O5 — 1-click shortcut to the memory graph from any room. */}
      <button
        type="button"
        onClick={openMemoryGraph}
        aria-label="Open memory graph"
        data-testid="breadcrumb-memory-graph"
        className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
        // Inside the draggable breadcrumb — without this the click would start a
        // window drag instead of firing onClick (Windows + macOS frameless chrome).
        style={noDragStyle()}
      >
        <Network className="h-3.5 w-3.5" />
      </button>
      <RightRailSwitcher />
      <RufloReadinessPill />
    </div>
  );
}

// Best-effort username extraction from a POSIX-ish absolute path. Returns
// the empty string if the pattern does not match (Windows, custom mounts).
function extractUserFromPath(p: string): string {
  const m = /^\/(?:Users|home)\/([^/]+)(?:\/|$)/.exec(p);
  return m ? m[1] : '';
}
