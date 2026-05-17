// v1.4.3 #06 — Pane Split + Minimise DAO.
//
// Thin write/read helpers for the new `agent_sessions` split/minimised
// columns introduced by migration 0017. The split fields describe membership
// in a 2-pane split group (max-depth 2 in v1.4.x); the `minimised` flag
// collapses a pane to its header strip in the renderer without killing the
// underlying PTY.
//
// All writes go through `getRawDb()` so the SQL stays portable across the
// better-sqlite3 + libsql build targets — `agent_sessions` is the same table
// the rest of the swarm controller hits, so existing transaction semantics
// (better-sqlite3's synchronous write-lock model) apply unchanged.

import { eq, and } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { agentSessions, swarmAgents } from '../db/schema';
import type { AgentSession, SplitDirection } from '../../../shared/types';
import { loadAgentSession } from './factory-spawn';

/**
 * Annotate one pane as a member of a split group. The two halves of a split
 * are written by back-to-back `setPaneSplit` calls in the splitPane RPC —
 * one for the parent (splitIndex 0) and one for the just-spawned sub-pane
 * (splitIndex 1).
 */
export function setPaneSplit(
  paneId: string,
  groupId: string,
  direction: SplitDirection,
  index: number,
): void {
  getRawDb()
    .prepare(
      `UPDATE agent_sessions SET split_group_id = ?, split_direction = ?, split_index = ? WHERE id = ?`,
    )
    .run(groupId, direction, index, paneId);
}

/**
 * Toggle the `minimised` flag for one pane. Stored as 0/1 on disk; callers
 * pass the boolean shape.
 */
export function setPaneMinimised(paneId: string, minimised: boolean): void {
  getRawDb()
    .prepare(`UPDATE agent_sessions SET minimised = ? WHERE id = ?`)
    .run(minimised ? 1 : 0, paneId);
}

/**
 * Return every pane that shares a split group, ordered by `split_index` so
 * the renderer can lay them out top→bottom / left→right consistently.
 */
export function getPaneSplitGroup(groupId: string): AgentSession[] {
  const db = getDb();
  const rows = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.splitGroupId, groupId))
    .all();
  return rows
    .map((r) => loadAgentSession(r.id))
    .filter((s): s is AgentSession => s !== null)
    .sort((a, b) => (a.splitIndex ?? 0) - (b.splitIndex ?? 0));
}

/**
 * Look up a pane row by id (raw read — does NOT remap into the renderer
 * shape). Used by the RPC layer for parent-of-split lookups.
 */
export function findPaneById(paneId: string): typeof agentSessions.$inferSelect | null {
  return (
    getDb()
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, paneId))
      .get() ?? null
  );
}

/**
 * Convenience: fetch the workspace id for a pane. Returns `null` if the pane
 * doesn't exist. Used by the splitPane RPC for an early bailout.
 */
export function getPaneWorkspaceId(paneId: string): string | null {
  const row = getDb()
    .select({ workspaceId: agentSessions.workspaceId })
    .from(agentSessions)
    .where(eq(agentSessions.id, paneId))
    .get();
  return row?.workspaceId ?? null;
}

/**
 * Convenience: locate the swarm a pane belongs to (via the swarm_agents
 * mapping). Returns `null` if the pane isn't a swarm agent. Used by the
 * splitPane RPC to derive the target swarm without forcing the caller to
 * pass it.
 */
export function getSwarmIdForPane(paneId: string): string | null {
  const row = getDb()
    .select({ swarmId: swarmAgents.swarmId })
    .from(swarmAgents)
    .where(and(eq(swarmAgents.sessionId, paneId)))
    .get();
  return row?.swarmId ?? null;
}
