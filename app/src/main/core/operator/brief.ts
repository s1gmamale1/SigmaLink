// P3 T6 — Jorvis's daily brief: a pure digest builder over the mission
// board, wired (by the lead) into rpc-router's DailyScheduler mirroring the
// notifications daily-summary pattern (`../notifications/digest-builder.ts`)
// and pushed to the operator's phone via TelegramBridge.pushToOperator.
// PURE + DI — no DB import: every read (active missions / tasks / recent
// events / pending amendments / wake budget / clock) is injected so this
// module is unit-testable against seeded in-memory data, same idiom as
// `./scheduler.ts`'s WakeSchedulerDeps. The lead wires the real DAOs
// (missions/dao.ts's listActiveMissions/listTasks/listEvents,
// operator/amendments.ts's listAmendments('proposed'), the WakeScheduler's
// wakesSpentToday + the KV daily-budget read) at the rpc-router call site.
//
// Section order + the per-mission task-status one-liner mirror
// `../remote/board-format.ts`'s `/status` formatter, with one deliberate
// difference in the cap idiom: board-format's cap() does a raw character
// slice; this module prefers a whole-line cut (drops the last, partial line
// rather than mid-word truncating it) — a half-sentence lands worse on a
// phone push than a dropped line.

import type {
  Mission,
  MissionEvent,
  MissionTask,
  MissionTaskStatus,
  JorvisAmendment,
} from '../../../shared/types';

/** Hard cap on the brief's length — mirrors board-format.ts's
 *  MAX_REPLY_CHARS (Telegram's own 4096-char limit, capped well under it for
 *  headroom after HTML-escaping in the bridge's outbound pipeline). */
export const MAX_BRIEF_CHARS = 3500;

const DAY_MS = 86_400_000;

/** How many recent events to pull per active mission when scanning the
 *  last-24h activity window — mirrors missions/dao.ts's listEvents default
 *  limit (200). */
const EVENTS_LOOKBACK_LIMIT = 200;

const HEADER = '📋 Jorvis daily brief';

/** Stable column order for the per-mission task-status counts — mirrors
 *  board-format.ts's STATUS_ORDER so an operator sees the same ordering in
 *  both `/status` and the daily brief. */
const STATUS_ORDER: MissionTaskStatus[] = [
  'backlog',
  'dispatched',
  'working',
  'reviewing',
  'needs_input',
  'done',
  'blocked',
];

export interface BriefDeps {
  listActiveMissions(): Mission[];
  listTasks(missionId: string): MissionTask[];
  listRecentEvents(missionId: string, limit: number): MissionEvent[];
  listPendingAmendments(): JorvisAmendment[];
  wakesSpentToday(): number;
  dailyBudget(): number;
  /** Injected clock — deterministic 24h-window checks in tests. */
  now(): number;
}

function taskStatusCounts(tasks: MissionTask[]): string {
  if (tasks.length === 0) return 'no tasks yet';
  const counts = new Map<MissionTaskStatus, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const parts = STATUS_ORDER.filter((s) => counts.has(s)).map((s) => `${s}:${counts.get(s)}`);
  return parts.join(' ');
}

/** Extract the `to` status from a `task_moved` event's JSON body
 *  (`{from,to}`, written by missions/dao.ts's moveTask). A malformed/missing
 *  body parses to null rather than throwing — a corrupt event must never
 *  crash the digest. */
function taskMovedTo(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const to = (parsed as { to?: unknown } | null)?.to;
    return typeof to === 'string' ? to : null;
  } catch {
    return null;
  }
}

/** Hard-truncate to MAX_BRIEF_CHARS, preferring to drop the last partial
 *  line rather than cut mid-word. Falls back to a raw slice when no newline
 *  exists inside the budget (mirrors board-format.ts's cap() in that
 *  degenerate case). Never exceeds the cap, including the trailing
 *  ellipsis. */
function cap(text: string): string {
  if (text.length <= MAX_BRIEF_CHARS) return text;
  const budget = MAX_BRIEF_CHARS - 1; // room for the trailing ellipsis
  const slice = text.slice(0, budget);
  const lastNewline = slice.lastIndexOf('\n');
  const truncated = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return truncated + '…';
}

/**
 * Build the once-daily operator digest. All reads are injected — see
 * `BriefDeps`. An empty board (no active missions) short-circuits to a
 * minimal header + wakes line; the last-24h-activity and
 * pending-amendments sections only ever appear alongside at least one
 * active mission line.
 */
export function buildDailyBrief(deps: BriefDeps): string {
  const missions = deps.listActiveMissions();
  const wakesLine = `wakes: ${deps.wakesSpentToday()}/${deps.dailyBudget()}`;

  if (missions.length === 0) {
    return cap([HEADER, 'no active missions', wakesLine].join('\n'));
  }

  const missionLines = missions.map(
    (m) => `${m.title} (${m.id}) — ${taskStatusCounts(deps.listTasks(m.id))}`,
  );

  const since = deps.now() - DAY_MS;
  let doneCount = 0;
  let blockedCount = 0;
  for (const m of missions) {
    const events = deps.listRecentEvents(m.id, EVENTS_LOOKBACK_LIMIT);
    for (const ev of events) {
      if (ev.kind !== 'task_moved' || ev.ts < since) continue;
      const to = taskMovedTo(ev.body);
      if (to === 'done') doneCount++;
      else if (to === 'blocked') blockedCount++;
    }
  }
  const activityLine = `last 24h: ${doneCount} done, ${blockedCount} blocked`;

  const lines = [HEADER, ...missionLines, activityLine, wakesLine];

  const pending = deps.listPendingAmendments();
  if (pending.length > 0) {
    lines.push(`pending amendments: ${pending.length} — /approve <id>`);
  }

  return cap(lines.join('\n'));
}
