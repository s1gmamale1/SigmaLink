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
    // V1.1-02: launcher-resolved provider tag (e.g. 'claude'). Nullable for
    // sessions that predate the BridgeCode launcher façade.
    providerEffective: text('provider_effective'),
    // v1.1.3: provider-native session id used by CLI resume flows
    // (`claude --resume <id>`, `codex --resume <id>`, etc.).
    externalSessionId: text('external_session_id'),
    // v1.3.1: launcher-issued pane slot index inside the workspace. Used by
    // `panes.lastResumePlan` to return ONE row per pane (the most recent),
    // instead of one row per historical launch. Nullable for legacy rows
    // written before this column existed; migration 0012 adds the column +
    // composite index `agent_sessions_ws_pane_idx`.
    paneIndex: integer('pane_index'),
  },
  (t) => ({
    wsIdx: index('agent_sessions_ws_idx').on(t.workspaceId),
    statusIdx: index('agent_sessions_status_idx').on(t.status),
    wsPaneIdx: index('agent_sessions_ws_pane_idx').on(
      t.workspaceId,
      t.paneIndex,
      t.startedAt,
    ),
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
    // V3-W12-009: 'legion' preserved for legacy row read-back; new swarms
    // accept 'battalion'. SQLite does not re-verify CHECK constraints on
    // existing rows when the enum changes, so historical 'legion' rows stay.
    preset: text('preset', {
      enum: ['squad', 'team', 'platoon', 'battalion', 'legion', 'custom'],
    }).notNull(),
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
    // V3-W12-018 — per-agent auto-approve toggle. Migration 0001 backfills 0
    // for legacy rows; new rows default to 0 here too so the schema stays in
    // sync with the runtime DDL.
    autoApprove: integer('auto_approve').notNull().default(0),
    // V3-W13-014 — multi-hub constellation. NULL on the queen coordinator;
    // every other agent (including peer coordinators) points to the queen so
    // the constellation renderer can draw glow lines per hub. Migration 0005
    // adds the column to existing DBs.
    coordinatorId: text('coordinator_id'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    swarmAgentsSwarmIdx: index('swarm_agents_swarm_idx').on(t.swarmId),
    swarmAgentsRoleUq: uniqueIndex('swarm_agents_role_uq').on(t.swarmId, t.role, t.roleIndex),
    swarmAgentsCoordIdx: index('swarm_agents_coord_idx').on(t.coordinatorId),
  }),
);

// V3-W13-011 — Swarm Skills 12-tile grid persistence. One row per
// (swarmId, skillKey); `on` is a 0/1 flag, `group` is one of
// 'workflow' | 'quality' | 'ops' | 'analysis'. The renderer mirrors toggles
// here via a `skill_toggle` envelope so coordinators can read the active
// skill set without re-tailing the mailbox.
export const swarmSkills = sqliteTable(
  'swarm_skills',
  {
    swarmId: text('swarm_id').notNull(),
    skillKey: text('skill_key').notNull(),
    on: integer('on_flag').notNull().default(0),
    group: text('group_key').notNull(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    swarmSkillsPk: uniqueIndex('swarm_skills_pk').on(t.swarmId, t.skillKey),
    swarmSkillsSwarmIdx: index('swarm_skills_swarm_idx').on(t.swarmId),
  }),
);

export type SwarmSkillRow = typeof swarmSkills.$inferSelect;
export type SwarmSkillInsert = typeof swarmSkills.$inferInsert;

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
    // V3-W12-016 — counter projection filter. NULL = unresolved; the four
    // Operator Console badges count rows where kind ∈ {escalation,
    // review_request, quiet_tick, error_report} AND resolved_at IS NULL.
    resolvedAt: integer('resolved_at'),
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

// Phase 6 — Tasks / Kanban + Review notes
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', {
      enum: ['backlog', 'in_progress', 'in_review', 'done', 'archived'],
    })
      .notNull()
      .default('backlog'),
    assignedSessionId: text('assigned_session_id'),
    assignedSwarmId: text('assigned_swarm_id'),
    assignedSwarmAgentId: text('assigned_swarm_agent_id'),
    labelsJson: text('labels_json'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    archivedAt: integer('archived_at'),
  },
  (t) => ({
    tasksWsIdx: index('tasks_ws_idx').on(t.workspaceId),
    tasksStatusIdx: index('tasks_status_idx').on(t.status),
  }),
);

export const taskComments = sqliteTable(
  'task_comments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    author: text('author').notNull().default('operator'),
    body: text('body').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    taskCommentsTaskIdx: index('task_comments_task_idx').on(t.taskId),
  }),
);

