// Address bar for the Browser room.
//
// - URL input with editable text + Enter-to-go.
// - Back / Forward / Reload / Stop / Home buttons.
// - Submitting an obviously-not-URL string ("hello world") falls back to a
//   Google search query so an empty browser address bar doesn't dead-end.

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Home, RotateCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DesignOverlayToggle } from './DesignOverlay';

export interface AddressBarProps {
  url: string;
  disabled?: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onHome: () => void;
  /** V3-W14-001 — workspace + active tab id for the Design picker toggle. */
  workspaceId?: string;
  activeTabId?: string | null;
  onDesignActiveChange?: (active: boolean) => void;
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return 'about:blank';
  if (t.startsWith('about:') || t.startsWith('chrome:') || t.startsWith('file:')) return t;
  if (/^https?:\/\//i.test(t)) return t;
  // Heuristic: looks like a domain or path → prepend https://
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(t) || t.startsWith('localhost')) {
    return 'https://' + t;
  }
  // Otherwise treat as a Google query.
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}

export function AddressBar({
  url,
  disabled,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onHome,
  workspaceId,
  activeTabId,
  onDesignActiveChange,
}: AddressBarProps) {
  const [value, setValue] = useState(url);
  useEffect(() => {
    queueMicrotask(() => setValue(url));
  }, [url]);

  return (
    <div className="flex items-center gap-1 border-b border-border bg-card/40 px-2 py-1.5">
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onBack}
        title="Back"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onForward}
        title="Forward"
      >
        <ArrowRight className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onReload}
        title="Reload"
      >
        <RotateCw className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onStop}
        title="Stop"
      >
        <Square className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onHome}
        title="Home"
      >
        <Home className="h-4 w-4" />
      </Button>
      <input
        type="text"
        spellCheck={false}
        disabled={disabled}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const target = normalizeUrl(value);
            onNavigate(target);
          }
        }}
        placeholder="Enter URL or search…"
        className="ml-2 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
      {workspaceId ? (
        <DesignOverlayToggle
          workspaceId={workspaceId}
          tabId={activeTabId ?? null}
          onActiveChange={onDesignActiveChange}
        />
      ) : null}
    </div>
  );
}
