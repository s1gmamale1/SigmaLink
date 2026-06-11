import type Database from 'better-sqlite3';

/**
 * Mark a pane row as deliberately closed (soft-delete). Writes the epoch-ms
 * `closed_at` ONLY while it is still NULL, so a later natural pty-exit (or a
 * double close) cannot clobber the original close timestamp.
 *
 * `closed_at` is the DURABLE close marker — `status` is racy (the launcher's
 * onExit DB write overwrites a killed pane's status to 'error'/code 143 after
 * this runs), so all resume/rehydrate/toast-suppression logic keys off
 * `closed_at`, never status. Call this with the RAW better-sqlite3 handle BEFORE
 * killing the PTY so the async exit sees the marker.
 */
export function markPaneClosed(
  db: Database.Database,
  sessionId: string,
  now: number,
): void {
  db.prepare(
    `UPDATE agent_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL`,
  ).run(now, sessionId);
}