export const sessionReview = sqliteTable('session_review', {
  sessionId: text('session_id').primaryKey(),
  notes: text('notes').notNull().default(''),
  decision: text('decision', { enum: ['passed', 'failed'] }),
  decidedAt: integer('decided_at'),
  lastTestCommand: text('last_test_command'),
  lastTestExitCode: integer('last_test_exit_code'),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type TaskCommentInsert = typeof taskComments.$inferInsert;
export type SessionReviewRow = typeof sessionReview.$inferSelect;
export type SessionReviewInsert = typeof sessionReview.$inferInsert;

// Phase — V3-W13-008 — per-agent board namespace.
// Mirrors the on-disk markdown file at
//   <userData>/swarms/<swarmId>/boards/<agentId>/<postId>.md
// Migration 0003_boards owns the DDL; this Drizzle table mirrors it so
// queries elsewhere stay typed.
export const boards = sqliteTable(
  'boards',
  {
    id: text('id').primaryKey(),
    swarmId: text('swarmId').notNull(),
    agentId: text('agentId').notNull(),
    postId: text('postId').notNull(),
    title: text('title').notNull(),
    bodyMd: text('bodyMd').notNull(),
    attachmentsJson: text('attachmentsJson').notNull().default('[]'),
    createdAt: integer('createdAt').notNull(),
  },
  (t) => ({
    boardsSwarmAgentIdx: index('boards_swarm_agent_idx').on(t.swarmId, t.agentId),
  }),
);

export type BoardRow = typeof boards.$inferSelect;
export type BoardInsert = typeof boards.$inferInsert;

// Phase — V3-W13-013 — Bridge Assistant chat persistence.
// Migration 0006_assistant owns the DDL; these Drizzle tables mirror it so
// the assistant controller and conversations DAO stay end-to-end typed.
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    kind: text('kind', { enum: ['assistant', 'swarm_dm'] }).notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    conversationsWsIdx: index('conversations_ws_idx').on(t.workspaceId),
    conversationsKindIdx: index('conversations_kind_idx').on(t.kind),
  }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'tool', 'system'] }).notNull(),
    content: text('content').notNull(),
    toolCallId: text('tool_call_id'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    messagesConvIdx: index('messages_conversation_idx').on(t.conversationId, t.createdAt),
  }),
);

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationInsert = typeof conversations.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;

// Phase — V3-W14-006 — Bridge Canvas persistence.
// Migration 0007_canvases owns the DDL; these Drizzle tables mirror it so the
// design controller stays end-to-end typed.
export const canvases = sqliteTable(
  'canvases',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    title: text('title').notNull(),
    lastProviders: text('last_providers').notNull().default('[]'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    canvasesWsIdx: index('canvases_ws_idx').on(t.workspaceId),
  }),
);

export const canvasDispatches = sqliteTable(
  'canvas_dispatches',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    prompt: text('prompt').notNull(),
    providers: text('providers').notNull().default('[]'),
    ts: integer('ts')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    canvasDispatchesIdx: index('canvas_dispatches_canvas_idx').on(t.canvasId, t.ts),
  }),
);

export type CanvasRow = typeof canvases.$inferSelect;
export type CanvasInsert = typeof canvases.$inferInsert;
export type CanvasDispatchRow = typeof canvasDispatches.$inferSelect;
export type CanvasDispatchInsert = typeof canvasDispatches.$inferInsert;

// Phase 3 Step 6 — Persistent Swarm Replay bookmarks.
// Migration 0008_swarm_replay owns the DDL; this Drizzle table mirrors it so
// the replay manager stays end-to-end typed. Note the column names are
// camelCase on disk to match the migration (no snake_case mapping needed).
export const swarmReplaySnapshots = sqliteTable(
  'swarm_replay_snapshots',
  {
    id: text('id').primaryKey(),
    swarmId: text('swarmId').notNull(),
    label: text('label').notNull(),
    frameIdx: integer('frameIdx').notNull(),
    createdAt: integer('createdAt').notNull(),
  },
  (t) => ({
    swarmReplaySnapshotsSwarmFrameIdx: index(
      'swarm_replay_snapshots_swarm_frame_idx',
    ).on(t.swarmId, t.frameIdx),
  }),
);

export type SwarmReplaySnapshotRow = typeof swarmReplaySnapshots.$inferSelect;
export type SwarmReplaySnapshotInsert = typeof swarmReplaySnapshots.$inferInsert;

// Phase 3 Step 7 — Bridge Assistant cross-session persistence: swarm origins.
// Migration 0009_swarm_origins owns the DDL; this Drizzle table mirrors it.
// Each row is a back-link from a `swarms.id` to the (`conversationId`,
// `messageId`) pair that triggered the swarm via the assistant's
// `create_swarm` tool, enabling the Operator Console to render a
// "Started from Bridge Assistant chat" link back to the originating turn.
export const swarmOrigins = sqliteTable(
  'swarm_origins',
  {
    swarmId: text('swarmId').primaryKey(),
    conversationId: text('conversationId').notNull(),
    messageId: text('messageId').notNull(),
    createdAt: integer('createdAt').notNull(),
  },
  (t) => ({
    swarmOriginsConvIdx: index('swarm_origins_conv_idx').on(t.conversationId),
  }),
);

export type SwarmOriginRow = typeof swarmOrigins.$inferSelect;
export type SwarmOriginInsert = typeof swarmOrigins.$inferInsert;

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
