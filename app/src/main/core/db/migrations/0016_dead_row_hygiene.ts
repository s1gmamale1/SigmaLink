import type Database from 'better-sqlite3';

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
export const name = '0016_dead_row_hygiene';

export function up(db: Database.Database): void {
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
      console.info(
        `[migrate0016] Marked ${result.changes} stale sessions as exited (>24h old, status='running')`,
      );
    }
  } catch (err) {
    // Don't crash boot if the table doesn't exist yet (fresh install).
    console.warn('[migrate0016] Skipped (table may not exist):', err);
  }
}
