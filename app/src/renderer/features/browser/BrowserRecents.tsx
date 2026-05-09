// Recents panel — left-side strip in the Browser tab. Lists the last N
// distinct origins visited within the active workspace, sourced from
// `browser_tabs.lastVisitedAt`. Click an origin → navigate the active tab.
//
// V3-W13-002 — depends on the right-rail dock (V3-W13-001) and the existing
// `browser.navigate` RPC.

import { useMemo } from 'react';
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

export function BrowserRecents({ workspaceId, tabs, activeTabId, disabled }: Props) {
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
