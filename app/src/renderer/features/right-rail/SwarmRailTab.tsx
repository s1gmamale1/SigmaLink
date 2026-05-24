// SwarmRailTab — C-2 (agent index) + C-4 (chat log) in the right-rail.
//
// Surfaces the running swarm's agent roster (RoleRoster, read-only + clickable
// for jump-to-pane) and the swarm's side-chat (SideChat) in a vertically
// stacked layout. Mirrors the pattern in SwarmRoom.tsx for data wiring.
//
// Mount guard: no active swarm → muted placeholder.

import { useEffect, useMemo } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { RoleRoster } from '@/renderer/features/swarm-room/RoleRoster';
import { SideChat } from '@/renderer/features/swarm-room/SideChat';
import type { RoleAssignment, Swarm, SwarmMessage } from '@/shared/types';

const EMPTY_SWARMS: Swarm[] = [];
const EMPTY_MESSAGES: SwarmMessage[] = [];

export function SwarmRailTab() {
  const dispatch = useAppDispatch();
  const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspaceId);
  const activeSwarmId = useAppStateSelector((s) => s.activeSwarmId);
  const swarmMessages = useAppStateSelector((s) => s.swarmMessages);
  const workspaceSwarms = useAppStateSelector((s) =>
    activeWorkspaceId
      ? s.swarmsByWorkspace[activeWorkspaceId] ?? EMPTY_SWARMS
      : EMPTY_SWARMS,
  );

  // Mirror CommandRoom.tsx:89-95 — prefer the explicitly selected swarm, then
  // fall back to the first running one in the workspace.
  const activeSwarm = useMemo(() => {
    const selected = activeSwarmId
      ? workspaceSwarms.find((s) => s.id === activeSwarmId)
      : null;
    return selected ?? workspaceSwarms.find((s) => s.status === 'running') ?? null;
  }, [activeSwarmId, workspaceSwarms]);

  const messages = activeSwarm
    ? swarmMessages[activeSwarm.id] ?? EMPTY_MESSAGES
    : EMPTY_MESSAGES;

  // Tail hydration — mirror SwarmRoom.tsx pattern exactly.
  useEffect(() => {
    let alive = true;
    if (!activeSwarm) return;
    if (swarmMessages[activeSwarm.id]) return;
    void (async () => {
      try {
        const tail = await rpc.swarms.tail(activeSwarm.id, { limit: 200 });
        if (!alive) return;
        dispatch({ type: 'SET_SWARM_MESSAGES', swarmId: activeSwarm.id, messages: tail });
      } catch (err) {
        console.error('[SwarmRailTab] tail failed', err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeSwarm, dispatch, swarmMessages]);

  // Derive lastActivity: latest non-SYSTEM body per fromAgent.
  const lastActivity = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of messages) {
      if (m.kind === 'SYSTEM') continue;
      // Later messages overwrite earlier ones (messages are oldest-first).
      if (m.fromAgent && m.body) {
        out[m.fromAgent] = m.body;
      }
    }
    return out;
  }, [messages]);

  if (!activeSwarm) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        No active swarm.
      </div>
    );
  }

  // Build roster + messageCounts the same way SwarmRoom.tsx does.
  const liveAgents = activeSwarm.agents;
  const roster: RoleAssignment[] = liveAgents.map((a) => ({
    role: a.role,
    roleIndex: a.roleIndex,
    providerId: a.providerId,
  }));

  const messageCounts = messages.reduce<Record<string, number>>((acc, m) => {
    if (m.fromAgent !== 'operator') {
      acc[m.fromAgent] = (acc[m.fromAgent] ?? 0) + 1;
    }
    if (m.toAgent !== '*') {
      acc[m.toAgent] = (acc[m.toAgent] ?? 0) + 1;
    }
    return acc;
  }, {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* C-2 — Agent roster (top region, scrollable) */}
      <div className="max-h-[45%] overflow-y-auto border-b border-border p-2">
        <RoleRoster
          readOnly
          roster={roster}
          providers={[]}
          onChange={() => undefined}
          liveAgents={liveAgents}
          messageCounts={messageCounts}
          lastActivity={lastActivity}
          onFocusPane={(sessionId) =>
            dispatch({ type: 'SET_ACTIVE_SESSION', id: sessionId })
          }
        />
      </div>
      {/* C-4 — Side chat (fills remaining height) */}
      <div className="min-h-0 flex-1">
        <SideChat swarm={activeSwarm} messages={messages} />
      </div>
    </div>
  );
}
