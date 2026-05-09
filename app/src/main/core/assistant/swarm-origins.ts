// P3-S7 — Swarm origins DAO. Records the (`conversationId`, `messageId`)
// pair that triggered a swarm via the Bridge Assistant `create_swarm` tool
// so the Operator Console can surface a back-link to the originating chat.
//
// Migration 0009 owns the DDL; the table is keyed on `swarmId` (one origin
// per swarm) and CASCADE-deletes when any of the three referenced rows
// drop. Inserts use INSERT OR REPLACE so re-creating a swarm with the same
// id (impossible in practice — ids are uuid — but defensive) updates the
// link rather than throwing on the unique-key violation.

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { swarmOrigins } from '../db/schema';

export interface SwarmOrigin {
  swarmId: string;
  conversationId: string;
  messageId: string;
  createdAt: number;
}

/** Insert (or replace) the origin row that links a swarm back to the
 *  Bridge Assistant chat-turn that created it. Best-effort: never throws —
 *  the swarm should still spin up even if the link write fails. */
export function recordSwarmOrigin(input: {
  swarmId: string;
  conversationId: string;
  messageId: string;
}): SwarmOrigin {
  const createdAt = Date.now();
  getDb()
    .insert(swarmOrigins)
    .values({ ...input, createdAt })
    .onConflictDoUpdate({
      target: swarmOrigins.swarmId,
      set: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        createdAt,
      },
    })
    .run();
  return { ...input, createdAt };
}

/** Resolve the back-link for a swarm. Returns null when no origin exists
 *  (e.g. the swarm was created via the Swarm Room, not via the Bridge
 *  Assistant). */
export function getSwarmOrigin(swarmId: string): SwarmOrigin | null {
  const row = getDb()
    .select()
    .from(swarmOrigins)
    .where(eq(swarmOrigins.swarmId, swarmId))
    .get();
  if (!row) return null;
  return {
    swarmId: row.swarmId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    createdAt: row.createdAt,
  };
}
