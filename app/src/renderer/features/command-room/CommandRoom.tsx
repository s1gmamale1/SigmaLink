// V3-W13-003 / V3-W13-004 / v1.1.4 Step 4: Command Room — multi-pane grid.
//
// Renders the per-workspace agent sessions inside a generic <GridLayout>.
// Each cell stacks: PaneHeader (single h-7 strip) · (PaneSplash overlay +
// SessionTerminal) · PaneFooter. The grid honours the launcher's preset
// shape (1/2/3×3/4/6/8/9/10/12) and supports per-cell drag resize plus
// Cmd+Alt+<N> focus jumps. The legacy PaneStatusStrip was collapsed into
// PaneHeader's provider-name tooltip; Stop moves to the right-click menu.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Terminal as TerminalIcon } from 'lucide-react';
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
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { WorktreeInfoBanner } from '@/renderer/components/WorktreeInfoBanner';
import { GridLayout } from './GridLayout';
import { PaneShell } from './PaneShell';
import { SplitGroupCell } from './SplitGroupCell';
import type { AgentSession, Swarm } from '@/shared/types';

const EMPTY_SESSIONS: AgentSession[] = [];
const EMPTY_SWARMS: Swarm[] = [];

// v1.4.3 #06 — Pane Split. Each entry in the GridLayout corresponds to ONE
// grid cell. A standalone pane occupies its own cell; the two halves of a
// split share a cell and render as a sub-grid. We pre-group sessions into
// these cells so GridLayout itself stays generic and unaware of the split
// model — `renderCell` knows how to lay out either case.
type SessionCell = AgentSession[];

function groupSessionsIntoCells(sessions: AgentSession[]): SessionCell[] {
  const cells: SessionCell[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    if (s.splitGroupId) {
      const group = sessions
        .filter((other) => other.splitGroupId === s.splitGroupId)
        .sort((a, b) => (a.splitIndex ?? 0) - (b.splitIndex ?? 0));
      for (const g of group) seen.add(g.id);
      cells.push(group);
    } else {
      seen.add(s.id);
      cells.push([s]);
    }
  }
  return cells;
}

// v1.2.5 Step 3 — derive the human-readable reason why "+ Pane" is disabled.
// Returns `null` when the button is either enabled OR mid-flight (no tooltip
// during the in-flight `adding` window — the dropdown is closing anyway and
// flashing a reason would be noise). Keep this in lock-step with the
// `disabled` prop on the trigger so a user-visible reason never falls out of
// sync with the actual disable logic.
function getAddPaneDisabledReason(
  activeSwarm: Swarm | null,
  adding: boolean,
): string | null {
  if (adding) return null;
  if (!activeSwarm) return 'Open or create a workspace first';
  if (activeSwarm.status !== 'running') {
    return 'Swarm is paused — resume it to add panes';
  }
  if (activeSwarm.agents.length >= 20) {
    return `Maximum 20 panes per swarm (current: ${activeSwarm.agents.length})`;
  }
  return null;
}

