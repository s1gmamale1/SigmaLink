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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { BrowserRoom } from '@/renderer/features/browser/BrowserRoom';
import { Splitter } from './Splitter';
import { RightRailTabs } from './RightRailTabs';
import { BridgeTabPlaceholder } from './BridgeTabPlaceholder';
import { EditorTabPlaceholder } from './EditorTabPlaceholder';
import { useRightRail } from './RightRailContext';

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
            browser: <BrowserRoom visible={activeTab === 'browser'} />,
            editor: <EditorTabPlaceholder />,
            bridge: <BridgeTabPlaceholder />,
          }}
        />
      </aside>
    </div>
  );
}
