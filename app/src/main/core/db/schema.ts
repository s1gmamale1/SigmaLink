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

// Phase 2 — Swarm Room
export const swarms = sqliteTable(
  'swarms',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    mission: text('mission').notNull(),
    preset: text('preset', { enum: ['squad', 'team', 'platoon', 'legion', 'custom'] }).notNull(),
    status: text('status', { enum: ['running', 'paused', 'completed', 'failed'] })
      .notNull()
      .default('running'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    endedAt: integer('ended_at'),
  },
  (t) => ({
    swarmsWsIdx: index('swarms_ws_idx').on(t.workspaceId),
    swarmsStatusIdx: index('swarms_status_idx').on(t.status),
  }),
);

export const swarmAgents = sqliteTable(
  'swarm_agents',
  {
    id: text('id').primaryKey(),
    swarmId: text('swarm_id').notNull(),
    role: text('role', { enum: ['coordinator', 'builder', 'scout', 'reviewer'] }).notNull(),
    roleIndex: integer('role_index').notNull(),
    providerId: text('provider_id').notNull(),
    sessionId: text('session_id'),
    status: text('status', { enum: ['idle', 'busy', 'blocked', 'done', 'error'] })
      .notNull()
      .default('idle'),
    inboxPath: text('inbox_path').notNull(),
    agentKey: text('agent_key').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    swarmAgentsSwarmIdx: index('swarm_agents_swarm_idx').on(t.swarmId),
    swarmAgentsRoleUq: uniqueIndex('swarm_agents_role_uq').on(t.swarmId, t.role, t.roleIndex),
  }),
);

export const swarmMessages = sqliteTable(
  'swarm_messages',
  {
    id: text('id').primaryKey(),
    swarmId: text('swarm_id').notNull(),
    fromAgent: text('from_agent').notNull(),
    toAgent: text('to_agent').notNull(), // '*' for broadcast or agent_key
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    payloadJson: text('payload_json'),
    ts: integer('ts').notNull(),
    deliveredAt: integer('delivered_at'),
    readAt: integer('read_at'),
  },
  (t) => ({
    swarmMessagesSwarmTimeIdx: index('swarm_messages_swarm_time_idx').on(t.swarmId, t.ts),
    swarmMessagesToIdx: index('swarm_messages_to_idx').on(t.swarmId, t.toAgent),
  }),
);

// Phase 3 — Browser Room
export const browserTabs = sqliteTable(
  'browser_tabs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull().default(''),
    active: integer('active').notNull().default(0),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastVisitedAt: integer('last_visited_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    browserTabsWsIdx: index('browser_tabs_ws_idx').on(t.workspaceId),
  }),
);

export type BrowserTabRow = typeof browserTabs.$inferSelect;
export type BrowserTabInsert = typeof browserTabs.$inferInsert;

// Phase 4 — Skills Room
export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    version: text('version'),
    contentHash: text('content_hash').notNull(),
    managedPath: text('managed_path').notNull(),
    installedAt: integer('installed_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    tagsJson: text('tags_json'),
  },
  (t) => ({
    skillsNameUq: uniqueIndex('skills_name_uq').on(t.name),
  }),
);

export const skillProviderState = sqliteTable(
  'skill_provider_state',
  {
    skillId: text('skill_id').notNull(),
    providerId: text('provider_id').notNull(),
    enabled: integer('enabled').notNull().default(0),
    lastFanoutAt: integer('last_fanout_at'),
    lastError: text('last_error'),
  },
  (t) => ({
    skillProviderStatePk: uniqueIndex('skill_provider_state_pk').on(t.skillId, t.providerId),
  }),
);

export type SkillRow = typeof skills.$inferSelect;
export type SkillInsert = typeof skills.$inferInsert;
export type SkillProviderStateRow = typeof skillProviderState.$inferSelect;
export type SkillProviderStateInsert = typeof skillProviderState.$inferInsert;

// Phase 5 — Memory
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull().default(''),
    frontmatterJson: text('frontmatter_json'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    memoriesWsIdx: index('memories_ws_idx').on(t.workspaceId),
    memoriesNameUq: uniqueIndex('memories_ws_name_uq').on(t.workspaceId, t.name),
  }),
);

export const memoryLinks = sqliteTable(
  'memory_links',
  {
    id: text('id').primaryKey(),
    fromMemoryId: text('from_memory_id').notNull(),
    toMemoryName: text('to_memory_name').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    memoryLinksFromIdx: index('memory_links_from_idx').on(t.fromMemoryId),
    memoryLinksToIdx: index('memory_links_to_idx').on(t.toMemoryName),
  }),
);

export const memoryTags = sqliteTable(
  'memory_tags',
  {
    memoryId: text('memory_id').notNull(),
    tag: text('tag').notNull(),
  },
  (t) => ({
    memoryTagsPk: uniqueIndex('memory_tags_pk').on(t.memoryId, t.tag),
    memoryTagsTagIdx: index('memory_tags_tag_idx').on(t.tag),
  }),
);

export type MemoryRow = typeof memories.$inferSelect;
export type MemoryInsert = typeof memories.$inferInsert;
export type MemoryLinkRow = typeof memoryLinks.$inferSelect;
export type MemoryLinkInsert = typeof memoryLinks.$inferInsert;
export type MemoryTagRow = typeof memoryTags.$inferSelect;
export type MemoryTagInsert = typeof memoryTags.$inferInsert;

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type AgentSessionInsert = typeof agentSessions.$inferInsert;
export type SwarmRow = typeof swarms.$inferSelect;
export type SwarmInsert = typeof swarms.$inferInsert;
export type SwarmAgentRow = typeof swarmAgents.$inferSelect;
export type SwarmAgentInsert = typeof swarmAgents.$inferInsert;
export type SwarmMessageRow = typeof swarmMessages.$inferSelect;
export type SwarmMessageInsert = typeof swarmMessages.$inferInsert;
