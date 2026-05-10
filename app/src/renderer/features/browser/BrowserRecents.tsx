// Recents panel — left-side strip in the Browser tab. Lists the last N
// distinct origins visited within the active workspace, sourced from
// `browser_tabs.lastVisitedAt`. Click an origin → navigate the active tab.
//
// V3-W13-002 — depends on the right-rail dock (V3-W13-001) and the existing
// `browser.navigate` RPC.
//
// BUG-DF-01 — wrapped in `React.memo`. The parent BrowserRoom now passes a
// stable `tabs` reference (preserved across `browser:state` broadcasts when
// the tab content didn't actually change), so the recents column no longer
// re-renders on every page-title-update tick.

import { memo, useMemo } from 'react';
import { Globe } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';
import type { BrowserTab } from '@/shared/types';

interface Props {
  workspaceId: string;
  tabs: BrowserTab[];
  activeTabId: string | null;
  /** When `false` we render a disabled-looking strip but still draw the chrome. */
  disabled?: boolean;
}

const RECENTS_LIMIT = 10;

interface OriginEntry {
  origin: string;
  url: string; // The most recent full URL for the origin (used for navigation).
  lastVisitedAt: number;
}

function originOf(url: string): string | null {
  if (!url || url.startsWith('about:')) return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function buildRecents(tabs: BrowserTab[]): OriginEntry[] {
  const byOrigin = new Map<string, OriginEntry>();
  // Most-recent-first traversal so the first sighting of an origin wins.
  const sorted = [...tabs].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
  for (const t of sorted) {
    const origin = originOf(t.url);
    if (!origin) continue;
    if (byOrigin.has(origin)) continue;
    byOrigin.set(origin, {
      origin,
      url: t.url,
      lastVisitedAt: t.lastVisitedAt,
    });
    if (byOrigin.size >= RECENTS_LIMIT) break;
  }
  return Array.from(byOrigin.values());
}

function shortLabel(origin: string): string {
  try {
    const u = new URL(origin);
    return u.hostname || origin;
  } catch {
    return origin;
  }
}

function BrowserRecentsInner({ workspaceId, tabs, activeTabId, disabled }: Props) {
  const recents = useMemo(() => buildRecents(tabs), [tabs]);

  const onClick = (entry: OriginEntry) => {
    if (disabled || !activeTabId) return;
    void rpc.browser
      .navigate({ workspaceId, tabId: activeTabId, url: entry.url })
      .catch(() => undefined);
  };

  return (
    <aside
      aria-label="Recent origins"
      className={cn(
        'flex w-[180px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-sidebar/60 p-2',
      )}
    >
      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Recents
      </div>
      {recents.length === 0 ? (
        <div className="px-1 text-[11px] text-muted-foreground/70">
          No history yet — navigate a tab to populate this list.
        </div>
      ) : (
        recents.map((r) => (
          <button
            key={r.origin}
            type="button"
            onClick={() => onClick(r)}
            disabled={disabled || !activeTabId}
            className={cn(
              'group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition',
              'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            title={r.url}
          >
            <Globe className="h-3 w-3 shrink-0 opacity-70 group-hover:opacity-100" aria-hidden />
            <span className="truncate">{shortLabel(r.origin)}</span>
          </button>
        ))
      )}
    </aside>
  );
}

// BUG-DF-01 — only the inputs to `buildRecents` matter (per-tab origin via
// `url` + ordering via `lastVisitedAt`). Comparing those lets us skip the
// re-render and the buildRecents resort/filter when the broadcast doesn't
// touch anything visible in the recents column.
function recentsInputsEqual(a: BrowserTab[], b: BrowserTab[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.url !== y.url || x.lastVisitedAt !== y.lastVisitedAt) {
      return false;
    }
  }
  return true;
}

export const BrowserRecents = memo(BrowserRecentsInner, (prev, next) => {
  return (
    prev.workspaceId === next.workspaceId &&
    prev.activeTabId === next.activeTabId &&
    prev.disabled === next.disabled &&
    recentsInputsEqual(prev.tabs, next.tabs)
  );
});
