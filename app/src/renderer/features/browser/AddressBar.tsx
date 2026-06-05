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
// v1.5.1-A: normalizeUrl extracted to normalizeUrl.ts (react-refresh rule
// requires non-component exports in their own file).
import { normalizeUrl } from './normalizeUrl';

export interface AddressBarProps {
  url: string;
  /** Gates back/forward/reload/stop/home nav buttons. URL input is always enabled (DEV-3). */
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
        aria-label="Back"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onForward}
        title="Forward"
        aria-label="Forward"
      >
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onReload}
        title="Reload"
        aria-label="Reload"
      >
        <RotateCw className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onStop}
        title="Stop"
        aria-label="Stop"
      >
        <Square className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        onClick={onHome}
        title="Home"
        aria-label="Home"
      >
        <Home className="h-4 w-4" aria-hidden />
      </Button>
      <input
        type="text"
        spellCheck={false}
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
