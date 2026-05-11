// Right-rail dock — the column that hosts the Browser / Editor / Bridge tabs
// alongside the main room body. Width persists to the kv store; the active
// tab is owned by `RightRailContext` so the top-bar segmented control
// (`RightRailSwitcher`) and the rail itself stay in sync. Mountable behind
// `kv['rightRail.enabled']`; when disabled the parent renders the body alone.
//
// V3-W13-001 — depends on the existing browser feature (Browser tab body) and
// will pick up real Editor/Bridge bodies in W13-W14.
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
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { Splitter } from './Splitter';
import { RightRailTabs } from './RightRailTabs';
import { BridgeTabPlaceholder } from './BridgeTabPlaceholder';
import { EditorTabPlaceholder } from './EditorTabPlaceholder';
import { useRightRail } from './RightRailContext.data';

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
const KV_WIDTH = 'rightRail.width';

export function RightRail({ children }: Props) {
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);
  const { activeTab, setActiveTab } = useRightRail();
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

  // Hydrate persisted width once on mount. The active tab is hydrated by
  // `RightRailContext`, which is mounted higher in the tree.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rawWidth = await rpcSilent.kv.get(KV_WIDTH).catch(() => null);
        if (!alive) return;
        const parsed = typeof rawWidth === 'string' ? parseInt(rawWidth, 10) : NaN;
        if (Number.isFinite(parsed) && parsed >= 200 && parsed <= 1200) {
          setWidth(parsed);
          widthRef.current = parsed;
        }
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleResize = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
  }, []);

  const handleCommit = useCallback((final: number) => {
    void rpc.kv.set(KV_WIDTH, String(Math.round(final))).catch(() => undefined);
  }, []);

  // Until the kv read resolves we render the body full-bleed. Otherwise the
  // rail would flicker open at default width before snapping to the persisted
  // width — visually noisy on app boot.
  if (!hydrated) {
    return <div className="flex min-h-0 flex-1">{children}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <Splitter width={width} onResize={handleResize} onCommit={handleCommit} />
      <aside
        className="flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
        style={{ width }}
        aria-label="Right rail"
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
            bridge: <BridgeTabPlaceholder />,
          }}
        />
      </aside>
    </div>
  );
}
