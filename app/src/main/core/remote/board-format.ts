// P3 T2 — pure text formatting for the Telegram mission cockpit (`/status`,
// `/tasks`). No DB/DAO import: the caller (bridge.ts, via its injected
// `missions.boardRead()` closure) hands in a snapshot; this module only
// turns it into operator-readable text. Unit-tested directly.

import type { Mission, MissionTask, MissionTaskStatus } from '../../../shared/types';

export interface MissionBoardRow {
  mission: Mission;
  tasks: MissionTask[];
}

/**
 * Hard cap on any string this module returns. Telegram's own message limit
 * is 4096 chars (see bridge.ts TELEGRAM_MAX_CHARS); capping well under that
 * keeps a huge board readable as a single message and leaves headroom for
 * HTML-escaping in the bridge's outbound pipeline.
 */
const MAX_REPLY_CHARS = 3500;

/** Stable column order for the `/status` counts one-liner — an operator
 *  scanning many missions wants the same order every time, not a sort by
 *  frequency. */
const STATUS_ORDER: MissionTaskStatus[] = [
  'backlog',
  'dispatched',
  'working',
  'reviewing',
  'needs_input',
  'done',
  'blocked',
];

/** Hard-truncate to MAX_REPLY_CHARS with a trailing ellipsis (never exceeds
 *  the cap, including the ellipsis itself). */
function cap(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return text.slice(0, MAX_REPLY_CHARS - 1) + '…';
}

function taskStatusCounts(tasks: MissionTask[]): string {
  if (tasks.length === 0) return 'no tasks yet';
  const counts = new Map<MissionTaskStatus, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const parts = STATUS_ORDER.filter((s) => counts.has(s)).map((s) => `${s}:${counts.get(s)}`);
  return parts.join(' ');
}

/** `/status` — one line per ACTIVE mission: title + a task-status counts
 *  summary. Empty (no active missions) → 'no active missions'. */
export function formatBoardSummary(board: MissionBoardRow[]): string {
  const active = board.filter((r) => r.mission.status === 'active');
  if (active.length === 0) return 'no active missions';
  const lines = active.map(
    (r) => `${r.mission.title} (${r.mission.id}) — ${taskStatusCounts(r.tasks)}`,
  );
  return cap(lines.join('\n'));
}

function formatMissionTasks(row: MissionBoardRow): string {
  const header = `${row.mission.title} (${row.mission.id})`;
  if (row.tasks.length === 0) return `${header}\n(no tasks yet)`;
  const lines = row.tasks.map((t) => `${t.title} · ${t.status} · attempt ${t.attempt}`);
  return [header, ...lines].join('\n');
}

/**
 * `/tasks [missionId]` — a missionId that matches a row shows just that
 * mission's tasks; an absent or unknown id groups tasks across every ACTIVE
 * mission (mirrors `/status`'s empty-board message).
 */
export function formatTasks(board: MissionBoardRow[], missionId?: string): string {
  if (missionId) {
    const row = board.find((r) => r.mission.id === missionId);
    if (row) return cap(formatMissionTasks(row));
  }
  const active = board.filter((r) => r.mission.status === 'active');
  if (active.length === 0) return 'no active missions';
  return cap(active.map(formatMissionTasks).join('\n\n'));
}
