// SwarmRailTab — C-2 (agent index) + C-4 (chat log) + FEAT-6 phase tree in the right-rail.
//
// Surfaces:
//   1. SwarmPhaseTree (FEAT-6) — phase-grouped agent tree above the roster.
//   2. RoleRoster (C-2, read-only + click-to-focus) — existing compact overview.
//   3. SideChat (C-4) — swarm broadcast chat.
//
// Mount guard: no active swarm → muted placeholder.

import { useEffect, useMemo } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppDispatch, useAppStateSelector } from '@/renderer/app/state';
import { RoleRoster } from '@/renderer/features/swarm-room/RoleRoster';
import { SideChat } from '@/renderer/features/swarm-room/SideChat';
import { SwarmPhaseTree } from './SwarmPhaseTree';
import type { AgentSession, RoleAssignment, Swarm, SwarmMessage } from '@/shared/types';

const EMPTY_SWARMS: Swarm[] = [];
const EMPTY_MESSAGES: SwarmMessage[] = [];
const EMPTY_SESSIONS: AgentSession[] = [];

export function SwarmRailTab() {
  const dispatch = useAppDispatch();
  const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspaceId);
  const activeSwarmId = useAppStateSelector((s) => s.activeSwarmId);
  // FEAT-6 — cross-ref PTY session status for phase-tree status derivation.
  const sessions = useAppStateSelector((s) => s.sessions ?? EMPTY_SESSIONS);
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

  // Per-thread messages — only re-renders when the thread for THIS swarm changes.
  // Returns undefined when not yet loaded (key absent) vs [] (loaded but empty).
  const activeSwarmMessages = useAppStateSelector((s) =>
    activeSwarm ? s.swarmMessages[activeSwarm.id] : undefined,
  );
  const messages = activeSwarmMessages ?? EMPTY_MESSAGES;

  // Tail hydration — mirror SwarmRoom.tsx pattern exactly.
  useEffect(() => {
    let alive = true;
    if (!activeSwarm) return;
    if (activeSwarmMessages !== undefined) return;
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
  }, [activeSwarm, activeSwarmMessages, dispatch]);

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
      {/* FEAT-6 — Phase tree (collapsible; ~40% max height) */}
      <div className="max-h-[40%] overflow-y-auto border-b border-border">
        <SwarmPhaseTree
          swarm={activeSwarm}
          sessions={sessions}
          messageCounts={messageCounts}
          lastActivity={lastActivity}
        />
      </div>
      {/* C-2 — Agent roster (compact overview, scrollable) */}
      <div className="max-h-[30%] overflow-y-auto border-b border-border p-2">
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
