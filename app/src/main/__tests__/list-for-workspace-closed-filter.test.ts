// Task 8 — SQL-shape guard: panes.listForWorkspace must exclude closed panes.
//
// Uses a source-text assertion (not a live DB) because better-sqlite3 is built
// against Electron's ABI and cannot be loaded under vitest (reference:
// feedback_better_sqlite3_electron_abi). The ranked CTE must AND closed_at IS
// NULL so that a deliberate close (Task 7 sets closed_at before the kill)
// never resurfaces as a tile on workspace reopen.
//
// There are TWO ranked CTEs in rpc-router.ts:
//   1. lastResumePlan  (~line 1217) — provides the resume plan (session ids +
//      providers per slot); used by the launch flow, not ADD_SESSIONS.
//   2. listForWorkspace (~line 1279) — used by ADD_SESSIONS for tile rehydrate.
// Both must filter closed rows so neither path resurfaces a closed pane.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panes.listForWorkspace excludes closed panes', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/main/rpc-router.ts'), 'utf8');

  it('listForWorkspace ranked CTE WHERE filters closed_at IS NULL', () => {
    // The listForWorkspace CTE (tile rehydrate, ADD_SESSIONS path) must AND
    // closed_at IS NULL immediately after pane_index IS NOT NULL.
    const m = src.match(/pane_index IS NOT NULL[\s\S]{0,80}?closed_at IS NULL/i);
    expect(m).not.toBeNull();
  });

  it('has at least two closed_at IS NULL guards (lastResumePlan + listForWorkspace)', () => {
    // Both ranked CTEs in rpc-router.ts must be guarded.
    const count = (src.match(/closed_at IS NULL/gi) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