export function CommandRoom() {
  const dispatch = useAppDispatch();
  const activeWorkspace = useAppStateSelector((state) => state.activeWorkspace);
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const activeSessionId = useAppStateSelector((state) => state.activeSessionId);
  const activeSwarmId = useAppStateSelector((state) => state.activeSwarmId);
  // v1.4.2 packet-12 — non-null when a pane is rendered fullscreen.
  const focusedPaneId = useAppStateSelector((state) => state.focusedPaneId);
  const sessions = useAppStateSelector((state) =>
    activeWorkspaceId ? state.sessionsByWorkspace[activeWorkspaceId] ?? EMPTY_SESSIONS : EMPTY_SESSIONS,
  );
  const workspaceSwarms = useAppStateSelector((state) =>
    activeWorkspaceId ? state.swarmsByWorkspace[activeWorkspaceId] ?? EMPTY_SWARMS : EMPTY_SWARMS,
  );
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [showWorktreeBanner, setShowWorktreeBanner] = useState(true);
  // DOGFOOD-V1.4.2-01 hypothesis 3 — persistent error chip for ~10s after
  // addAgentToSwarm rejects. The toast remains for screen-reader visibility;
  // this chip is the persistent inline record.
  const [lastAddError, setLastAddError] = useState<string | null>(null);
  const lastAddErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSwarm = useMemo(() => {
    if (!activeWorkspace) return null;
    const selected = activeSwarmId
      ? workspaceSwarms.find((s) => s.id === activeSwarmId)
      : null;
    return selected ?? workspaceSwarms.find((s) => s.status === 'running') ?? null;
  }, [activeSwarmId, activeWorkspace, workspaceSwarms]);

  // v1.2.5 Step 3 — `null` when "+ Pane" is enabled; otherwise the reason
  // surfaced via tooltip on hover so the disabled button stops looking broken.
  const disabledReason = getAddPaneDisabledReason(activeSwarm, adding);

  useEffect(() => {
    let alive = true;
    void rpc.providers
      .list()
      .then((list) => {
        if (alive) setProviders(list.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let alive = true;
    void rpc.swarms
      .list(activeWorkspaceId)
      .then((list) => {
        if (!alive) return;
        for (const swarm of list) {
          dispatch({ type: 'UPSERT_SWARM', swarm });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [activeWorkspaceId, dispatch]);

  // v1.4.3 #06 — Group sessions into grid cells. Standalone panes get one
  // cell each; the two halves of a split share a cell (rendered as a
  // sub-grid). Computed off the raw sessions list so we always reflect the
  // latest state.sessionsByWorkspace projection.
  const cells = useMemo(() => groupSessionsIntoCells(sessions), [sessions]);

  // BUG-V1.1-04-IPC / v1.4.3 #06 — activeIndex indexes into `cells`, not raw
  // sessions. Falls back to 0 when activeSessionId isn't in this workspace.
  const activeIndex = useMemo(() => {
    if (cells.length === 0) return 0;
    if (!activeSessionId) return 0;
    const idx = cells.findIndex((cell) =>
      cell.some((s) => s.id === activeSessionId),
    );
    return idx >= 0 ? idx : 0;
  }, [cells, activeSessionId]);

  // Reconcile the global active session with the local pane list. If the
  // current activeSessionId is missing from this workspace's sessions, point
  // it at the first pane so the focus ring lands somewhere coherent.
  useEffect(() => {
    if (sessions.length === 0) return;
    const inList = activeSessionId
      ? sessions.some((s) => s.id === activeSessionId)
      : false;
    if (!inList) {
      dispatch({ type: 'SET_ACTIVE_SESSION', id: sessions[0]!.id });
    }
  }, [sessions, activeSessionId, dispatch]);

  // BUG-V1.1-04-IPC — cross-pane focus sync via sigma:pty-focus events.
  useEffect(() => {
    const onFocusReq = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || typeof detail.sessionId !== 'string') return;
      const target = detail.sessionId;
      if (!sessions.some((s) => s.id === target)) return;
      if (activeSessionId === target) return;
      dispatch({ type: 'SET_ACTIVE_SESSION', id: target });
    };
    window.addEventListener('sigma:pty-focus', onFocusReq);
    return () => window.removeEventListener('sigma:pty-focus', onFocusReq);
  }, [sessions, activeSessionId, dispatch]);

  // v1.4.2 packet-12 — global Esc exits fullscreen when a pane is focused.
  useEffect(() => {
    if (!focusedPaneId) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      dispatch({ type: 'UNFOCUS_PANE' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedPaneId, dispatch]);

  // DOGFOOD-V1.4.2-01 — clear the error-chip timer on unmount.
  useEffect(() => {
    return () => {
      if (lastAddErrorTimerRef.current !== null) {
        clearTimeout(lastAddErrorTimerRef.current);
      }
    };
  }, []);

  // v1.4.4 P6 — dev-only empty-state diagnostic (mount-only).
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && sessions.length === 0 && activeWorkspace) {
      console.warn(
        '[CommandRoom] Empty state — workspace activated but sessions slice empty. ' +
          'Either user just landed on a fresh workspace, OR rehydration failed.',
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={TerminalIcon}
        title="Open a workspace first"
        description="The Command Room shows live agent terminals once a workspace is launched."
      />
    );
  }
  if (sessions.length === 0) {
    // v1.4.3 #05 — defense-in-depth UX. The actual rehydration fix lives in
    // packet #02; this branch surfaces an inline "Add first pane" affordance
    // so a user who lands on a fresh / freshly-rehydrated workspace doesn't
    // have to walk back through Workspaces → Launcher → grid wizard just to
    // recover. Only shown when the swarm is running AND providers loaded;
    // otherwise we fall back to the legacy "Go to Workspaces" CTA only so
    // the click can't dead-end.
    const canAddPane = activeSwarm?.status === 'running' && providers.length > 0;
    return (
      <EmptyState
        icon={TerminalIcon}
        title="No agents launched yet"
        description={
          canAddPane
            ? 'Add your first pane below, or go back to Workspaces to pick a grid preset.'
            : 'Head back to the Workspaces room to pick a grid preset and launch.'
        }
        action={
          <div className="flex gap-2">
            {canAddPane ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void addPane(providers[0]!.id)}
                disabled={adding}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add first pane
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}
            >
              Go to Workspaces
            </Button>
          </div>
        }
      />
    );
  }

  function handleRemove(session: AgentSession) {
    if (session.status !== 'error') {
      void rpc.pty.kill(session.id).catch(() => undefined);
    }
    dispatch({ type: 'REMOVE_SESSION', id: session.id });
  }

  function handleStop(session: AgentSession) {
    void rpc.pty.kill(session.id).catch(() => undefined);
  }

  async function addPane(providerId: string): Promise<void> {
    if (!activeSwarm || adding) return;
    setAdding(true);
    try {
      const result = await rpc.swarms.addAgent({ swarmId: activeSwarm.id, providerId });
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

  // v1.4.3 #06 — SPLIT_PANE dispatch annotates parent + child in one render pass.
  async function handleSplitPane(
    parent: AgentSession,
    direction: 'horizontal' | 'vertical',
    providerId: string,
  ): Promise<void> {
    try {
      const newSession = await rpc.swarms.splitPane({
        paneId: parent.id,
        direction,
        provider: providerId,
      });
      const groupId = newSession.splitGroupId;
      if (!groupId) {
        // Defensive fallback — controller should always return annotated session.
        dispatch({ type: 'ADD_SESSIONS', sessions: [newSession] });
        return;
      }
      dispatch({
        type: 'SPLIT_PANE',
        parentId: parent.id,
        newSession,
        groupId,
        direction,
      });
      toast.success(`Split pane ${direction}`, {
        description: `Added ${providerId}`,
      });
    } catch (err) {
      toast.error('Could not split pane', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // v1.4.3 #06 — Optimistic minimise with RPC revert on failure.
  function handleToggleMinimise(session: AgentSession): void {
    const next = !session.minimised;
    dispatch({ type: 'MINIMISE_PANE', paneId: session.id, minimised: next });
    void rpc.swarms.minimisePane({ paneId: session.id, minimised: next }).catch((err) => {
      dispatch({ type: 'MINIMISE_PANE', paneId: session.id, minimised: !next }); // revert
      toast.error('Could not minimise pane', {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-xs">
        <div className="font-medium">{activeWorkspace.name}</div>
        <span className="text-muted-foreground">·</span>
        <div className="text-muted-foreground">
          {sessions.length} {sessions.length === 1 ? 'agent' : 'agents'}
        </div>
        <DropdownMenu>
          {disabledReason ? (
            // v1.2.5 Step 3 — when disabled, surface the reason via tooltip.
            // DOGFOOD-V1.4.2-01 hypothesis 1 — the tooltip (200ms hover delay)
            // is kept for screen-reader / keyboard users, but we ALSO render
            // an always-visible inline pill so the reason is immediately clear
            // without requiring a hover interaction.
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
        {/* DOGFOOD-V1.4.2-01 hypothesis 1 — always-visible inline reason pill
            shown whenever the +Pane button is disabled. Replaces the
            invisible-until-hover tooltip behaviour so the user immediately
            understands why clicking the button does nothing. */}
        {disabledReason && (
          <span
            data-testid="add-pane-disabled-reason"
            className="text-[10px] italic text-muted-foreground/80"
          >
            {disabledReason}
          </span>
        )}
        <div className="ml-auto text-[10px] text-muted-foreground/70">
          ⌘⌥&lt;N&gt; to focus pane
        </div>
      </div>
      {/* DOGFOOD-V1.4.2-01 hypothesis 3 — persistent inline error chip shown
          for ~10s after addAgentToSwarm rejects. The toast is still fired for
          momentary / screen-reader visibility; this chip is the non-transient
          record that survives the toast's auto-dismiss. */}
      {lastAddError && (
        <div
          data-testid="add-pane-error-chip"
          className="flex items-center gap-1.5 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive"
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
      {showWorktreeBanner && sessions.length > 0 && (
        <WorktreeInfoBanner onDismiss={() => setShowWorktreeBanner(false)} />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <GridLayout<SessionCell>
          items={cells}
          getKey={(cell) => cell[0]!.id}
          activeIndex={activeIndex}
          onActiveChange={(i) => {
            const cell = cells[i];
            if (!cell) return;
            // v1.4.3 #06 — When the active cell is a split group, pick the
            // sub-pane the user already had focused (so a click on the cell
            // background doesn't yank focus between the two halves). Falls
            // back to the first sub-pane if neither is currently active.
            const inCell = cell.find((s) => s.id === activeSessionId);
            const target = inCell ?? cell[0]!;
            if (activeSessionId !== target.id) {
              dispatch({ type: 'SET_ACTIVE_SESSION', id: target.id });
            }
          }}
          focusedKey={focusedPaneId}
          renderCell={(cell, ctx) => {
            // v1.4.3 #06 — A "cell" is either a single standalone pane or
            // the two halves of a split group. The split sub-grid is
            // rendered inline here so it stays scoped to one grid cell;
            // GridLayout's outer divider math is unaffected.
            if (cell.length === 1) {
              const session = cell[0]!;
              return (
                <PaneShell
                  session={session}
                  paneIndex={ctx.index + 1}
                  providers={providers}
                  workspaceRootPath={activeWorkspace.rootPath}
                  onFocus={() => ctx.activate()}
                  onRemove={() => handleRemove(session)}
                  onStop={() => handleStop(session)}
                  onSplit={(dir, providerId) =>
                    void handleSplitPane(session, dir, providerId)
                  }
                  onToggleMinimise={() => handleToggleMinimise(session)}
                  isFullscreen={focusedPaneId === session.id}
                  onToggleFullscreen={() =>
                    dispatch(
                      focusedPaneId === session.id
                        ? { type: 'UNFOCUS_PANE' }
                        : { type: 'FOCUS_PANE', paneId: session.id },
                    )
                  }
                />
              );
            }
            return (
              <SplitGroupCell
                panes={cell}
                paneIndex={ctx.index + 1}
                providers={providers}
                focusedPaneId={focusedPaneId}
                workspaceRootPath={activeWorkspace.rootPath}
                onActivate={(id) => {
                  if (activeSessionId !== id) {
                    dispatch({ type: 'SET_ACTIVE_SESSION', id });
                  }
                }}
                onRemove={handleRemove}
                onStop={handleStop}
                onToggleMinimise={handleToggleMinimise}
                onToggleFullscreen={(id) =>
                  dispatch(
                    focusedPaneId === id
                      ? { type: 'UNFOCUS_PANE' }
                      : { type: 'FOCUS_PANE', paneId: id },
                  )
                }
              />
            );
          }}
        />
      </div>
    </div>
  );
}
