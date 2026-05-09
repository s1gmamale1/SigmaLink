// Right-rail dock — the column that hosts the Browser / Editor / Bridge tabs
// alongside the main room body. Width and last-active tab persist to the kv
// store. Mountable behind `kv['rightRail.enabled']`; when disabled the parent
// renders the body alone.
//
// V3-W13-001 — depends on the existing browser feature (Browser tab body) and
// will pick up real Editor/Bridge bodies in W13-W14.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { BrowserRoom } from '@/renderer/features/browser/BrowserRoom';
import { Splitter } from './Splitter';
import { RightRailTabs, type RightRailTabId } from './RightRailTabs';
import { BridgeTabPlaceholder } from './BridgeTabPlaceholder';
import { EditorTabPlaceholder } from './EditorTabPlaceholder';

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
const KV_TAB = 'rightRail.tab';

const VALID_TABS: ReadonlySet<RightRailTabId> = new Set(['browser', 'editor', 'bridge']);

export function RightRail({ children }: Props) {
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [activeTab, setActiveTab] = useState<RightRailTabId>('browser');
  const [hydrated, setHydrated] = useState(false);
  // Track the latest width so commit-handlers can persist without retriggering
  // a render via state lookups.
  const widthRef = useRef(DEFAULT_WIDTH);

  // Hydrate persisted width + tab once on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [rawWidth, rawTab] = await Promise.all([
          rpcSilent.kv.get(KV_WIDTH).catch(() => null),
          rpcSilent.kv.get(KV_TAB).catch(() => null),
        ]);
        if (!alive) return;
        const parsed = typeof rawWidth === 'string' ? parseInt(rawWidth, 10) : NaN;
        if (Number.isFinite(parsed) && parsed >= 200 && parsed <= 1200) {
          setWidth(parsed);
          widthRef.current = parsed;
        }
        if (typeof rawTab === 'string' && VALID_TABS.has(rawTab as RightRailTabId)) {
          setActiveTab(rawTab as RightRailTabId);
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

  const handleSelectTab = useCallback((tab: RightRailTabId) => {
    setActiveTab(tab);
    void rpc.kv.set(KV_TAB, tab).catch(() => undefined);
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
          onSelect={handleSelectTab}
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
