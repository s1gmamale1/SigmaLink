// Task CRUD + Kanban moves + assignment.
//
// Persistence: `tasks` (one row per card), `task_comments` (free-form thread).
// Status moves are simple column transitions — every change updates
// `updated_at` and broadcasts a `tasks:changed` notification.

import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client';
import { tasks, taskComments } from '../db/schema';
import type { Task, TaskAssignment, TaskComment, TaskStatus } from './types';

export interface TasksManagerDeps {
  emit: (taskId: string | null) => void;
}

function rowToTask(row: typeof tasks.$inferSelect): Task {
  let labels: string[] = [];
  if (row.labelsJson) {
    try {
      const parsed = JSON.parse(row.labelsJson);
      if (Array.isArray(parsed)) labels = parsed.filter((x) => typeof x === 'string');
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    assignedSessionId: row.assignedSessionId ?? null,
    assignedSwarmId: row.assignedSwarmId ?? null,
    assignedSwarmAgentId: row.assignedSwarmAgentId ?? null,
    labels,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

function rowToComment(row: typeof taskComments.$inferSelect): TaskComment {
  return {
    id: row.id,
    taskId: row.taskId,
    author: row.author,
    body: row.body,
    createdAt: row.createdAt,
  };
}

export class TasksManager {
  private readonly emit: TasksManagerDeps['emit'];
  constructor(deps: TasksManagerDeps) {
    this.emit = deps.emit;
  }

  list(workspaceId: string): Task[] {
    const db = getDb();
    const rows = db
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId))
      .all();
    return rows.map(rowToTask).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Task | null {
    const db = getDb();
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? rowToTask(row) : null;
  }

  create(input: {
    workspaceId: string;
    title: string;
    description?: string;
    status?: TaskStatus;
    labels?: string[];
    assignment?: TaskAssignment;
  }): Task {
    const db = getDb();
    const id = randomUUID();
    const now = Date.now();
    db.insert(tasks)
      .values({
        id,
        workspaceId: input.workspaceId,
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'backlog',
        assignedSessionId: input.assignment?.sessionId ?? null,
        assignedSwarmId: input.assignment?.swarmId ?? null,
        assignedSwarmAgentId: input.assignment?.swarmAgentId ?? null,
        labelsJson: input.labels && input.labels.length ? JSON.stringify(input.labels) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.emit(id);
    return this.get(id)!;
  }

  update(input: {
    id: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    labels?: string[];
    assignment?: TaskAssignment | null;
  }): Task {
    const db = getDb();
    const set: Partial<typeof tasks.$inferInsert> = { updatedAt: Date.now() };
    if (typeof input.title === 'string') set.title = input.title;
    if (typeof input.description === 'string') set.description = input.description;
    if (input.status) set.status = input.status;
    if (input.labels !== undefined) {
      set.labelsJson = input.labels.length ? JSON.stringify(input.labels) : null;
    }
    if (input.assignment !== undefined) {
      set.assignedSessionId = input.assignment?.sessionId ?? null;
      set.assignedSwarmId = input.assignment?.swarmId ?? null;
      set.assignedSwarmAgentId = input.assignment?.swarmAgentId ?? null;
    }
    if (input.status === 'archived') set.archivedAt = Date.now();
    db.update(tasks).set(set).where(eq(tasks.id, input.id)).run();
    this.emit(input.id);
    const row = this.get(input.id);
    if (!row) throw new Error(`task not found: ${input.id}`);
    return row;
  }

  remove(id: string): void {
    const db = getDb();
    db.delete(tasks).where(eq(tasks.id, id)).run();
    this.emit(null);
  }

  setStatus(id: string, status: TaskStatus): Task {
    return this.update({ id, status });
  }

  assign(id: string, assignment: TaskAssignment | null): Task {
    return this.update({ id, assignment });
  }

  listComments(taskId: string): TaskComment[] {
    const db = getDb();
    return db
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .all()
      .map(rowToComment)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  addComment(input: { taskId: string; author?: string; body: string }): TaskComment {
    const db = getDb();
    const id = randomUUID();
    db.insert(taskComments)
      .values({
        id,
        taskId: input.taskId,
        author: input.author ?? 'operator',
        body: input.body,
        createdAt: Date.now(),
      })
      .run();
    db.update(tasks)
      .set({ updatedAt: Date.now() })
      .where(eq(tasks.id, input.taskId))
      .run();
    this.emit(input.taskId);
    return rowToComment(
      db.select().from(taskComments).where(eq(taskComments.id, id)).get()!,
    );
  }

  removeComment(commentId: string): void {
    const db = getDb();
    const row = db
      .select()
      .from(taskComments)
      .where(eq(taskComments.id, commentId))
      .get();
    db.delete(taskComments).where(eq(taskComments.id, commentId)).run();
    if (row) {
      db.update(tasks)
        .set({ updatedAt: Date.now() })
        .where(eq(tasks.id, row.taskId))
        .run();
      this.emit(row.taskId);
    } else {
      this.emit(null);
    }
  }

  /** Find tasks assigned to a particular swarm agent (used by mailbox UI). */
  findBySwarmAgent(swarmAgentId: string): Task[] {
    const db = getDb();
    return db
      .select()
      .from(tasks)
      .where(and(eq(tasks.assignedSwarmAgentId, swarmAgentId)))
      .all()
      .map(rowToTask);
  }
}
