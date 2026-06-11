// Task 9 — SQL-shape guard: resume + respawn must exclude deliberately-closed panes.
//
// Uses source-text assertions (not a live DB) because better-sqlite3 is built
// against Electron's ABI and cannot be loaded under vitest (reference:
// feedback_better_sqlite3_electron_abi).
//
// listEligibleRows  — feeds the live-resume path (running OR exited/-1).
// listRespawnableRows — feeds the respawn-failed path (exited/-1 only).
// Both must AND closed_at IS NULL so a pane closed via × / context-menu /
// close_pane tool never comes back on workspace reopen.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('resume + respawn exclude deliberately-closed panes', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'src/main/core/pty/resume-launcher.ts'),
    'utf8',
  );

  it('listEligibleRows ANDs closed_at IS NULL before the status/exit_code OR-block', () => {
    // Must appear between the WHERE clause and the OR(status/exit_code) block.
    const m = src.match(/closed_at IS NULL[\s\S]{0,80}?exit_code = -1/i);
    expect(m).not.toBeNull();
  });

  it('has at least two closed_at IS NULL guards (listEligibleRows + listRespawnableRows)', () => {
    const count = (src.match(/closed_at IS NULL/gi) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
