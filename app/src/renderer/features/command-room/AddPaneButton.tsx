// v1.5.3-A — Extract AddPaneButton from CommandRoom.
//
// Owns:
//   - The +Pane button (Plus icon + chevron DropdownMenu)
//   - `disabledReason` derivation (no workspace / swarms loading / swarm paused / 20-pane cap)
//   - Always-visible inline reason pill (data-testid="add-pane-disabled-reason")
//   - Persistent error chip (data-testid="add-pane-error-chip", 10s timer, dismiss ×, unmount cleanup)
//   - addPane() → rpc.swarms.addAgent (creates a default swarm first if none exists)
//   - SF-8 B3: Yolo/Bypass toggle with per-workspace kv default
//   - DEV-W5: "Plain terminal" entry (providerId:'shell') + per-add "Create in worktree" toggle
//
// Layout note: this component renders a `relative` wrapper so the error chip
// can be positioned absolutely below the toolbar bar without disturbing the
// flex row layout in CommandRoom's top bar.

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { worktreeModeKey } from '@/shared/worktree-mode';
import type { AgentRuntimeProfileId } from '@/shared/runtime-profiles';
import {
  parseRamBrakeAdmissionError,
  summarizeRamBrakeAdmission,
  type RamBrakeAdmissionDetails,
} from '@/shared/ram-brake';

