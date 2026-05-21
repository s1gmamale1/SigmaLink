// W-4 Phase 4 — Ephemeral scratch-shell sub-tab strip.
//
// Rendered ONLY when scratchTabs.length > 0 (hidden otherwise — zero-subtab
// invariant: with no scratch tabs the parent PaneShell renders exactly as
// before this feature shipped).
//
// Layout: [Main | Scratch-1 × | Scratch-2 × | …]
// - Main tab has no close button (it is the persistent agent session).
// - Each scratch tab has a close (×) button that calls onCloseTab.
// - The active tab is highlighted with bg-accent text-accent-foreground.
//
// Accessibility: tabs use role="tab", strip uses role="tablist".

import { Terminal as TerminalIcon, X } from 'lucide-react';

export interface ScratchTab {
  scratchId: string;
}

interface PaneTabStripProps {
  /** The main session id (always present, never closable). */
  mainSessionId: string;
  /** Active tab identifier: either the mainSessionId or a scratchId. */
  activeTabId: string;
  /** Ordered list of currently open scratch sub-tabs. */
  scratchTabs: ScratchTab[];
  /** Called when the user clicks a tab to switch to it. */
  onSwitchTab: (tabId: string) => void;
  /** Called when the user clicks × on a scratch tab. */
  onCloseTab: (scratchId: string) => void;
}

export function PaneTabStrip({
  mainSessionId,
  activeTabId,
  scratchTabs,
  onSwitchTab,
  onCloseTab,
}: PaneTabStripProps) {
  return (
    <div
      role="tablist"
      aria-label="Pane sub-tabs"
      data-testid="pane-tab-strip"
      className="flex shrink-0 items-center overflow-x-auto border-b border-border/60 bg-card/80 text-xs"
    >
      {/* Main session tab */}
      <button
        role="tab"
        aria-selected={activeTabId === mainSessionId}
        data-testid="pane-tab-main"
        onClick={() => onSwitchTab(mainSessionId)}
        className={[
          'flex items-center gap-1.5 px-3 py-1.5 select-none',
          'border-r border-border/40 transition-colors',
          activeTabId === mainSessionId
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
        ].join(' ')}
      >
        <TerminalIcon className="h-3 w-3 shrink-0" />
        <span>main</span>
      </button>

      {/* Scratch sub-tabs */}
      {scratchTabs.map((tab, idx) => (
        <div
          key={tab.scratchId}
          role="tab"
          aria-selected={activeTabId === tab.scratchId}
          data-testid={`pane-tab-scratch-${tab.scratchId}`}
          className={[
            'flex items-center gap-1 border-r border-border/40 transition-colors',
            activeTabId === tab.scratchId
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
          ].join(' ')}
        >
          <button
            onClick={() => onSwitchTab(tab.scratchId)}
            className="flex items-center gap-1.5 py-1.5 pl-3 pr-1 select-none"
          >
            <TerminalIcon className="h-3 w-3 shrink-0" />
            <span>scratch {idx + 1}</span>
          </button>
          <button
            aria-label={`Close scratch ${idx + 1}`}
            data-testid={`pane-tab-close-${tab.scratchId}`}
            onClick={() => onCloseTab(tab.scratchId)}
            className="mr-1 rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
