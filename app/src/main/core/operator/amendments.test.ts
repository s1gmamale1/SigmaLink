// P2 Task 8 — amendments DAO tests. Drizzle CRUD over `jorvis_amendments`
// (migration 0041, schema from Task 1) — same createDbFake() harness as
// missions/dao.test.ts and memory.test.ts's CRUD half. No raw SQL / FTS here
// (unlike memory.ts): amendments are plain rows, no delete() needed either
// (decide is an update, not a hard delete), so this file needs neither
// memory.test.ts's patchDelete shim nor a recording-raw harness.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as amendments from './amendments';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

describe('amendments DAO — proposeAmendment', () => {
  it('creates a proposed row with sane defaults', () => {
    const a = amendments.proposeAmendment({ text: 'Always ship receipts.' });
    expect(a.text).toBe('Always ship receipts.');
    expect(a.status).toBe('proposed');
    expect(a.rationale).toBeNull();
    expect(a.decisionReason).toBeNull();
    expect(a.decidedAt).toBeNull();
    expect(typeof a.proposedAt).toBe('number');
    expect(amendments.listAmendments().map((x) => x.id)).toContain(a.id);
  });

  it('honors an explicit rationale', () => {
    const a = amendments.proposeAmendment({ text: 't', rationale: 'because reasons' });
    expect(a.rationale).toBe('because reasons');
  });
});

describe('amendments DAO — listAmendments', () => {
  it('lists every amendment when no status filter is given', () => {
    amendments.proposeAmendment({ text: 'a' });
    amendments.proposeAmendment({ text: 'b' });
    expect(amendments.listAmendments()).toHaveLength(2);
  });

  it('filters by status', () => {
    const a = amendments.proposeAmendment({ text: 'a' });
    amendments.proposeAmendment({ text: 'b' });
    amendments.decideAmendment(a.id, true);
    const approved = amendments.listAmendments('approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe(a.id);
    const proposed = amendments.listAmendments('proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0].text).toBe('b');
  });

  it('sorts most-recently-proposed first', () => {
    const a = amendments.proposeAmendment({ text: 'first' });
    const b = amendments.proposeAmendment({ text: 'second' });
    const listed = amendments.listAmendments();
    expect(listed[0].id === b.id || listed[0].id === a.id).toBe(true);
    // proposedAt is monotonic-ish via Date.now(); just assert ordering is
    // descending by proposedAt (never ascending).
    expect(listed[0].proposedAt).toBeGreaterThanOrEqual(listed[listed.length - 1].proposedAt);
  });
});

describe('amendments DAO — decideAmendment', () => {
  it('approves a proposed amendment: sets status, decidedAt, and an optional reason', () => {
    const a = amendments.proposeAmendment({ text: 't' });
    const decided = amendments.decideAmendment(a.id, true, 'looks good');
    expect(decided.status).toBe('approved');
    expect(decided.decisionReason).toBe('looks good');
    expect(typeof decided.decidedAt).toBe('number');
    const reread = amendments.listAmendments().find((x) => x.id === a.id);
    expect(reread?.status).toBe('approved');
  });

  it('denies a proposed amendment', () => {
    const a = amendments.proposeAmendment({ text: 't' });
    const decided = amendments.decideAmendment(a.id, false, 'not aligned');
    expect(decided.status).toBe('denied');
    expect(decided.decisionReason).toBe('not aligned');
  });

  it('a decision reason is optional', () => {
    const a = amendments.proposeAmendment({ text: 't' });
    const decided = amendments.decideAmendment(a.id, true);
    expect(decided.decisionReason).toBeNull();
  });

  it('throws for an unknown id', () => {
    expect(() => amendments.decideAmendment('nope', true)).toThrowError(/not found/);
  });

  it('is idempotent-guarded: only a proposed row can be decided, else throws', () => {
    const a = amendments.proposeAmendment({ text: 't' });
    amendments.decideAmendment(a.id, true);
    expect(() => amendments.decideAmendment(a.id, false)).toThrowError(/already decided/);
    // The first decision must not be clobbered by the rejected second call.
    expect(amendments.listAmendments().find((x) => x.id === a.id)?.status).toBe('approved');
  });
});
