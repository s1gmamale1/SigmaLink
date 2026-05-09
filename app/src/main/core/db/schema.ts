// Drizzle SQLite schema. Phase 1 covers workspaces, agent_sessions, settings.
// Phase 2-4 will add: tasks, swarms, mailbox_messages, memories, skills, mcp_servers.

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    repoRoot: text('repo_root'),
    repoMode: text('repo_mode', { enum: ['git', 'plain'] }).notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastOpenedAt: integer('last_opened_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    rootIdx: uniqueIndex('workspaces_root_idx').on(t.rootPath),
  }),
);

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    providerId: text('provider_id').notNull(),
    cwd: text('cwd').notNull(),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    status: text('status', { enum: ['starting', 'running', 'exited', 'error'] }).notNull(),
    exitCode: integer('exit_code'),
    initialPrompt: text('initial_prompt'),
    startedAt: integer('started_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    exitedAt: integer('exited_at'),
  },
  (t) => ({
    wsIdx: index('agent_sessions_ws_idx').on(t.workspaceId),
    statusIdx: index('agent_sessions_status_idx').on(t.status),
  }),
);

export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type AgentSessionInsert = typeof agentSessions.$inferInsert;
