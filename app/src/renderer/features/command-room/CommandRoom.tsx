// V3-W13-003 / V3-W13-004 / v1.1.4 Step 4: Command Room — multi-pane grid.
//
// Renders the per-workspace agent sessions inside a generic <GridLayout>.
// Each cell stacks: PaneHeader (single h-7 strip) · (PaneSplash overlay +
// SessionTerminal) · PaneFooter. The grid honours the launcher's preset
// shape (1/2/3×3/4/6/8/9/10/12) and supports per-cell drag resize plus
// Cmd+Alt+<N> focus jumps. The legacy PaneStatusStrip was collapsed into
// PaneHeader's provider-name tooltip; Stop moves to the right-click menu.

import { useEffect, useMemo, useState } from 'react';
import { Plus, Square, Terminal as TerminalIcon } from 'lucide-react';
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
import { SessionTerminal } from './Terminal';
import { GridLayout } from './GridLayout';
import { PaneHeader } from './PaneHeader';
import { PaneSplash } from './PaneSplash';
import { PaneFooter } from './PaneFooter';
import type { AgentSession, Swarm } from '@/shared/types';

const EMPTY_SESSIONS: AgentSession[] = [];
const EMPTY_SWARMS: Swarm[] = [];

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
  const sessions = useAppStateSelector((state) =>
    activeWorkspaceId ? state.sessionsByWorkspace[activeWorkspaceId] ?? EMPTY_SESSIONS : EMPTY_SESSIONS,
  );
  const workspaceSwarms = useAppStateSelector((state) =>
    activeWorkspaceId ? state.swarmsByWorkspace[activeWorkspaceId] ?? EMPTY_SWARMS : EMPTY_SWARMS,
  );
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [adding, setAdding] = useState(false);
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

  // BUG-V1.1-04-IPC — derive activeIndex from global state.activeSessionId
  // so cross-pane jumps fired by Sigma dispatch echoes (or anywhere else
  // that dispatches SET_ACTIVE_SESSION) update the focus ring + footer
  // metadata without needing a local click. Falls back to 0 when the
  // active id isn't in the current pane list (e.g. workspace just
  // switched, session not yet hydrated).
  const activeIndex = useMemo(() => {
    if (sessions.length === 0) return 0;
    const idx = activeSessionId
      ? sessions.findIndex((s) => s.id === activeSessionId)
      : -1;
    return idx >= 0 ? idx : 0;
  }, [sessions, activeSessionId]);

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
    return (
      <EmptyState
        icon={TerminalIcon}
        title="No agents launched yet"
        description="Head back to the Workspaces room to pick a grid preset and launch."
        action={
          <Button size="sm" onClick={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}>
            Go to Workspaces
          </Button>
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
      <div className="min-h-0 flex-1 overflow-hidden">
        <GridLayout<AgentSession>
          items={sessions}
          getKey={(s) => s.id}
          activeIndex={activeIndex}
          onActiveChange={(i) => {
            const s = sessions[i];
            if (s && activeSessionId !== s.id) {
              dispatch({ type: 'SET_ACTIVE_SESSION', id: s.id });
            }
          }}
          renderCell={(session, ctx) => (
            <PaneCell
              session={session}
              paneIndex={ctx.index + 1}
              onFocus={() => ctx.activate()}
              onRemove={() => handleRemove(session)}
              onStop={() => handleStop(session)}
            />
          )}
        />
      </div>
    </div>
  );
}

function PaneCell({
  session,
  paneIndex,
  onFocus,
  onRemove,
  onStop,
}: {
  session: AgentSession;
  paneIndex: number;
  onFocus: () => void;
  onRemove: () => void;
  onStop: () => void;
}) {
  const errored = session.status === 'error';
  const exited = session.status === 'exited';
  // V1.1.4 Step 4 — Stop functionality lives in the right-click context menu
  // now that PaneStatusStrip is gone and the header only carries Close. The
  // ContextMenu wraps just the body so right-clicks on the header chrome
  // (with its own buttons) don't fight Radix for the event.
  return (
    <div className="sl-pane-enter flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <PaneHeader
        session={session}
        paneIndex={paneIndex}
        onFocus={onFocus}
        onClose={onRemove}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex min-h-0 flex-1 flex-col">
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
