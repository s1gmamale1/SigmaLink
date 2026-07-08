// P1a Task 3 — DAO for the Jorvis mission board. CRUD over missions /
// mission_tasks / mission_events (schema: Task 1, migration 0039); `moveTask`
// is the only task-status writer and is guarded by the pure state machine in
// `./state` so illegal transitions can never reach the DB. All synchronous
// (better-sqlite3 via drizzle) — mirrors the row-mapping + query style of
// `../assistant/conversations.ts`.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import { missions, missionTasks, missionEvents } from '../db/schema';
import type { MissionRow, MissionTaskRow, MissionEventRow } from '../db/schema';
import { isLegalTaskTransition, rollupMissionStatus } from './state';
import type {
  Mission,
  MissionEvent,
  MissionOrigin,
  MissionStatus,
  MissionTask,
  MissionTaskStatus,
} from '../../../shared/types';

function rowToMission(row: MissionRow): Mission {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    origin: row.origin,
    clientLabel: row.clientLabel,
    workspaceId: row.workspaceId,
    status: row.status,
    report: row.report,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToTask(row: MissionTaskRow): MissionTask {
  return {
    id: row.id,
    missionId: row.missionId,
    title: row.title,
    spec: row.spec,
    status: row.status,
    assigneeSessionId: row.assigneeSessionId,
    worktreePath: row.worktreePath,
    attempt: row.attempt,
    orderIdx: row.orderIdx,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEvent(row: MissionEventRow): MissionEvent {
  return {
    id: row.id,
    missionId: row.missionId,
    taskId: row.taskId,
    kind: row.kind,
    body: row.body,
    ts: row.ts,
  };
}

// `mission_events.ts` must be strictly increasing so `listEvents` (which
// sorts newest-first) is deterministic even when multiple events land in the
// same synchronous call (and therefore the same `Date.now()` millisecond).
let lastEventTs = 0;
function nextEventTs(): number {
  const now = Date.now();
  lastEventTs = now > lastEventTs ? now : lastEventTs + 1;
  return lastEventTs;
}

function appendEvent(
  missionId: string,
  taskId: string | null,
  kind: string,
  body?: string | null,
): void {
  const event: MissionEvent = {
    id: randomUUID(),
    missionId,
    taskId,
    kind,
    body: body ?? null,
    ts: nextEventTs(),
  };
  getDb().insert(missionEvents).values(event).run();
}

export function createMission(input: {
  title: string;
  goal: string;
  origin: MissionOrigin;
  clientLabel?: string | null;
  workspaceId?: string | null;
}): Mission {
  const now = Date.now();
  const mission: Mission = {
    id: randomUUID(),
    title: input.title,
    goal: input.goal,
    origin: input.origin,
    clientLabel: input.clientLabel ?? null,
    workspaceId: input.workspaceId ?? null,
    status: 'draft',
    report: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(missions).values(mission).run();
  appendEvent(mission.id, null, 'created');
  return mission;
}

export function getMission(id: string): Mission | null {
  const row = getDb().select().from(missions).where(eq(missions.id, id)).get();
  return row ? rowToMission(row) : null;
}

export function listMissions(filter?: {
  workspaceId?: string | null;
  status?: MissionStatus;
}): Mission[] {
  const clauses = [];
  if (filter?.workspaceId !== undefined) {
    clauses.push(
      filter.workspaceId === null
        ? isNull(missions.workspaceId)
        : eq(missions.workspaceId, filter.workspaceId),
    );
  }
  if (filter?.status !== undefined) clauses.push(eq(missions.status, filter.status));
  const where = clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : and(...clauses);
  const rows = where
    ? getDb().select().from(missions).where(where).all()
    : getDb().select().from(missions).all();
  const out = rows.map(rowToMission);
  out.sort((a, b) => b.updatedAt - a.updatedAt); // most-recent first
  return out;
}

export function setMissionStatus(id: string, status: MissionStatus): void {
  const updatedAt = Date.now();
  getDb().update(missions).set({ status, updatedAt }).where(eq(missions.id, id)).run();
  appendEvent(id, null, 'status', JSON.stringify({ status }));
}

export function setMissionReport(id: string, report: string): void {
  getDb().update(missions).set({ report, updatedAt: Date.now() }).where(eq(missions.id, id)).run();
}

export function addTask(input: {
  missionId: string;
  title: string;
  spec?: string;
  orderIdx?: number;
}): MissionTask {
  const siblings = listTasks(input.missionId);
  const maxIdx = siblings.length > 0 ? Math.max(...siblings.map((t) => t.orderIdx)) : -1;
  const now = Date.now();
  const task: MissionTask = {
    id: randomUUID(),
    missionId: input.missionId,
    title: input.title,
    spec: input.spec ?? '',
    status: 'backlog',
    assigneeSessionId: null,
    worktreePath: null,
    attempt: 0,
    orderIdx: input.orderIdx ?? maxIdx + 1,
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(missionTasks).values(task).run();
  appendEvent(input.missionId, task.id, 'task_created');
  return task;
}

export function getTask(id: string): MissionTask | null {
  const row = getDb().select().from(missionTasks).where(eq(missionTasks.id, id)).get();
  return row ? rowToTask(row) : null;
}

export function listTasks(missionId: string): MissionTask[] {
  const rows = getDb()
    .select()
    .from(missionTasks)
    .where(eq(missionTasks.missionId, missionId))
    .all();
  const out = rows.map(rowToTask);
  out.sort((a, b) => a.orderIdx - b.orderIdx);
  return out;
}

export function moveTask(id: string, to: MissionTaskStatus): MissionTask {
  const task = getTask(id);
  if (!task) throw new Error(`mission task not found: ${id}`);
  if (!isLegalTaskTransition(task.status, to)) {
    throw new Error(`illegal transition: ${task.status} → ${to}`);
  }
  const updatedAt = Date.now();
  getDb().update(missionTasks).set({ status: to, updatedAt }).where(eq(missionTasks.id, id)).run();
  appendEvent(task.missionId, id, 'task_moved', JSON.stringify({ from: task.status, to }));

  const mission = getMission(task.missionId);
  if (mission) {
    const siblingStatuses = listTasks(task.missionId).map((t) => t.status);
    const nextStatus = rollupMissionStatus(siblingStatuses, mission.status);
    if (nextStatus !== mission.status) setMissionStatus(task.missionId, nextStatus);
  }

  return { ...task, status: to, updatedAt };
}

export function updateTask(
  id: string,
  patch: {
    title?: string;
    spec?: string;
    assigneeSessionId?: string | null;
    worktreePath?: string | null;
    attempt?: number;
    orderIdx?: number;
  },
): MissionTask {
  const task = getTask(id);
  if (!task) throw new Error(`mission task not found: ${id}`);
  const updatedAt = Date.now();
  const merged: MissionTask = {
    ...task,
    title: patch.title !== undefined ? patch.title : task.title,
    spec: patch.spec !== undefined ? patch.spec : task.spec,
    assigneeSessionId:
      patch.assigneeSessionId !== undefined ? patch.assigneeSessionId : task.assigneeSessionId,
    worktreePath: patch.worktreePath !== undefined ? patch.worktreePath : task.worktreePath,
    attempt: patch.attempt !== undefined ? patch.attempt : task.attempt,
    orderIdx: patch.orderIdx !== undefined ? patch.orderIdx : task.orderIdx,
    updatedAt,
  };
  getDb()
    .update(missionTasks)
    .set({
      title: merged.title,
      spec: merged.spec,
      assigneeSessionId: merged.assigneeSessionId,
      worktreePath: merged.worktreePath,
      attempt: merged.attempt,
      orderIdx: merged.orderIdx,
      updatedAt,
    })
    .where(eq(missionTasks.id, id))
    .run();
  return merged;
}

// P1b Task 1 — dispatch_task link helpers. linkTaskToPane/incrementAttempt
// are the two writes dispatch_task makes after executeLaunchPlan returns a
// session; listTasksForSession is the watcher's reverse lookup (P1b Task 2+);
// listActiveMissions is the supervisor loop's poll target.

export function linkTaskToPane(
  taskId: string,
  sessionId: string,
  worktreePath: string | null,
): MissionTask {
  const task = getTask(taskId);
  if (!task) throw new Error(`mission task not found: ${taskId}`);
  getDb()
    .update(missionTasks)
    .set({ assigneeSessionId: sessionId, worktreePath, updatedAt: Date.now() })
    .where(eq(missionTasks.id, taskId))
    .run();
  appendEvent(task.missionId, taskId, 'task_dispatched', JSON.stringify({ sessionId, worktreePath }));
  return getTask(taskId)!;
}

export function incrementAttempt(taskId: string): number {
  const task = getTask(taskId);
  if (!task) throw new Error(`mission task not found: ${taskId}`);
  const next = task.attempt + 1;
  getDb().update(missionTasks).set({ attempt: next, updatedAt: Date.now() }).where(eq(missionTasks.id, taskId)).run();
  return next;
}

export function listTasksForSession(sessionId: string): MissionTask[] {
  return getDb()
    .select()
    .from(missionTasks)
    .where(eq(missionTasks.assigneeSessionId, sessionId))
    .all()
    .map(rowToTask);
}

export function listActiveMissions(): Mission[] {
  return listMissions({ status: 'active' });
}

export function listEvents(missionId: string, limit = 200): MissionEvent[] {
  const rows = getDb()
    .select()
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .all();
  const out = rows.map(rowToEvent);
  out.sort((a, b) => b.ts - a.ts); // most-recent first
  return out.slice(0, limit);
}
