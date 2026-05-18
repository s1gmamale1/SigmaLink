# 03 — Dead-Row Migration 0016 (P1, must land WITH #02)

**Severity**: P1 — blocks #02 from working correctly on first boot
**Effort**: XS (~1hr)
**Cluster**: B (pane-lifecycle — bundled with #02 and #04 in ONE PR)
**Suggested delegate**: Sonnet (Claude Code)
**Depends on**: nothing — strict no-op when DB is fresh
**Blocks**: #02 (rehydration must see clean DB), #04 (worktree cleanup needs accurate status)

## Context

Investigation revealed: **ALL existing `agent_sessions` rows still show `status='running'` with `exit_code=NULL`** because Electron's hard quit doesn't trigger the onExit handler at `launcher.ts:313-327`.

DB inspection (`~/Library/Application Support/SigmaLink/sigmalink.db`):
- 24+ rows for workspace `6330e45d…` (`/Users/aisigma/projects/SigmaLink/app`), all `status='running'`
- 6 rows for `Homeworks` workspace, all `status='running'`
- Worktree dirs (34 of them) exist under `~/Library/Application Support/SigmaLink/worktrees/373b48ed20cd/`
- Most rows started 2026-05-16, hours-to-days before current time

If #02's rehydration RPC runs against this state:
1. It returns 30+ "running" sessions per workspace open
2. The renderer renders 30 panes (way over the 20-pane swarm cap)
3. PTY resume re-spawn fails for sessions whose external_session_id is stale
4. User sees flood of error toasts on first boot post-fix

**Solution**: migration 0016 marks all rows older than 24h that are stuck in `status='running'` as exited. Conservative window spares any actually-active sessions. Silent (no user-facing notification — this is housekeeping).

**Lead decision (locked)**: 24h conservative window (NOT mark-all-on-boot, NOT delete-worktrees).

## File:line targets

### NEW `app/src/main/core/db/migrations/0016_dead_row_hygiene.ts`

```ts
import type { Database } from 'better-sqlite3';

/**
 * v1.4.3 migration 0016 — dead-row hygiene.
 *
 * Marks all `agent_sessions` rows with `status='running' AND exited_at IS NULL`
 * AND `started_at < (now - 24h)` as `status='exited', exit_code=-1, exited_at=now()`.
 *
 * Reason: Electron's hard quit (Cmd+Q without graceful shutdown) bypasses the
 * onExit handler at workspaces/launcher.ts:313-327, leaving sessions stuck in
 * `running` state. Without this migration, the v1.4.3 rehydration fix (#02)
 * tries to resume ~30 dead sessions on first boot.
 *
 * Idempotent: re-running is safe (only matches rows where exited_at IS NULL).
 * Conservative: 24h window spares actually-active sessions.
 */
export function migrate0016_deadRowHygiene(db: Database.Database): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h ago in ms

  try {
    const stmt = db.prepare(`
      UPDATE agent_sessions
      SET status = 'exited',
          exit_code = -1,
          exited_at = ?
      WHERE status = 'running'
        AND exited_at IS NULL
        AND started_at < ?
    `);
    const result = stmt.run(Date.now(), cutoff);
    if (result.changes > 0) {
      console.info(`[migrate0016] Marked ${result.changes} stale sessions as exited (>24h old, status='running')`);
    }
  } catch (err) {
    // Don't crash boot if the table doesn't exist yet (fresh install).
    console.warn('[migrate0016] Skipped (table may not exist):', err);
  }
}
```

### Update `app/src/main/core/db/migrate.ts`

Register migration 0016 in the ordered runner:

```ts
import { migrate0016_deadRowHygiene } from './migrations/0016_dead_row_hygiene';

const migrations = [
  // ... existing 0001-0015 ...
  migrate0016_deadRowHygiene,
];
```

The migration runner already iterates the array in order at boot, before any RPC handlers register. Ordering is enforced.

## Tests

NEW `app/src/main/core/db/migrations/0016_dead_row_hygiene.test.ts`:

1. **Fresh DB (no agent_sessions table yet)** — migration runs without throwing; logs warning.
2. **DB with no rows** — migration runs; no rows affected.
3. **Row newer than 24h, `status='running'`** — untouched.
4. **Row older than 24h, `status='running'`, `exited_at IS NULL`** — marked `status='exited'`, `exit_code=-1`, `exited_at` is set to a value ~now.
5. **Row older than 24h, `status='exited'` already** — untouched (idempotent).
6. **Row older than 24h, `status='running'`, `exited_at` already set** — untouched (someone else cleaned it up).
7. **Idempotency** — running the migration twice has the same effect as once.
8. **Mixed batch** — DB with mix of fresh/stale running/exited rows produces correct partition.

## Gate

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.3-02-04-pane-lifecycle/app
pnpm exec tsc -b --pretty false           # clean
pnpm exec vitest run                       # +8 new cases
pnpm exec eslint .                         # 0 errors
pnpm run build                              # clean
```

**Manual smoke** (REQUIRED — verifies the housekeeping):
1. Pre-fix: query the dev DB (`sqlite3 ~/Library/Application\ Support/SigmaLink/sigmalink.db "SELECT status, COUNT(*) FROM agent_sessions GROUP BY status"`). Expect: `running: N, ...`.
2. Build + launch app with the migration in place.
3. Re-query: rows older than 24h in `status='running'` should now be `status='exited', exit_code=-1, exited_at=<now>`.
4. Rows newer than 24h (if any) should be untouched.

## Risks

- **R-03-1** If a user's app has been running continuously for 24h+ with active sessions, those sessions' `started_at` is older than 24h and they'd get marked exited even though they're actually still alive. Mitigation: the migration runs ONCE at boot, BEFORE PTYs spawn — but if a user is in the middle of a heavy long-running session and quits/reopens, the migration would mark it dead. **Acceptable**: PTY processes only live for the lifetime of the parent Electron process; on app quit, all child PTYs die. So `started_at < (now - 24h)` ⇒ definitely dead. The migration is correct.
- **R-03-2** A user with a v1.4.3 install who hasn't quit/reopened for 24h+ would never see the migration run a second time. That's fine — the migration only matters at boot, and only on the first boot after a dirty quit.
- **R-03-3** Logging at `console.info` may surface in production logs. Consider gating behind dev-mode. Low priority.

## Pairs with

- #02 (rehydration) — same PR, sequencing-locked
- #04 (worktree cleanup) — same PR; #04 reads `status` to know which worktrees are live

## Closes

- The "30 dead sessions show up after rehydration" risk from #02
- Long-tail tech debt: every prior version of SigmaLink had this bug latent; v1.4.3 makes it visible by adding rehydration on top of it

## Doc source

New file — no prior brief.
