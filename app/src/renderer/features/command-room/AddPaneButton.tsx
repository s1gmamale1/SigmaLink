// v1.5.3-A — Extract AddPaneButton from CommandRoom.
//
// Owns:
//   - The +Pane button (Plus icon + chevron DropdownMenu)
//   - `disabledReason` derivation (no workspace / swarms loading / swarm paused / 20-pane cap)
//   - Always-visible inline reason pill (data-testid="add-pane-disabled-reason")
//   - Persistent error chip (data-testid="add-pane-error-chip", 10s timer, dismiss ×, unmount cleanup)
//   - addPane() → rpc.swarms.addAgent (creates a default swarm first if none exists)
//
// Layout note: this component renders a `relative` wrapper so the error chip
// can be positioned absolutely below the toolbar bar without disturbing the
// flex row layout in CommandRoom's top bar.

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch } from '@/renderer/app/state';
import type { Swarm, Workspace } from '@/shared/types';

// v1.13.1 — derive the human-readable reason why "+ Pane" is disabled.
//
// Three-tier logic:
//   1. No workspace open         → "Open or create a workspace first"
//      (the ONLY case this exact message fires)
//   2. Workspace open, swarms
//      still loading            → "Loading workspace…" (transient, accurate)
//   3. Workspace + swarm ready,
//      swarm not running        → pause / cap messages
//   4. Everything OK             → null (button enabled)
//
// Returns `null` during the in-flight `adding` window — the dropdown is
// closing anyway and flashing a reason would be noise.
function getAddPaneDisabledReason(
  activeWorkspace: Workspace | null,
  activeSwarm: Swarm | null,
  swarmsLoading: boolean,
  adding: boolean,
): string | null {
  if (adding) return null;
  if (!activeWorkspace) return 'Open or create a workspace first';
  if (swarmsLoading) return 'Loading workspace…';
  // No swarm yet but workspace exists → allow; addPane() will create one.
  if (!activeSwarm) return null;
  if (activeSwarm.status !== 'running') {
    return 'Swarm is paused — resume it to add panes';
  }
  if (activeSwarm.agents.length >= 20) {
    return `Maximum 20 panes per swarm (current: ${activeSwarm.agents.length})`;
  }
  return null;
}

export interface AddPaneButtonProps {
  /** The active workspace — null means no workspace is open. */
  activeWorkspace: Workspace | null;
  activeSwarm: Swarm | null;
  /** True while rpc.swarms.list for the active workspace is still in flight. */
  swarmsLoading: boolean;
  providers: { id: string; name: string }[];
}

