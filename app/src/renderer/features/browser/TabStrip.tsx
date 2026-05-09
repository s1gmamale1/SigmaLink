// Tab strip — horizontal list with new-tab, switch-tab, close-tab.
//
// Middle-click closes (mirrors Chrome). Active tab is highlighted; long titles
// truncate with an ellipsis.

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

export function TabStrip({ tabs, activeTabId, onSelect, onClose, onNewTab }: Props) {
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
