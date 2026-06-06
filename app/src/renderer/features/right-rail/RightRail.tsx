// Right-rail dock — the column that hosts the Browser / Editor / Jorvis tabs
// alongside the main room body. Width persists to the kv store; the active
// tab is owned by `RightRailContext` so the top-bar segmented control
// (`RightRailSwitcher`) and the rail itself stay in sync. Mountable behind
// `kv['rightRail.enabled']`; when disabled the parent renders the body alone.
//
// V3-W13-001 — depends on the existing browser feature (Browser tab body) and
// will pick up real Editor/Jorvis bodies in W13-W14.
// SigmaLink v1.1.4 Step 3 — in-rail tab strip is hidden; the top-bar
// `RightRailSwitcher` is the segmented control.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppStateSelector } from '@/renderer/app/state';
import { useBelowBreakpoint } from '@/renderer/lib/use-breakpoint';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import { Splitter } from './Splitter';
import { RightRailTabs } from './RightRailTabs';
import { JorvisTabPlaceholder } from './JorvisTabPlaceholder';
import { EditorTabPlaceholder } from './EditorTabPlaceholder';
import { useRightRail } from './RightRailContext.data';

// v1.6.1 B3 — Skills discovery tab. Statically imported so the module is not
// split into a separate chunk — CommandRoom.tsx and PaneShell.tsx already pull
// in the same module synchronously (for SKILL_DRAG_MIME / SkillDragPayload),
// which would defeat the dynamic split regardless. Keeping it static removes
// the Rollup "dynamic import will not move module into another chunk" warning
// while matching the actual runtime behaviour.
import { SkillsTab } from '@/renderer/features/skills/SkillsTab';

// C-2/C-4 — Swarm tab: roster + side-chat in the rail. Lazy-loaded to keep
// the initial bundle lean; mounted once activated and kept alive.
const SwarmRailTab = lazy(() =>
  import('./SwarmRailTab').then((m) => ({
    default: m.SwarmRailTab,
  })),
);

// BSP-O1 — Sigma orchestrator panel (Canvas + Review sub-tabs). Lazy-loaded;
// kept alive once activated using the same latch pattern as SwarmRailTab.
const SigmaPanel = lazy(() =>
  import('./SigmaPanel').then((m) => ({
    default: m.SigmaPanel,
  })),
);

// Bundle-lazy: BrowserRoom (TabStrip, BrowserViewMount, BrowserRecents,
// DesignOverlay, plus the `browser:state` listener subscription) is loaded
// on-demand. The wrapping Suspense fallback paints a neutral placeholder
// while the chunk streams in — by the time the user clicks the Browser tab
// the chunk is typically already cached.
const BrowserRoom = lazy(() =>
  import('@/renderer/features/browser/BrowserRoom').then((m) => ({
    default: m.BrowserRoom,
  })),
);

interface Props {
  /**
   * Main-room slot. Rendered to the LEFT of the rail and consumes the rest of
   * the horizontal space; the rail itself is a fixed-width column that the
   * user resizes via the splitter.
   */
  children: ReactNode;
}

const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 200;
const MAX_WIDTH = 1200;
// Legacy GLOBAL kv key — read-through fallback so pre-RSP-1 widths aren't lost
// on first run after the migration to per-workspace keying.
const KV_WIDTH = 'rightRail.width';
// Per-workspace panel id (combined into `ui.<wsId>.rightRail.width`).
const RIGHT_RAIL_WIDTH_PANEL = 'rightRail.width';

