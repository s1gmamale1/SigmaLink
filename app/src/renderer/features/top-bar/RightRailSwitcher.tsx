// SigmaLink v1.1.4 Step 3: segmented control + settings gear that lives at
// the right edge of the breadcrumb. V3 frame 0185 lifts the three rail tabs
// (Browser / Editor / Sigma) out of the rail and parks them in the top-bar
// as a three-button toggle, with a Settings gear immediately to the right.
//
// Tab ids mirror `RightRailContext` (browser | editor | jorvis). The "jorvis"
// id is internal — the visible label is "Jorvis" per the v1.8.x rebrand.

import { Bot, FileCode2, Globe, Settings, Users, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { noDragStyle } from '@/renderer/lib/drag-region';
import { useAppDispatch } from '@/renderer/app/state';
import {
  useRightRail,
  type RightRailTabId,
} from '@/renderer/features/right-rail/RightRailContext.data';

interface SegmentDef {
  id: RightRailTabId;
  label: string;
  Icon: typeof Globe;
}

const SEGMENTS: readonly SegmentDef[] = [
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'editor', label: 'Editor', Icon: FileCode2 },
  // jorvis is the internal id; the visible label is "Jorvis" per v1.4.8 rebrand.
  { id: 'jorvis', label: 'Jorvis', Icon: Bot },
  // v1.6.1 B3 — Skills discovery tab.
  { id: 'skills', label: 'Skills', Icon: Zap },
  // C-2/C-4 — Swarm tab: agent roster + side-chat in the rail.
  { id: 'swarm', label: 'Swarm', Icon: Users },
] as const;

export function RightRailSwitcher() {
  const { activeTab, setActiveTab } = useRightRail();
  // PERF-3 — dispatch-only consumer. useAppDispatch is stable and never
  // re-renders, so the switcher no longer wakes on every unrelated dispatch.
  const dispatch = useAppDispatch();

  return (
    <div className="ml-auto flex items-center gap-1.5" style={noDragStyle()}>
      <div
        role="tablist"
        aria-label="Right rail tabs"
        className="flex items-center gap-0.5 rounded-md border border-border bg-background/40 p-0.5"
      >
        {SEGMENTS.map((seg) => {
          const isActive = seg.id === activeTab;
          return (
            <button
              key={seg.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={seg.label}
              title={seg.label}
              data-segment-id={seg.id}
              onClick={() => setActiveTab(seg.id)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isActive
                  ? 'border border-primary bg-primary/15 text-primary'
                  : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground',
              )}
              style={noDragStyle()}
            >
              <seg.Icon className="h-3.5 w-3.5" aria-hidden />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        data-room-id="settings"
        onClick={() => dispatch({ type: 'SET_ROOM', room: 'settings' })}
        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={noDragStyle()}
      >
        <Settings className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
