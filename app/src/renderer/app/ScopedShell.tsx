// Multi-window B4 / DEV-W4 — minimal shell for a SCOPED (secondary /
// detached-workspace) window. No Sidebar, no room nav, no Settings routes;
// just a draggable titlebar affordance, the RightRailSwitcher (so the
// Browser / Jorvis / Skills / Swarm / Sigma panels are reachable in the
// secondary window), and the Command Room for the one workspace this window
// owns.
//
// The titlebar reuses the same macOS drag-region pattern as the Sidebar
// (`dragStyle()` → `WebkitAppRegion: 'drag'`). The RightRailSwitcher's own
// buttons use `noDragStyle()` internally so they stay clickable. We pass
// `showSettings={false}` because the scoped window has no RoomSwitch for the
// Settings room.

import { useEffect } from 'react';
import { CommandRoom } from '@/renderer/features/command-room/CommandRoom';
import { RightRail } from '@/renderer/features/right-rail/RightRail';
import { useRightRailEnabled } from '@/renderer/features/right-rail/use-right-rail-enabled';
import { useRightRail } from '@/renderer/features/right-rail/RightRailContext.data';
import { RightRailSwitcher } from '@/renderer/features/top-bar/RightRailSwitcher';
import { useAppStateSelector } from '@/renderer/app/state';
import { dragStyle } from '@/renderer/lib/drag-region';

export function ScopedShell() {
  const workspaceName = useAppStateSelector((s) => s.activeWorkspace?.name ?? null);
  const { enabled, ready } = useRightRailEnabled();
  const { railOpen } = useRightRail();

  useEffect(() => {
    if (workspaceName) document.title = `${workspaceName} — SigmaLink`;
  }, [workspaceName]);

  // Mirror MainBody: only wrap in the rail once the enabled flag resolved and
  // the rail is open, so the scoped window never flashes an empty rail.
  const showRail = ready && enabled && railOpen;
  const body = (
    <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
      <CommandRoom />
    </main>
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* Scoped titlebar: drag region + the rail switcher (no Settings gear —
          the scoped window has no RoomSwitch to navigate to Settings). The
          switcher's own buttons use noDragStyle() so they stay clickable. */}
      <div
        className="flex h-8 shrink-0 items-center border-b border-border bg-background/60 pr-2"
        style={dragStyle()}
      >
        {ready && enabled && <RightRailSwitcher showSettings={false} />}
      </div>
      {showRail ? <RightRail>{body}</RightRail> : body}
    </div>
  );
}
