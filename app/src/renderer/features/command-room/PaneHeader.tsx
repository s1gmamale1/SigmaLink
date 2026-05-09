// V3-W13-003: per-pane top-bar chrome.
//
// Shows the close button + git branch + status dot + provider color stripe.
// The color stripe is the 1px accent line at the top of the pane that uses
// the provider's brand color (from `AGENT_PROVIDERS`). It mirrors the V3
// frames where each pane's chrome is tinted by its provider's identity.

import { Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { findProvider } from '@/shared/providers';
import type { AgentSession } from '@/shared/types';

interface Props {
  session: AgentSession;
  onRemove: () => void;
  onStop: () => void;
}

export function PaneHeader({ session, onRemove, onStop }: Props) {
  const exited = session.status === 'exited';
  const errored = session.status === 'error';
  const dotColor = errored ? '#ef4444' : exited ? '#9ca3af' : '#22c55e';
  const provider = findProvider(session.providerId);
  const providerColor = provider?.color ?? '#6b7280';
  const providerName = provider?.name ?? session.providerId.toUpperCase();
  const branch = session.branch ?? 'dev';
  return (
    // `z-20` lifts the chrome above the PaneSplash overlay (z-10) so the
    // close/stop buttons stay clickable while the boot splash is rendered.
    <div className="relative z-20">
      {/* Provider color stripe — 2px accent at top */}
      <div
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ background: providerColor }}
        aria-hidden="true"
      />
      <div className="flex h-7 items-center gap-2 border-b border-border px-2 pt-[2px] text-[11px]">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: dotColor }}
          aria-label={`status: ${session.status}`}
        />
        <span className="font-medium uppercase tracking-wider" style={{ color: providerColor }}>
          {providerName}
        </span>
        <span
          className="truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          title={branch}
        >
          {branch}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={onStop}
            disabled={exited || errored}
            aria-label="Stop session"
            title="Stop session"
          >
            <Square className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={onRemove}
            aria-label="Remove pane"
            title="Remove pane"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
