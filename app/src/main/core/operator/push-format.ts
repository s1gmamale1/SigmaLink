// P3 Task 3 (D6) — pure text builders for the proactive Telegram pushes that
// the supervisor (MAX_ATTEMPTS cap-block) and rpc-router's tool-trace hooks
// (complete_mission / move_mission_task blocked / propose_amendment) fire.
// Kept as small, pure, exported functions so the FORMATTING is unit-tested
// in isolation — rpc-router.ts and supervisor.ts stay thin glue that build
// the inputs (title/report/taskId/amendmentId) and hand them here, then pass
// the result straight to `bridge?.pushToOperator(text).catch(() => {})`.
// No imports from missions/dao or the DB — every input arrives pre-resolved
// by the caller, so this file never touches better-sqlite3 (Electron ABI;
// would break under vitest — see reference_better_sqlite3_electron_abi).

/**
 * Supervisor's MAX_ATTEMPTS cap-block push. `missionLabel` is the caller's
 * choice of the mission's title (preferred) or its id (fallback when the
 * mission row is somehow missing at push time — never blocks the push).
 */
export function formatCapBlockPush(taskTitle: string, missionLabel: string, maxAttempts: number): string {
  return `⛔ task capped after ${maxAttempts} attempts: ${taskTitle} (mission ${missionLabel}) — needs a human`;
}

/**
 * complete_mission trace-hook push. `report` is truncated to its first 400
 * characters — proactive pushes are a phone notification, not the full
 * report (get_report / mission_board remain the source of truth).
 */
export function formatMissionDonePush(title: string, report: string | null): string {
  const tail = (report ?? '').slice(0, 400);
  return `✅ mission done: ${title}\n${tail}`;
}

/** move_mission_task(status:'blocked') trace-hook push. */
export function formatTaskBlockedPush(taskId: string): string {
  return `🚧 task blocked: ${taskId} — check the board`;
}

/** propose_amendment trace-hook push. */
export function formatAmendmentProposedPush(amendmentId: string): string {
  return `🔏 amendment proposed (${amendmentId}): /approve ${amendmentId} or /deny ${amendmentId}`;
}
