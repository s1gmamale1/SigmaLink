// Tab strip — horizontal list with new-tab, switch-tab, close-tab.
//
// Middle-click closes (mirrors Chrome). Active tab is highlighted; long titles
// truncate with an ellipsis.
//
// BUG-DF-01 — wrapped in `React.memo` so the strip only re-renders when the
// tabs array (or active id) actually changes. The parent BrowserRoom receives
// a fresh `slice` on every `browser:state` broadcast; without memo, every
// title/url tick from the WebContentsView would re-render this component and
// contribute to the data-room flicker.

import { memo } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BrowserTab } from '@/shared/types';

interface Props {
  tabs: BrowserTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
}

function TabStripInner({ tabs, activeTabId, onSelect, onClose, onNewTab }: Props) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 py-1">
      {tabs.map((t) => {
        const isActive = t.id === activeTabId;
        const label = t.title || domainOf(t.url) || 'New Tab';
        return (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(t.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            className={cn(
              'group flex max-w-[180px] cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent/40',
            )}
            title={t.url}
          >
            <span className="truncate">{label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              className="rounded-sm p-0.5 opacity-50 hover:bg-muted hover:opacity-100"
              aria-label="Close tab"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <Button size="icon-sm" variant="ghost" onClick={onNewTab} title="New tab">
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

function domainOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname || u.protocol;
  } catch {
    return '';
  }
}

// BUG-DF-01 — content-aware comparator. The parent BrowserRoom passes a
// fresh `tabs` array on every `browser:state` broadcast (the reducer
// spreads on each event). Comparing the visible per-tab fields lets us
// short-circuit when the broadcast doesn't actually change what the strip
// renders (e.g. a page-title-update tick that we already absorbed, or a
// `did-navigate-in-page` that only bumped `lastVisitedAt`). All event
// handlers (`onSelect`, `onClose`, `onNewTab`) are wrapped in `useCallback`
// upstream so a referential check is enough for them.
function tabsArrayContentEqual(a: BrowserTab[], b: BrowserTab[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.url !== y.url || x.title !== y.title) return false;
  }
  return true;
}

export const TabStrip = memo(TabStripInner, (prev, next) => {
  return (
    prev.activeTabId === next.activeTabId &&
    prev.onSelect === next.onSelect &&
    prev.onClose === next.onClose &&
    prev.onNewTab === next.onNewTab &&
    tabsArrayContentEqual(prev.tabs, next.tabs)
  );
});
