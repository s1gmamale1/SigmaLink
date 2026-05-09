// V3-W13-003 / V3-W13-004: Command Room — multi-pane terminal grid.
//
// Renders the per-workspace agent sessions inside a generic <GridLayout>.
// Each cell stacks: PaneHeader · PaneStatusStrip · (PaneSplash overlay +
// SessionTerminal) · PaneFooter. The grid honours the launcher's preset
// shape (1/2/4/6/8/10/12) and supports per-cell drag resize plus
// Cmd+Alt+<N> focus jumps.

import { useMemo, useState } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { SessionTerminal } from './Terminal';
import { GridLayout } from './GridLayout';
import { PaneHeader } from './PaneHeader';
import { PaneSplash } from './PaneSplash';
import { PaneStatusStrip } from './PaneStatusStrip';
import { PaneFooter } from './PaneFooter';
import type { AgentSession } from '@/shared/types';

export function CommandRoom() {
  const { state, dispatch } = useAppState();
  const sessions = useMemo(
    () =>
      state.sessions.filter(
        (s) => state.activeWorkspace && s.workspaceId === state.activeWorkspace.id,
      ),
    [state.sessions, state.activeWorkspace],
  );
  const [activeIndex, setActiveIndex] = useState(0);

  // Clamp the active index when the session list shrinks. Computed during
  // render and corrected via setState so we don't need a setState-in-effect.
  if (activeIndex >= sessions.length && sessions.length > 0) {
    setActiveIndex(Math.max(0, sessions.length - 1));
  }

  if (!state.activeWorkspace) {
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-xs">
        <div className="font-medium">{state.activeWorkspace.name}</div>
        <span className="text-muted-foreground">·</span>
        <div className="text-muted-foreground">
          {sessions.length} {sessions.length === 1 ? 'agent' : 'agents'}
        </div>
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
            setActiveIndex(i);
            const s = sessions[i];
            if (s) dispatch({ type: 'SET_ACTIVE_SESSION', id: s.id });
          }}
          renderCell={(session) => (
            <PaneCell
              session={session}
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
  onRemove,
  onStop,
}: {
  session: AgentSession;
  onRemove: () => void;
  onStop: () => void;
}) {
  const errored = session.status === 'error';
  return (
    <div className="sl-pane-enter flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <PaneHeader session={session} onRemove={onRemove} onStop={onStop} />
      <PaneStatusStrip session={session} />
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
  );
}
