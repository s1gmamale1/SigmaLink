// Task 1 (v2.9.1) — SQL-shape guard: the two ranked CTEs in rpc-router.ts must
// RANK-THEN-FILTER closed panes, not filter them inside the ranked CTE.
//
// Uses a source-text assertion (not a live DB) because better-sqlite3 is built
// against Electron's ABI and cannot be loaded under vitest (reference:
// feedback_better_sqlite3_electron_abi).
//
// Ghost-pane resurrection bug: `lastResumePlan` and `listForWorkspace` used to
// AND `closed_at IS NULL` INSIDE the ranked CTE's WHERE. When the NEWEST row of
// a pane slot was closed, that row was excluded BEFORE ranking, so an older
// non-closed row in the same slot became rn = 1 and RESURFACED as a red error
// tile on workspace reopen. The fix ranks ALL rows per slot first (rn = 1 =
// newest per slot) and only THEN drops the slot when its winner is closed — a
// closed newest row now HIDES its slot instead of un-shadowing an older ghost.
//
// There are TWO ranked CTEs in rpc-router.ts:
//   1. lastResumePlan   — resume plan (session ids + providers per slot).
//   2. listForWorkspace — full-row tile rehydrate (ADD_SESSIONS path).
// Both must apply `closed_at IS NULL` in the OUTER select (after rn = 1).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panes ranked CTEs — rank-then-filter closed panes', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/main/rpc-router.ts'), 'utf8');

  it('filters closed_at in the OUTER select (after rn = 1) in both CTEs', () => {
    // The winner of each slot is dropped when closed — so the filter must sit on
    // the outer `WHERE rn = 1`, once per CTE (lastResumePlan + listForWorkspace).
    const outer = (src.match(/rn = 1\s+AND\s+closed_at IS NULL/gi) ?? []).length;
    expect(outer).toBeGreaterThanOrEqual(2);
  });

  it('does NOT filter closed_at inside the ranked CTE WHERE (would un-shadow ghosts)', () => {
    // The buggy shape ANDed `closed_at IS NULL` directly onto the ranked CTE's
    // WHERE, right after `pane_index IS NOT NULL`. The ranked CTEs put
    // `workspace_id = ? AND s.pane_index IS NOT NULL` on ONE line — this regex
    // targets exactly that shape so it does not trip on the flat, non-ranked
    // app-state pane query (where `closed_at IS NULL` is legitimate).
    const inCte = src.match(
      /WHERE s\.workspace_id = \? AND s\.pane_index IS NOT NULL\s+AND s\.closed_at IS NULL/i,
    );
    expect(inCte).toBeNull();
  });

  it('still guards closed_at in at least two places (both CTEs)', () => {
    const count = (src.match(/closed_at IS NULL/gi) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
