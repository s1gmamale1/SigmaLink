// Task-domain types for the Phase-6 Kanban. Re-exports the cross-process
// shapes from `shared/types`; main-process-only fields would land here.

import type {
  Task,
  TaskStatus,
  TaskAssignment,
  TaskComment,
} from '../../../shared/types';

export type { Task, TaskStatus, TaskAssignment, TaskComment };
