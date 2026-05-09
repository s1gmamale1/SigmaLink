// Agent-driving indicator. When `lockOwner` is non-null, draws a colored ring
// around the browser pane and a chip naming the agent + a "Take Over" button.

import { Hand } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LockOwner } from '@/shared/types';

interface Props {
  lockOwner: LockOwner | null;
  onTakeOver: () => void;
}

export function AgentDrivingIndicator({ lockOwner, onTakeOver }: Props) {
  if (!lockOwner) return null;
  const label = lockOwner.label || lockOwner.agentKey;
  return (
    <>
      {/* Soft glow ring overlay — pointer-events-none so clicks fall through. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-amber-400/60 ring-offset-2 ring-offset-background"
      />
      <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-200 shadow">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
        </span>
        <span>
          <span className="font-medium">{label}</span>
          <span className="ml-1 text-amber-300/80">is driving</span>
        </span>
        <Button size="sm" variant="secondary" onClick={onTakeOver} className="h-6 px-2 text-[11px]">
          <Hand className="mr-1 h-3 w-3" /> Take over
        </Button>
      </div>
    </>
  );
}
