// Tasks RPC controller. Maps `tasks.*` channels onto TasksManager. The
// `assignToSwarmAgent` method also drops a TASK envelope into the agent's
// swarm mailbox so the agent's PTY sees the assignment immediately.

import { defineController } from '../../../shared/rpc';
import type { Task, TaskAssignment, TaskComment, TaskStatus } from '../../../shared/types';
import type { TasksManager } from './manager';
import type { SwarmMailbox } from '../swarms/mailbox';

export interface TasksControllerDeps {
  manager: TasksManager;
  mailbox: SwarmMailbox;
}

export function buildTasksController(deps: TasksControllerDeps) {
  const m = deps.manager;
  return defineController({
    list: async (workspaceId: string): Promise<Task[]> => {
      return m.list(workspaceId);
    },
    get: async (id: string): Promise<Task | null> => {
      return m.get(id);
    },
    create: async (input: {
      workspaceId: string;
      title: string;
      description?: string;
      status?: TaskStatus;
      labels?: string[];
      assignment?: TaskAssignment;
    }): Promise<Task> => {
      return m.create(input);
    },
    update: async (input: {
      id: string;
      title?: string;
      description?: string;
      status?: TaskStatus;
      labels?: string[];
      assignment?: TaskAssignment | null;
    }): Promise<Task> => {
      return m.update(input);
    },
    remove: async (id: string): Promise<void> => {
      m.remove(id);
    },
    setStatus: async (input: { id: string; status: TaskStatus }): Promise<Task> => {
      return m.setStatus(input.id, input.status);
    },
    assign: async (input: {
      id: string;
      assignment: TaskAssignment | null;
    }): Promise<Task> => {
      return m.assign(input.id, input.assignment);
    },
    /**
     * Drop a card on a swarm-roster slot: assigns the task and pushes a TASK
     * envelope into that agent's mailbox so its CLI sees the work item.
     */
    assignToSwarmAgent: async (input: {
      taskId: string;
      swarmId: string;
      agentKey: string;
      swarmAgentId: string;
    }): Promise<Task> => {
      const task = m.assign(input.taskId, {
        swarmId: input.swarmId,
        swarmAgentId: input.swarmAgentId,
      });
      try {
        await deps.mailbox.append({
          swarmId: input.swarmId,
          fromAgent: 'operator',
          toAgent: input.agentKey,
          // Fall under SAY for now — the mailbox protocol uses a small set of
          // canonical kinds and TASK is delivered as a SAY with payload so it
          // round-trips through the existing renderer side-chat without
          // surprising the swarm's bridge code.
          kind: 'SAY',
          body: `SIGMA::TASK ${task.title}`,
          payload: { taskId: task.id, description: task.description },
        });
      } catch {
        /* mailbox best-effort */
      }
      return task;
    },
    listComments: async (taskId: string): Promise<TaskComment[]> => {
      return m.listComments(taskId);
    },
    addComment: async (input: {
      taskId: string;
      author?: string;
      body: string;
    }): Promise<TaskComment> => {
      return m.addComment(input);
    },
    removeComment: async (commentId: string): Promise<void> => {
      m.removeComment(commentId);
    },
  });
}
