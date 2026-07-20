// session-persistence fix (2026-07-18) — quit ordering contract.
//
// rpc-router.ts cannot be imported under vitest (electron imports), so this
// guards the ORDERING contract at the SOURCE level: every quit must flag
// expectedExit on all live panes BEFORE killAll() tears them down, or the
// quit-window race re-opens — the quit sequence deliberately holds the DB open
// ≤2.5s (waitForPidsExit) for the win32 WAL checkpoint, so a fast-dying pane's
// onExit landed status='error' (isPtyCrash sees signal 15) and the row silently
// dropped out of BOTH boot auto-resume (running OR exited/-1) and the
// respawn-fresh bucket (exited/-1). See
// docs/superpowers/plans/2026-07-18-session-persistence-correctness.md.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('shutdownRouter quit ordering (SOURCE assertion)', () => {
  it('calls pty.markAllExpectedExit() before pty.killAll()', () => {
    const src = fs.readFileSync(path.join(__dirname, 'rpc-router.ts'), 'utf8');
    const start = src.indexOf('export async function shutdownRouter');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    const markIdx = body.indexOf('markAllExpectedExit()');
    const killIdx = body.indexOf('pty.killAll()');
    expect(markIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeLessThan(killIdx);
  });
});
