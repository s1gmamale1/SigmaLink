// Tab bar for the right-rail dock. Three permanent tabs: Browser, Editor,
// Bridge. The active tab id is owned by `RightRail.tsx`; inactive tabs are
// kept mounted under `display:none` so per-pane state (browser tabs, editor
// scroll, bridge transcript) survives a switch.

import { Bot, FileCode2, Globe } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type RightRailTabId = 'browser' | 'editor' | 'bridge';

interface TabDef {
  id: RightRailTabId;
  label: string;
  Icon: typeof Globe;
}

const TABS: readonly TabDef[] = [
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'editor', label: 'Editor', Icon: FileCode2 },
  { id: 'bridge', label: 'Bridge Assistant', Icon: Bot },
] as const;

interface Props {
  active: RightRailTabId;
  onSelect: (tab: RightRailTabId) => void;
  /** Per-tab body content. Each is mounted at all times; only the active one is visible. */
  bodies: Record<RightRailTabId, ReactNode>;
}

export function RightRailTabs({ active, onSelect, bodies }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Right rail tabs"
        className="flex shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2 py-1"
      >
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`right-rail-panel-${t.id}`}
              id={`right-rail-tab-${t.id}`}
              onClick={() => onSelect(t.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition',
                isActive
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/40',
              )}
            >
              <t.Icon className="h-3.5 w-3.5" aria-hidden />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {TABS.map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            id={`right-rail-panel-${t.id}`}
            aria-labelledby={`right-rail-tab-${t.id}`}
            hidden={t.id !== active}
            // We cannot rely on `hidden` alone because some children (the
            // browser BrowserViewMount in particular) need an absolute-zero
            // bounding rect when hidden so the WebContentsView is parked. The
            // children query their own visibility via the `data-active` attr.
            data-active={t.id === active}
            className={cn(
              'min-h-0 flex-1 flex-col',
              t.id === active ? 'flex' : 'hidden',
            )}
          >
            {bodies[t.id]}
          </div>
        ))}
      </div>
    </div>
  );
}
