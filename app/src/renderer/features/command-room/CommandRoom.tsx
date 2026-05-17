// V3-W13-003 / V3-W13-004 / v1.1.4 Step 4: Command Room — multi-pane grid.
//
// Renders the per-workspace agent sessions inside a generic <GridLayout>.
// Each cell stacks: PaneHeader (single h-7 strip) · (PaneSplash overlay +
// SessionTerminal) · PaneFooter. The grid honours the launcher's preset
// shape (1/2/3×3/4/6/8/9/10/12) and supports per-cell drag resize plus
// Cmd+Alt+<N> focus jumps. The legacy PaneStatusStrip was collapsed into
// PaneHeader's provider-name tooltip; Stop moves to the right-click menu.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Plus, Square, Terminal as TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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
import { SessionTerminal } from './Terminal';
import { GridLayout } from './GridLayout';
import { PaneHeader } from './PaneHeader';
import { PaneSplash } from './PaneSplash';
import { PaneFooter } from './PaneFooter';
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

  // BUG-V1.1-04-IPC — derive activeIndex from global state.activeSessionId
  // so cross-pane jumps fired by Sigma dispatch echoes (or anywhere else
  // that dispatches SET_ACTIVE_SESSION) update the focus ring + footer
  // metadata without needing a local click. Falls back to 0 when the
  // active id isn't in the current pane list (e.g. workspace just
  // switched, session not yet hydrated).
  //
  // v1.4.3 #06 — `activeIndex` now indexes into `cells` (one entry per grid
  // cell), not into the raw sessions list. A split sub-pane's activeIndex is
  // the index of its parent cell.
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

  // BUG-V1.1-04-IPC — listen for cross-pane focus requests at the room
  // level so the active-index ring + footer metadata sync alongside the
  // xterm focus call in Terminal.tsx. Sigma dispatch echoes fire this
  // event automatically; the prior implementation only updated xterm.
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

  // v1.4.2 packet-12 — global Esc listener gated on focusedPaneId. Mounted
  // only while a pane is fullscreen so the rest of the app (e.g. modals,
  // command palette) keeps receiving Esc events normally when no pane is
  // focused. `keydown` instead of `keyup` so the dispatch fires before the
  // event would otherwise bubble to a focused xterm.
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
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[CommandRoom] Empty state — workspace activated but sessions slice empty. ' +
          'Either user just landed on a fresh workspace, OR rehydration failed.',
      );
    }
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
      toast.error('Could not add pane', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAdding(false);
    }
  }

  // v1.4.3 #06 — Pane Split. Sub-pane shares the parent's worktree (see
  // controller-level worktree-share rationale). The new session is dispatched
  // into state via SPLIT_PANE so the parent + child get their split_group_id
  // annotation in one render pass — avoids the one-frame flash where the
  // child would briefly render as a standalone tile before the next
  // dispatch grouped them.
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
      // The RPC already persisted the split annotation on disk; the reducer
      // dispatch mirrors that into the in-memory sessions list so the
      // renderer's grouping logic sees both halves in one render.
      const groupId = newSession.splitGroupId;
      if (!groupId) {
        // Defensive: the controller always returns the annotated session,
        // but if a build mismatch ever drops it we fall back to a plain
        // session add so the pane at least appears.
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

  // v1.4.3 #06 — Toggle the minimised flag. PTY keeps running; only the
  // rendered chrome shrinks to a header strip. The RPC is fire-and-forget
  // for the success case (state is mirrored locally); on failure we revert
  // the optimistic dispatch.
  function handleToggleMinimise(session: AgentSession): void {
    const next = !session.minimised;
    dispatch({ type: 'MINIMISE_PANE', paneId: session.id, minimised: next });
    void rpc.swarms.minimisePane({ paneId: session.id, minimised: next }).catch((err) => {
      // Revert on RPC failure so the on-disk state and renderer agree.
      dispatch({ type: 'MINIMISE_PANE', paneId: session.id, minimised: !next });
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
            // The <span tabIndex={0}> wrapper is the standard Radix pattern
            // for triggering tooltips on disabled buttons (disabled elements
            // don't fire mouse events). The DropdownMenuTrigger still wraps
            // the Button so the disabled-state styling stays consistent.
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
        <div className="ml-auto text-[10px] text-muted-foreground/70">
          ⌘⌥&lt;N&gt; to focus pane
        </div>
      </div>
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
                <PaneCell
                  session={session}
                  paneIndex={ctx.index + 1}
                  providers={providers}
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

function PaneCell({
  session,
  paneIndex,
  providers,
  onFocus,
  onRemove,
  onStop,
  onSplit,
  onToggleMinimise,
  isFullscreen,
  onToggleFullscreen,
  /**
   * v1.4.3 #06 — When the pane is in a split group, the Split-H/V icons are
   * disabled (max 2-level deep in v1.4.x). The CommandRoom passes this true
   * for sub-panes via `SplitGroupCell`. Defaults to false for the standalone
   * pane case.
   */
  inSplitGroup = false,
}: {
  session: AgentSession;
  paneIndex: number;
  providers: { id: string; name: string }[];
  onFocus: () => void;
  onRemove: () => void;
  onStop: () => void;
  onSplit: (direction: 'horizontal' | 'vertical', providerId: string) => void;
  onToggleMinimise: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  inSplitGroup?: boolean;
}) {
  const errored = session.status === 'error';
  const exited = session.status === 'exited';
  const hasWorktree = !!session.worktreePath;

  function handleReveal() {
    if (!session.worktreePath) return;
    void rpc.app.revealInFolder(session.worktreePath).catch(() => undefined);
  }

  function handleOpenShell() {
    if (!session.worktreePath) return;
    void rpc.app.openShell(session.worktreePath)
      .then(() => toast.success('Terminal opened', { description: session.worktreePath! }))
      .catch((err) => toast.error('Failed to open terminal', { description: err instanceof Error ? err.message : String(err) }));
  }

  // V1.1.4 Step 4 — Stop functionality lives in the right-click context menu
  // now that PaneStatusStrip is gone and the header only carries Close. The
  // ContextMenu wraps just the body so right-clicks on the header chrome
  // (with its own buttons) don't fight Radix for the event.
  //
  // v1.4.3 #06 — A minimised pane collapses to its header strip only (the
  // body is hidden via display:none). The SessionTerminal stays mounted so
  // the terminal-cache (v1.4.2 #03) preserves scrollback and the PTY keeps
  // emitting bytes — clicking the header restores the body view.
  const minimised = !!session.minimised;
  return (
    <div className="sl-pane-enter flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <PaneHeader
        session={session}
        paneIndex={paneIndex}
        providers={providers}
        onFocus={onFocus}
        onClose={onRemove}
        onSplit={onSplit}
        onToggleMinimise={onToggleMinimise}
        canSplit={!inSplitGroup}
        isMinimised={minimised}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            style={minimised ? { display: 'none' } : undefined}
            data-pane-minimised={minimised ? 'true' : undefined}
          >
            <div className="relative min-h-0 flex-1">
              {errored ? (
                <div className="flex h-full flex-col items-start justify-start gap-2 p-3 text-xs">
                  <div className="font-medium text-destructive">Failed to launch</div>
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">
                    {session.error ?? 'unknown error'}
                  </div>
                </div>
              ) : (
                <>
                  <PaneSplash session={session} />
                  <SessionTerminal sessionId={session.id} />
                </>
              )}
            </div>
            <PaneFooter session={session} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={handleReveal} disabled={!hasWorktree}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Reveal worktree in Finder</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleOpenShell} disabled={!hasWorktree}>
            <TerminalIcon className="h-3.5 w-3.5" />
            <span>Open shell here</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={onStop}
            disabled={exited || errored}
            variant="destructive"
          >
            <Square className="h-3.5 w-3.5" />
            <span>Stop</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRemove} variant="destructive">
            <span>Close pane</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

// v1.4.3 #06 — Renders the two halves of a split group in a single grid
// cell, separated by a sub-divider. Each sub-pane is its own
// <SessionTerminal> (and its own terminal-cache entry) so the cache handles
// their lifecycles transparently — no special-casing needed there.
//
// The sub-divider resizes the two halves with a simple ratio state; the
// outer GridLayout's divider math is unaffected because the split group
// occupies one outer grid cell.
function SplitGroupCell({
  panes,
  paneIndex,
  providers,
  focusedPaneId,
  onActivate,
  onRemove,
  onStop,
  onToggleMinimise,
  onToggleFullscreen,
}: {
  panes: AgentSession[];
  paneIndex: number;
  providers: { id: string; name: string }[];
  focusedPaneId: string | null;
  onActivate: (id: string) => void;
  onRemove: (s: AgentSession) => void;
  onStop: (s: AgentSession) => void;
  onToggleMinimise: (s: AgentSession) => void;
  onToggleFullscreen: (id: string) => void;
}) {
  const direction = panes[0]?.splitDirection ?? 'horizontal';
  const groupId = panes[0]?.splitGroupId ?? `split-${paneIndex}`;
  // Sub-grid divider state — fractional split between the two halves.
  // Defaults to 0.5 each. Min 0.15 to mirror GridLayout's MIN_FRAC.
  const [ratio, setRatio] = useState(0.5);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const startSubDrag = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = direction === 'vertical' ? rect.width : rect.height;
      const start = direction === 'vertical' ? ev.clientX : ev.clientY;
      const initial = ratio;
      let pendingRaf: number | null = null;
      let latest: number | null = null;
      const flush = () => {
        if (latest !== null) setRatio(latest);
        latest = null;
        pendingRaf = null;
      };
      document.body.dataset.dragging = 'true';
      const move = (e: PointerEvent) => {
        const delta = (direction === 'vertical' ? e.clientX : e.clientY) - start;
        const dFrac = delta / total;
        latest = Math.min(0.85, Math.max(0.15, initial + dFrac));
        if (pendingRaf === null) {
          pendingRaf = requestAnimationFrame(flush);
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (pendingRaf !== null) {
          cancelAnimationFrame(pendingRaf);
          pendingRaf = null;
          if (latest !== null) setRatio(latest);
          latest = null;
        }
        delete document.body.dataset.dragging;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [direction, ratio],
  );

  // CSS grid template — 2 cols for vertical split (side-by-side) or 2 rows
  // for horizontal split (top/bottom). The brief uses "horizontal" to mean
  // "split the pane horizontally → two rows" — matches typical terminal
  // multiplexer semantics.
  const gridStyle =
    direction === 'vertical'
      ? { gridTemplateColumns: `${ratio}fr ${1 - ratio}fr` }
      : { gridTemplateRows: `${ratio}fr ${1 - ratio}fr` };

  return (
    <div
      ref={containerRef}
      className="relative grid h-full min-h-0 w-full min-w-0 gap-1"
      style={gridStyle}
      data-split-group={groupId}
      data-split-direction={direction}
    >
      {panes.map((p, idx) => (
        <div
          key={p.id}
          className="relative min-h-0 min-w-0 overflow-hidden rounded-md border border-border bg-card"
          onMouseDown={() => onActivate(p.id)}
        >
          <PaneCell
            session={p}
            paneIndex={paneIndex}
            providers={providers}
            onFocus={() => onActivate(p.id)}
            onRemove={() => onRemove(p)}
            onStop={() => onStop(p)}
            onSplit={() => undefined /* disabled in split sub-panes */}
            onToggleMinimise={() => onToggleMinimise(p)}
            isFullscreen={focusedPaneId === p.id}
            onToggleFullscreen={() => onToggleFullscreen(p.id)}
            inSplitGroup
          />
          {idx === 0 ? (
            // Sub-divider sits at the boundary between the two halves.
            // Positioned absolutely so it doesn't disturb the sub-grid math.
            <div
              onPointerDown={startSubDrag}
              className={
                direction === 'vertical'
                  ? 'absolute right-0 top-0 z-30 h-full w-1.5 translate-x-1/2 cursor-col-resize hover:bg-[hsl(var(--ring)/0.4)]'
                  : 'absolute bottom-0 left-0 z-30 h-1.5 w-full translate-y-1/2 cursor-row-resize hover:bg-[hsl(var(--ring)/0.4)]'
              }
              role="separator"
              aria-label={`Resize split ${direction === 'vertical' ? 'column' : 'row'}`}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
