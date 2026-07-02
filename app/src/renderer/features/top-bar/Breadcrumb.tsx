// Minimal-chrome brand bar (2026-07-02 spec). One bar for both the empty and
// active-workspace states: rooms menu · Σ monogram · wordmark · muted version,
// with the functional icon cluster right-aligned. The old
// `Workspace N / user — name` text and its `app.userName` kv plumbing are
// deliberately removed — workspace identity lives in the sidebar.
//
// The version is read once on mount via `rpc.app.getVersion()` (the same
// source `use-whats-new.ts` uses) and cached in local state; it renders as
// `v{version}` and stays empty (no layout reservation) until it resolves.

import { useCallback, useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { dragStyle, noDragStyle } from '@/renderer/lib/drag-region';
import { IS_WIN32 } from '@/renderer/lib/platform';
import { Monogram } from '@/renderer/components/Monogram';
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
  // PERF-3 — granular selector: re-render only when the active workspace
  // changes. The slice is a referentially-stable slice (the reducer replaces
  // it by reference), so the Object.is bail-out holds.
  const dispatch = useAppDispatch();
  const active = useAppStateSelector((s) => s.activeWorkspace);
  const [version, setVersion] = useState<string>('');

  // Fetch the running app version once on mount and cache it. Empty string
  // until it resolves — the version span simply does not render, so there is
  // no layout reservation / jump.
  useEffect(() => {
    let alive = true;
    void rpc.app
      .getVersion()
      .then((v) => {
        if (alive && typeof v === 'string' && v.trim()) setVersion(v.trim());
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // BSP-O5 — persistent 1-click shortcut to the memory graph from any room.
  const openMemoryGraph = useCallback(() => {
    dispatch({ type: 'SET_ROOM', room: 'memory' });
    dispatch({ type: 'SET_PENDING_MEMORY_GRAPH_VIEW', pending: true });
  }, [dispatch]);

  return (
    <div
      className="sl-glass-toolbar flex h-8 items-center gap-2 border-b border-border bg-background/60 px-4 text-xs"
      style={{
        ...dragStyle(),
        paddingRight: IS_WIN32 ? WIN32_WCO_RESERVE_PX : undefined,
      }}
      data-testid="breadcrumb"
    >
      <RoomsMenuButton />
      <Monogram size={14} />
      <span className="font-medium text-foreground">SigmaLink</span>
      {version ? <span className="text-muted-foreground">v{version}</span> : null}
      {/* Spacer pushes the whole functional cluster to the right edge. It wins
          the free space before RightRailSwitcher's own ml-auto resolves (CSS
          flex-grow §9.7 runs before auto-margin distribution §9.9), so the
          switcher's ml-auto collapses to 0 — one clean right edge, no gap. */}
      <div className="flex-1" />
      <NotificationBell />
      {active ? (
        <button
          type="button"
          onClick={openMemoryGraph}
          aria-label="Open memory graph"
          data-testid="breadcrumb-memory-graph"
          // Inside the draggable breadcrumb — without this the click would start
          // a window drag instead of firing onClick (Windows + macOS frameless).
          style={noDragStyle()}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Network className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <RightRailSwitcher />
      {active ? <RufloReadinessPill /> : null}
    </div>
  );
}