/** SF-8 B3 — Per-workspace Yolo default kv key (mirrors Launcher.tsx). */
function yoloKvKey(workspaceId: string): string {
  return `pane.autoApprove.default.${workspaceId}`;
}

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
  if (activeSwarm.status === 'completed') {
    return 'Swarm has ended — start a new swarm to add panes';
  }
  // Spec 2026-06-10 (D): other non-running states (janitor 'failed', legacy
  // 'paused') no longer gate the button — addPane() auto-resumes on click.
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
  const [ramBrakePrompt, setRamBrakePrompt] = useState<{
    providerId: string;
    targetSwarmId: string;
    details: RamBrakeAdmissionDetails;
    queued: boolean;
  } | null>(null);
  // DOGFOOD-V1.4.2-01 hypothesis 3 — persistent error chip for ~10s after
  // addAgentToSwarm rejects.
  const [lastAddError, setLastAddError] = useState<string | null>(null);
  const lastAddErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * SF-8 B3 — Yolo/Bypass per-pane toggle. Mirrors the Launcher's toggle but
   * scoped to the single pane the +Pane dropdown adds. Initialised from the
   * per-workspace kv default; toggling writes it so the next +Pane inherits
   * the choice. Default = false (OFF) when the kv key is absent.
   */
  const [yolo, setYolo] = useState(false);

  /**
   * DEV-W5 — "Create in worktree" toggle. Defaults to the workspace's
   * `worktreeMode` KV setting ('worktree' → true, 'in-place' → false).
   * When true, `skipWorktree=false` is sent to addAgent (force a worktree);
   * when false, `skipWorktree=true` is sent (skip worktree, i.e. in-place).
   * Default = true (create a worktree) when no KV is set.
   */
  const [createWorktree, setCreateWorktree] = useState(true);
  const [browserTools, setBrowserTools] = useState(false);

  // DOGFOOD-V1.4.2-01 — clear the error-chip timer on unmount.
  useEffect(() => {
    return () => {
      if (lastAddErrorTimerRef.current !== null) {
        clearTimeout(lastAddErrorTimerRef.current);
      }
    };
  }, []);

  // SF-8 B3 — Hydrate yolo from the per-workspace kv default on mount /
  // whenever the active workspace changes. The setYolo calls are microtask-
  // deferred (via async/await) to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!activeWorkspace) {
        if (alive) setYolo(false);
        return;
      }
      // Fail-safe: if the kv RPC is unavailable, default Yolo OFF (the try/catch
      // also guards `rpc.kv` being undefined, not just a rejected get()).
      let raw: string | null = null;
      try {
        raw = await rpc.kv.get(yoloKvKey(activeWorkspace.id));
      } catch {
        raw = null;
      }
      if (alive) setYolo(raw === '1');
    })();
    return () => {
      alive = false;
    };
  }, [activeWorkspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // DEV-W5 — Hydrate createWorktree from the workspace's worktreeMode KV on
  // mount / workspace change. 'worktree' (or absent) → true; 'in-place' → false.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!activeWorkspace) {
        if (alive) setCreateWorktree(true);
        return;
      }
      let raw: string | null = null;
      try {
        raw = await rpc.kv.get(worktreeModeKey(activeWorkspace.id));
      } catch {
        raw = null;
      }
      // 'in-place' → don't create a worktree; anything else → do create one.
      if (alive) setCreateWorktree(raw !== 'in-place');
    })();
    return () => {
      alive = false;
    };
  }, [activeWorkspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** SF-8 B3 — Toggle yolo and persist the per-workspace default. */
  function toggleYolo(): void {
    const next = !yolo;
    setYolo(next);
    if (activeWorkspace) {
      void rpc.kv?.set?.(yoloKvKey(activeWorkspace.id), next ? '1' : '0')?.catch(() => undefined);
    }
  }

  function runtimeProfileForAdd(): AgentRuntimeProfileId {
    return browserTools ? 'browser-tools' : 'ruflo-core';
  }

  const disabledReason = getAddPaneDisabledReason(activeWorkspace, activeSwarm, swarmsLoading, adding);

  async function addPane(
    providerId: string,
    forceRamBrake = false,
    targetSwarmIdOverride?: string,
  ): Promise<void> {
    if (!activeWorkspace || adding) return;
    setAdding(true);
    let targetSwarmIdForPrompt: string | null = targetSwarmIdOverride ?? null;
    try {
      // v1.13.1 — when a workspace is active but no swarm exists yet (e.g. the
      // user opened the workspace before the swarm wizard ran), create a minimal
      // default swarm before adding the agent. `swarms.create` with an empty
      // roster provisions a bare swarm row (backend accepts preset:'custom' +
      // roster:[] as of v1.13.2); `addAgent` then attaches the pane.
      //
      // v1.13.2 — defer the UPSERT_SWARM dispatch until addAgent SUCCEEDS. The
      // v1.13.1 ordering upserted the empty swarm into state BEFORE addAgent
      // resolved, so an addAgent rejection left an orphaned agent-less swarm in
      // the slice. A single UPSERT of the populated `result.swarm` after the
      // await covers both the create-then-add and the existing-swarm cases.
      let targetSwarmId: string;
      if (targetSwarmIdOverride) {
        targetSwarmId = targetSwarmIdOverride;
      } else if (activeSwarm) {
        // Spec 2026-06-10 (D) — auto-resume a non-running swarm on + Pane
        // (symmetric with the auto-CREATE below): the boot janitor can leave
        // a restored swarm 'failed' with no other escape hatch.
        //
        // Gate BOTH the optimistic dispatch and the proceed on resume().ok:
        // if the heal failed (ok:false — DB exception), the real row stays
        // 'failed' and addAgent would be rejected by the backend
        // (factory-add-agent.ts). Throwing here routes into the existing
        // catch → toast.error path and skips the optimistic 'running'
        // dispatch + the doomed addAgent, so local state never diverges from
        // the DB.
        if (activeSwarm.status !== 'running' && activeSwarm.status !== 'completed') {
          const r = await rpc.swarms.resume(activeSwarm.id);
          if (!r.ok) throw new Error('Could not resume swarm — try again');
          dispatch({ type: 'UPSERT_SWARM', swarm: { ...activeSwarm, status: 'running' } });
        }
        targetSwarmId = activeSwarm.id;
      } else {
        const newSwarm = await rpc.swarms.create({
          workspaceId: activeWorkspace.id,
          mission: 'Default swarm',
          preset: 'custom',
          roster: [],
        });
        targetSwarmId = newSwarm.id;
      }
      targetSwarmIdForPrompt = targetSwarmId;
      // SF-8 B3: pass autoApprove so the swarm spawn appends the provider's
      // bypass flag when true (AddAgentToSwarmInput now carries autoApprove).
      // DEV-W5: pass skipWorktree — createWorktree=true → skipWorktree=false
      // (create a worktree); createWorktree=false → skipWorktree=true (in-place).
      const result = await rpc.swarms.addAgent({
        swarmId: targetSwarmId,
        providerId,
        runtimeProfileId: runtimeProfileForAdd(),
        ...(forceRamBrake ? { forceRamBrake: true } : {}),
        autoApprove: yolo,
        skipWorktree: !createWorktree,
      });
      dispatch({ type: 'UPSERT_SWARM', swarm: result.swarm });
      dispatch({ type: 'ADD_SESSIONS', sessions: [result.session] });
      dispatch({ type: 'SET_ACTIVE_SESSION', id: result.sessionId });
      toast.success(`Added ${result.agentKey}`, {
        description: result.paneIndex >= 0 ? `Pane ${result.paneIndex + 1}` : 'Pane added',
      });
      setRamBrakePrompt(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const details = parseRamBrakeAdmissionError(err);
      if (details && !forceRamBrake) {
        if (targetSwarmIdForPrompt) {
          setRamBrakePrompt({
            providerId,
            targetSwarmId: targetSwarmIdForPrompt,
            details,
            queued: false,
          });
          setLastAddError(null);
          return;
        }
        setLastAddError(`RAM Brake held pane: ${summarizeRamBrakeAdmission(details)}`);
        return;
      }
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

  async function forceQueuedAdd(): Promise<void> {
    if (!ramBrakePrompt) return;
    await addPane(ramBrakePrompt.providerId, true, ramBrakePrompt.targetSwarmId);
  }

  return (
    // relative wrapper so the error chip can absolute-position below the toolbar
    // without disturbing the parent flex row height. SF-9: this is a HORIZONTAL
    // row (items-center) — the Yolo toggle lives INSIDE the +Pane dropdown, not
    // as a permanent card here (a flex-col card stretched the toolbar button +
    // overhung the grid, the SF-8 B3 regression).
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
          {/* DEV-W5 — Plain terminal entry: agent-less shell pane via providerId:'shell'. */}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="plain-terminal-item"
            onClick={() => void addPane('shell')}
            disabled={adding}
          >
            Plain terminal
          </DropdownMenuItem>
          {/* SF-8 B3 / SF-9 — Yolo/Bypass toggle lives in the dropdown footer
              (not a permanent toolbar card). onSelect preventDefault so toggling
              it doesn't close the menu. */}
          <DropdownMenuSeparator />
          <div
            className="flex items-start gap-2 px-2 py-1.5 text-[11px]"
            onClick={(e) => e.stopPropagation()}
          >
            <Switch
              id="browser-tools-toggle"
              data-testid="browser-tools-toggle"
              checked={browserTools}
              onCheckedChange={setBrowserTools}
              aria-label="Browser tools — attach Browser MCP and SigmaMemory to this pane"
              aria-checked={browserTools}
              className="mt-0.5 h-3.5 w-6 shrink-0"
            />
            <label htmlFor="browser-tools-toggle" className="max-w-[200px] cursor-pointer">
              <span className="font-semibold text-sky-700 dark:text-sky-300">Browser tools</span>
              <span className="block text-muted-foreground">
                Attaches Browser MCP and SigmaMemory for this pane only.
              </span>
            </label>
          </div>
          {/* DEV-W5 — "Create in worktree" toggle. Default = workspace worktreeMode. */}
          <div
            className="flex items-start gap-2 px-2 py-1.5 text-[11px]"
            onClick={(e) => e.stopPropagation()}
          >
            <Switch
              id="worktree-toggle"
              data-testid="worktree-toggle"
              checked={createWorktree}
              onCheckedChange={setCreateWorktree}
              aria-label="Create in worktree — allocates a fresh git worktree for this pane"
              aria-checked={createWorktree}
              className="mt-0.5 h-3.5 w-6 shrink-0"
            />
            <label htmlFor="worktree-toggle" className="max-w-[200px] cursor-pointer">
              <span className="font-semibold">Create in worktree</span>
              <span className="block text-muted-foreground">
                Allocates a fresh git worktree for this pane. Toggle off for in-place mode.
              </span>
            </label>
          </div>
          <div
            className="flex items-start gap-2 px-2 py-1.5 text-[11px]"
            onClick={(e) => e.stopPropagation()}
          >
            <Switch
              id="yolo-toggle"
              data-testid="yolo-toggle"
              checked={yolo}
              onCheckedChange={toggleYolo}
              aria-label="Yolo / Bypass mode — starts agents with their bypass flag"
              aria-checked={yolo}
              className="mt-0.5 h-3.5 w-6 shrink-0"
            />
            <label htmlFor="yolo-toggle" className="max-w-[200px] cursor-pointer">
              <span className="font-semibold text-amber-600 dark:text-amber-400">Yolo / Bypass</span>
              <span className="block text-muted-foreground">
                Starts agents with their bypass flag — skips the agent's own approval
                prompts. Trusted workspaces only.
              </span>
            </label>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {ramBrakePrompt ? (
        <div
          data-testid="add-pane-ram-brake-prompt"
          role="status"
          aria-live="polite"
          className="absolute left-0 top-full z-20 mt-1 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-md border border-amber-500/40 bg-popover px-3 py-2 text-[11px] shadow-md"
        >
          <div>
            <div className="font-semibold text-amber-700 dark:text-amber-300">
              {ramBrakePrompt.queued ? 'Pane queued by RAM Brake' : 'Pane held by RAM Brake'}
            </div>
            <div className="text-muted-foreground">
              {summarizeRamBrakeAdmission(ramBrakePrompt.details)}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!ramBrakePrompt.queued ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => setRamBrakePrompt((prev) => (prev ? { ...prev, queued: true } : prev))}
              >
                Queue
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => {
                setRamBrakePrompt(null);
                setLastAddError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 bg-amber-600 px-2 text-[11px] text-white hover:bg-amber-700"
              disabled={adding}
              onClick={() => void forceQueuedAdd()}
            >
              Force pane
            </Button>
          </div>
        </div>
      ) : null}
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
