// V3-W14-001 — Design-mode overlay UI bits. Renders the toggle pill that
// the AddressBar embeds + a translucent banner across the BrowserViewMount
// while picker mode is active. The actual hover/click overlay lives inside
// the WebContentsView, injected by the main-process picker runtime.

import { useEffect, useState } from 'react';
import { MousePointerSquareDashed, X } from 'lucide-react';
import { rpc, onEvent } from '@/renderer/lib/rpc';
import { cn } from '@/lib/utils';

interface PickerStatePayload {
  workspaceId: string;
  tabId: string;
  active: boolean;
}

export interface DesignOverlayProps {
  workspaceId: string;
  tabId: string | null;
  /** Optional: parent surface uses this to hide / collapse the recents pane. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Toggle pill for the AddressBar. Calls `design.startPick` / `design.stopPick`
 * and listens to `design:picker-state` so the pill stays in sync if a sibling
 * window flips picker mode.
 */
export function DesignOverlayToggle({
  workspaceId,
  tabId,
  onActiveChange,
}: DesignOverlayProps) {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = onEvent<PickerStatePayload>('design:picker-state', (p) => {
      if (!p || p.workspaceId !== workspaceId) return;
      if (tabId && p.tabId !== tabId) return;
      setActive(p.active);
      onActiveChange?.(p.active);
    });
    return () => off();
  }, [workspaceId, tabId, onActiveChange]);

  // V3-W14-001 — switching tabs invalidates the picker state. We fire the
  // reset on the next tick so the effect body is purely a subscriber: react-
  // hooks/set-state-in-effect refuses synchronous state updates here.
  useEffect(() => {
    const id = setTimeout(() => {
      setActive(false);
      onActiveChange?.(false);
    }, 0);
    return () => clearTimeout(id);
  }, [tabId, onActiveChange]);

  async function toggle() {
    if (!tabId || busy) return;
    setBusy(true);
    try {
      if (active) {
        await rpc.design.stopPick({ workspaceId, tabId });
        setActive(false);
        onActiveChange?.(false);
      } else {
        await rpc.design.startPick({ workspaceId, tabId });
        setActive(true);
        onActiveChange?.(true);
      }
    } catch {
      /* surfaced as an rpc toast */
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!tabId || busy}
      title={active ? 'Stop element picker' : 'Activate Design Tool'}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase tracking-wider transition',
        active
          ? 'border-blue-500/60 bg-blue-500/15 text-blue-200 shadow-[0_0_0_1px_rgba(59,130,246,0.3)]'
          : 'border-border bg-card/40 text-muted-foreground hover:border-blue-500/40 hover:bg-blue-500/5 hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {active ? <X className="h-3.5 w-3.5" /> : <MousePointerSquareDashed className="h-3.5 w-3.5" />}
      <span>Design</span>
    </button>
  );
}

/**
 * Renders a small banner across the top of the browser viewport while picker
 * mode is on. Pure presentational — `active` flows in from the AddressBar's
 * toggle (or any direct `onActiveChange` consumer).
 */
export function DesignOverlayBanner({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md bg-blue-500/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white shadow-lg">
      Design picker on · click an element · Esc to cancel
    </div>
  );
}
