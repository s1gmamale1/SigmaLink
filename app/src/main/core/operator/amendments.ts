// P2 Task 8 — Jorvis's self-amendments DAO. Plain drizzle CRUD over
// `jorvis_amendments` (migration 0041, schema from Task 1) — same idiom as
// `../missions/dao.ts` / `./memory.ts`'s drizzle half. No FTS, no raw SQL: a
// proposal is a short prompt-surface string, not a searchable corpus.
//
// D5/D6 — a proposal (`proposeAmendment`, called by the `propose_amendment`
// tool) is inert prompt-surface text until the operator decides it
// (`decideAmendment`). `charter.ts`'s `appendApprovedAmendments` only ever
// reads `listAmendments('approved')` rows, spliced in after the charter at
// prompt-build time — never edited into it.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { jorvisAmendments } from '../db/schema';
import type { JorvisAmendmentRow } from '../db/schema';
import type { JorvisAmendment, JorvisAmendmentStatus } from '../../../shared/types';

function rowToAmendment(row: JorvisAmendmentRow): JorvisAmendment {
  return {
    id: row.id,
    text: row.text,
    rationale: row.rationale,
    status: row.status,
    decisionReason: row.decisionReason,
    proposedAt: row.proposedAt,
    decidedAt: row.decidedAt,
  };
}

function getAmendmentRow(id: string): JorvisAmendmentRow | null {
  return getDb().select().from(jorvisAmendments).where(eq(jorvisAmendments.id, id)).get() ?? null;
}

export function proposeAmendment(input: { text: string; rationale?: string | null }): JorvisAmendment {
  const now = Date.now();
  const amendment: JorvisAmendment = {
    id: randomUUID(),
    text: input.text,
    rationale: input.rationale ?? null,
    status: 'proposed',
    decisionReason: null,
    proposedAt: now,
    decidedAt: null,
  };
  getDb().insert(jorvisAmendments).values(amendment).run();
  return amendment;
}

export function listAmendments(status?: JorvisAmendmentStatus): JorvisAmendment[] {
  const rows = status
    ? getDb().select().from(jorvisAmendments).where(eq(jorvisAmendments.status, status)).all()
    : getDb().select().from(jorvisAmendments).all();
  const out = rows.map(rowToAmendment);
  out.sort((a, b) => b.proposedAt - a.proposedAt); // most-recently-proposed first, mirrors listMissions
  return out;
}

/**
 * Decide a proposed amendment. Idempotent-guarded: only a `proposed` row can
 * be decided — deciding an already-decided row throws rather than silently
 * clobbering the first decision (an operator-facing audit trail, not a
 * mutable toggle).
 */
export function decideAmendment(id: string, approved: boolean, reason?: string | null): JorvisAmendment {
  const row = getAmendmentRow(id);
  if (!row) throw new Error(`jorvis amendment not found: ${id}`);
  if (row.status !== 'proposed') {
    throw new Error(`amendment already decided: ${id} (status=${row.status})`);
  }
  const decidedAt = Date.now();
  const status: JorvisAmendmentStatus = approved ? 'approved' : 'denied';
  const decisionReason = reason ?? null;
  getDb()
    .update(jorvisAmendments)
    .set({ status, decisionReason, decidedAt })
    .where(eq(jorvisAmendments.id, id))
    .run();
  return { ...rowToAmendment(row), status, decisionReason, decidedAt };
}