export function RightRail({ children }: Props) {
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);
  const { activeTab, setActiveTab } = useRightRail();
  // RSP-1 — per-workspace width keying. When no workspace is open, `wsId` is
  // null and width persists under the legacy global key.
  const wsId = useAppStateSelector((s) => s.activeWorkspace?.id ?? null);

  // RSP-1 — narrow-viewport auto-collapse (NEW). Below the `narrow` breakpoint
  // (900px) the rail hides and the body renders full-bleed; widening back above
  // it re-shows the rail. This mirrors the Sidebar's one-way intent: collapsing
  // is driven purely by the viewport and never fights an explicit user action —
  // the rail's only re-open control (the top-bar `RightRailSwitcher`) lives
  // outside this component, and on a wide viewport the rail simply renders. The
  // value is derived in render (no effect, no setState cascade), so it stays in
  // lock-step with the breakpoint hook's `useSyncExternalStore` snapshot.
  const railCollapsed = useBelowBreakpoint('narrow');
  // Track the latest width so commit-handlers can persist without retriggering
  // a render via state lookups.
  const widthRef = useRef(DEFAULT_WIDTH);
  // Bundle-lazy Win 1 — defer mounting the Browser tab's body (TabStrip,
  // BrowserViewMount, BrowserRecents, DesignOverlay, plus a `browser:state`
  // listener subscription) until the user actually opens the Browser tab at
  // least once. Once mounted we keep it alive (so navigations and the
  // WebContentsView don't get torn down when the user switches tabs).
  //
  // The latch lives in a ref + boolean state: switching to 'browser' calls
  // `setBrowserActivated(true)` *during render* (which React allows for
  // derived state — it short-circuits and re-renders synchronously without
  // triggering the `set-state-in-effect` lint rule).
  const [browserActivated, setBrowserActivated] = useState(activeTab === 'browser');
  if (activeTab === 'browser' && !browserActivated) {
    setBrowserActivated(true);
  }
  // v1.6.1 B3 — Same lazy-mount pattern for Skills tab.
  const [skillsActivated, setSkillsActivated] = useState(activeTab === 'skills');
  if (activeTab === 'skills' && !skillsActivated) {
    setSkillsActivated(true);
  }
  // C-2/C-4 — Same lazy-mount pattern for Swarm tab.
  const [swarmActivated, setSwarmActivated] = useState(activeTab === 'swarm');
  if (activeTab === 'swarm' && !swarmActivated) {
    setSwarmActivated(true);
  }
  // BSP-O1 — Same lazy-mount keep-alive latch for the Sigma panel.
  const [sigmaActivated, setSigmaActivated] = useState(activeTab === 'sigma');
  if (activeTab === 'sigma' && !sigmaActivated) {
    setSigmaActivated(true);
  }

  // RSP-1 — hydrate persisted width from the per-workspace key
  // (`ui.<wsId>.rightRail.width`) with read-through fallback to the legacy
  // global key. Re-runs when `wsId` changes since a different workspace can
  // persist a different width. When no workspace is open we read the global key
  // directly so we don't crash. The active tab is hydrated by
  // `RightRailContext`, which is mounted higher in the tree.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rawWidth = wsId
          ? await readWorkspaceUi(wsId, RIGHT_RAIL_WIDTH_PANEL, KV_WIDTH)
          : await rpc.kv.get(KV_WIDTH).catch(() => null);
        if (!alive) return;
        const parsed = typeof rawWidth === 'string' ? parseInt(rawWidth, 10) : NaN;
        if (Number.isFinite(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
          setWidth(parsed);
          widthRef.current = parsed;
        } else {
          // A workspace with no persisted width falls back to the default so a
          // wide previous workspace doesn't bleed into a fresh one.
          setWidth(DEFAULT_WIDTH);
          widthRef.current = DEFAULT_WIDTH;
        }
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wsId]);

  const handleResize = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
  }, []);

  const handleCommit = useCallback(
    (final: number) => {
      const str = String(Math.round(final));
      if (wsId) {
        void writeWorkspaceUi(wsId, RIGHT_RAIL_WIDTH_PANEL, str);
      } else {
        void rpc.kv.set(KV_WIDTH, str).catch(() => undefined);
      }
    },
    [wsId],
  );

  // Until the kv read resolves we render the body full-bleed. Otherwise the
  // rail would flicker open at default width before snapping to the persisted
  // width — visually noisy on app boot.
  //
  // RSP-1 — also render full-bleed when the viewport is below the `narrow`
  // breakpoint (rail auto-collapsed). The `min-w-0` wrapper is preserved so the
  // body doesn't overflow its flex parent (SF-11). The parent dock gate
  // (`MainBody` in App.tsx) still owns whether RightRail mounts at all; this
  // only hides the rail column without unmounting the component.
  if (!hydrated || railCollapsed) {
    return <div className="flex min-h-0 min-w-0 flex-1">{children}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* min-w-0 is required: without it the flex child's min-width defaults to
          `auto` (the content's intrinsic width), which prevents the center column
          from shrinking to accommodate the fixed-pixel aside. That causes the row
          to overflow the viewport, misaligning both the sidebar and the right rail
          (SF-11). */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      <Splitter width={width} onResize={handleResize} onCommit={handleCommit} />
      <aside
        className="sl-glass relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
        style={{ width }}
        aria-label="Right rail"
        data-testid="right-rail"
      >
        <RightRailTabs
          active={activeTab}
          onSelect={setActiveTab}
          tabsVisible={false}
          bodies={{
            browser: browserActivated ? (
              <Suspense
                fallback={
                  <div
                    role="status"
                    aria-label="Loading browser"
                    className="h-full min-h-0 flex-1 animate-pulse bg-muted/30"
                  />
                }
              >
                <BrowserRoom visible={activeTab === 'browser'} />
              </Suspense>
            ) : null,
            editor: <EditorTabPlaceholder />,
            jorvis: <JorvisTabPlaceholder />,
            skills: skillsActivated ? <SkillsTab /> : null,
            swarm: swarmActivated ? (
              <Suspense
                fallback={
                  <div
                    role="status"
                    aria-label="Loading swarm"
                    className="h-full min-h-0 flex-1 animate-pulse bg-muted/30"
                  />
                }
              >
                <SwarmRailTab />
              </Suspense>
            ) : null,
            sigma: sigmaActivated ? (
              <Suspense
                fallback={
                  <div
                    role="status"
                    aria-label="Loading Sigma panel"
                    className="h-full min-h-0 flex-1 animate-pulse bg-muted/30"
                  />
                }
              >
                <SigmaPanel />
              </Suspense>
            ) : null,
          }}
        />
      </aside>
    </div>
  );
}