export function AddPaneButton({
  activeWorkspace,
  activeSwarm,
  swarmsLoading,
  providers,
}: AddPaneButtonProps) {
  const dispatch = useAppDispatch();
  const [adding, setAdding] = useState(false);
  // DOGFOOD-V1.4.2-01 hypothesis 3 — persistent error chip for ~10s after
  // addAgentToSwarm rejects.
  const [lastAddError, setLastAddError] = useState<string | null>(null);
  const lastAddErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DOGFOOD-V1.4.2-01 — clear the error-chip timer on unmount.
  useEffect(() => {
    return () => {
      if (lastAddErrorTimerRef.current !== null) {
        clearTimeout(lastAddErrorTimerRef.current);
      }
    };
  }, []);

  const disabledReason = getAddPaneDisabledReason(activeWorkspace, activeSwarm, swarmsLoading, adding);

  async function addPane(providerId: string): Promise<void> {
    if (!activeWorkspace || adding) return;
    setAdding(true);
    try {
      // v1.13.1 — when a workspace is active but no swarm exists yet (e.g. the
      // user opened the workspace before the swarm wizard ran), create a minimal
      // default swarm before adding the agent. `swarms.create` with an empty
      // roster simply provisions the swarm row; `addAgent` will attach the pane.
      let targetSwarmId: string;
      if (activeSwarm) {
        targetSwarmId = activeSwarm.id;
      } else {
        const newSwarm = await rpc.swarms.create({
          workspaceId: activeWorkspace.id,
          mission: 'Default swarm',
          preset: 'custom',
          roster: [],
        });
        dispatch({ type: 'UPSERT_SWARM', swarm: newSwarm });
        targetSwarmId = newSwarm.id;
      }
      const result = await rpc.swarms.addAgent({ swarmId: targetSwarmId, providerId });
      dispatch({ type: 'UPSERT_SWARM', swarm: result.swarm });
      dispatch({ type: 'ADD_SESSIONS', sessions: [result.session] });
      dispatch({ type: 'SET_ACTIVE_SESSION', id: result.sessionId });
      toast.success(`Added ${result.agentKey}`, {
        description: `Pane ${result.paneIndex + 1}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Could not add pane', { description: msg });
      // DOGFOOD-V1.4.2-01 hypothesis 3 — persist the error inline for ~10s
      // so users on a busy screen have a non-transient record of the failure.
      if (lastAddErrorTimerRef.current !== null) {
        clearTimeout(lastAddErrorTimerRef.current);
      }
      setLastAddError(msg);
      lastAddErrorTimerRef.current = setTimeout(() => {
        setLastAddError(null);
        lastAddErrorTimerRef.current = null;
      }, 10_000);
    } finally {
      setAdding(false);
    }
  }

  return (
    // relative wrapper so the error chip can absolute-position below the toolbar
    // without disturbing the parent flex row height.
    <div className="relative flex items-center gap-2">
      <DropdownMenu>
        {disabledReason ? (
          // v1.2.5 Step 3 — when disabled, surface the reason via tooltip.
          // DOGFOOD-V1.4.2-01 hypothesis 1 — tooltip kept for a11y; inline
          // pill gives immediate visibility without requiring hover.
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="ml-1 inline-flex">
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      className="h-7 gap-1 px-2 text-xs"
                    >
                      <Plus className="h-3.5 w-3.5" /> Pane
                    </Button>
                  </DropdownMenuTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{disabledReason}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={adding}
              className="ml-1 h-7 gap-1 px-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" /> Pane
            </Button>
          </DropdownMenuTrigger>
        )}
        <DropdownMenuContent align="start">
          {providers.map((provider) => (
            <DropdownMenuItem
              key={provider.id}
              onClick={() => void addPane(provider.id)}
              disabled={adding}
            >
              {provider.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* DOGFOOD-V1.4.2-01 hypothesis 1 — always-visible inline reason pill.
          aria-live="polite" + role="status": SR announces the reason when
          it changes (no-workspace → paused → cap) without interrupting
          current speech. */}
      {disabledReason && (
        <span
          data-testid="add-pane-disabled-reason"
          aria-live="polite"
          role="status"
          className="text-[10px] italic text-muted-foreground/80"
        >
          {disabledReason}
        </span>
      )}
      {/* DOGFOOD-V1.4.2-01 hypothesis 3 — persistent inline error chip.
          absolute-positioned below the toolbar so it doesn't alter the
          flex-row height (Option B: chip floats over content rather than
          pushing it down; this avoids layout shifts in the parent flex row
          while keeping the error immediately visible beneath the toolbar).
          aria-live="assertive" + role="alert": errors interrupt current SR
          speech so the user is notified immediately. */}
      {lastAddError && (
        <div
          data-testid="add-pane-error-chip"
          aria-live="assertive"
          role="alert"
          className="absolute left-0 right-0 top-full z-10 flex items-center gap-1.5 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive"
        >
          <span className="flex-1 truncate">{lastAddError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            className="ml-1 shrink-0 opacity-70 hover:opacity-100"
            onClick={() => {
              if (lastAddErrorTimerRef.current !== null) {
                clearTimeout(lastAddErrorTimerRef.current);
                lastAddErrorTimerRef.current = null;
              }
              setLastAddError(null);
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
