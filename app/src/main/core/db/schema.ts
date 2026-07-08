// Drizzle SQLite schema. Phase 1 covers workspaces, agent_sessions, settings.
// Phase 2-4 will add: tasks, swarms, mailbox_messages, memories, skills, mcp_servers.

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
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
    // DEV-W3a (migration 0034): unique constraint dropped so >1 workspace can
    // share a directory (disambiguated by custom name — DEV-W2). A non-unique
    // index keeps rootPath lookups fast.
    rootLookupIdx: index('workspaces_root_lookup_idx').on(t.rootPath),
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
    // RAM Brake — persisted per-pane MCP/tool profile. Existing rows default
    // to the lightweight profile via migration 0035.
    runtimeProfileId: text('runtime_profile_id').notNull().default('ruflo-core'),
    startedAt: integer('started_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    exitedAt: integer('exited_at'),
    // V1.1-02: launcher-resolved provider tag (e.g. 'claude'). Nullable for
    // sessions that predate the SigmaCode launcher façade.
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
    // v1.4.1 — which Jorvis conversation is monitoring this session for pane events.
    jorvisMonitorConversationId: text('jorvis_monitor_conversation_id'),
    // SF-8 Yolo/Bypass launch mode — 0/1 boolean persisted here so that a
    // workspace resume re-applies the provider's bypass flag without requiring
    // the renderer to re-submit it. Migration 0024 adds the column.
    autoApprove: integer('auto_approve').notNull().default(0),
    // SF-10 — display-only CLI label override (migration 0025). NULL = show the
    // real provider_id; a providers.ts id = show that name/colour instead.
    // Cosmetic; does NOT affect spawn/resume/MCP.
    displayProviderId: text('display_provider_id'),
    // v1.4.3 #06 — Pane Split + Minimise. NULL columns mean the pane is a
    // standalone tile in the grid (the legacy shape). When set, the four
    // columns describe membership in a 2-pane split group:
    //   split_group_id  – shared id linking the two halves
    //   split_direction – 'horizontal' (top/bottom) or 'vertical' (left/right)
    //   split_index     – 0 or 1 (position inside the group)
    // `minimised` is a 0/1 boolean and toggles the collapsed-header rendering.
    splitGroupId: text('split_group_id'),
    splitDirection: text('split_direction', { enum: ['horizontal', 'vertical'] }),
    splitIndex: integer('split_index'),
    minimised: integer('minimised').notNull().default(0),
    // BSP-O4 — operator-supplied display name. NULL = use computed alias.
    name: text('name'),
    // 0037 — deliberate-close soft-delete marker (epoch-ms). NULL = open.
    // DURABLE close marker: every resume/rehydrate/toast-suppression path keys
    // off this, NOT status (the late onExit write can clobber status).
    closedAt: integer('closed_at'),
  },
  (t) => ({
    wsIdx: index('agent_sessions_ws_idx').on(t.workspaceId),
    statusIdx: index('agent_sessions_status_idx').on(t.status),
    closedIdx: index('agent_sessions_closed_idx').on(t.workspaceId, t.closedAt),
    wsPaneIdx: index('agent_sessions_ws_pane_idx').on(
      t.workspaceId,
      t.paneIndex,
      t.startedAt,
    ),
    // v1.4.3 #06 — accelerates "fetch every pane in this split group for the
    // current workspace" lookups during grid layout.
    splitIdx: index('agent_sessions_split_idx').on(
      t.workspaceId,
      t.splitGroupId,
    ),
    // v1.5.5 Cluster A + ADR-005 — uniqueness on (workspace_id, pane_index).
    // The LIVE index is STATUS-AWARE: it only enforces uniqueness for
    // pane_index IS NOT NULL AND status IN ('running','starting') so that an
    // exited/error row keeps its pane_index (for resume) without blocking a
    // fresh spawn into that slot (CRIT-2 post-crash lockout). Drizzle's
    // uniqueIndex().on() cannot express the partial WHERE, so the real DDL is
    // owned by migration 0032; this declaration is intentionally a superset.
    wsPaneUq: uniqueIndex('agent_sessions_ws_pane_uq').on(
      t.workspaceId,
      t.paneIndex,
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
    // DEV-2 (migration 0033): null = open; epoch-ms = closed (soft-delete for Recents).
    closedAt: integer('closed_at'),
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
    // P4.2 MEM-5 — cached JSON array of alternate names this note resolves
    // under (the frontmatter `aliases:` list, filtered to strings). NULL when
    // the note has no aliases. Migration 0030 adds the column; resolution of
    // wikilinks/backlinks/graph through aliases reads this cache.
    aliasesJson: text('aliases_json'),
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

// P6 FEAT-11 — agent undo/rewind. One row per checkpoint: a git commit on a
// pane's own worktree branch that captures a savepoint of the WIP. `kind` is
// 'manual' (operator pressed "Create checkpoint") or 'auto' (the pre-rewind
// safety snapshot written by `restoreCheckpoint` before its destructive
// `git reset --hard`). Migration 0028 owns the DDL; this Drizzle table mirrors
// it so the gitCtl checkpoint methods stay end-to-end typed.
export const sessionCheckpoints = sqliteTable(
  'session_checkpoints',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    sha: text('sha').notNull(),
    label: text('label'),
    kind: text('kind', { enum: ['auto', 'manual'] }).notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sessionCheckpointsSessionIdx: index('session_checkpoints_session_idx').on(t.sessionId),
  }),
);

export type SessionCheckpointRow = typeof sessionCheckpoints.$inferSelect;
export type SessionCheckpointInsert = typeof sessionCheckpoints.$inferInsert;

// P6 FEAT-3 — per-pane / per-workspace usage & cost ledger. One row per
// recorded Claude CLI turn, harvested from the `result` envelope
// (`total_cost_usd` + `usage{}`). Only the in-app Jorvis assistant CLI turn
// path emits machine-readable usage today, so rows are keyed by
// `conversationId` (the assistant has no agent_sessions row); `sessionId` is
// reserved for any future PTY-session source and stays NULL for assistant turns.
// Migration 0029 owns the DDL; this Drizzle table mirrors it so the usage DAO
// stays end-to-end typed.
export const usageLedger = sqliteTable(
  'usage_ledger',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id'),
    conversationId: text('conversation_id'),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    totalCostUsd: real('total_cost_usd'),
    recordedAt: integer('recorded_at').notNull(),
  },
  (t) => ({
    usageLedgerSessionIdx: index('usage_ledger_session_idx').on(t.sessionId, t.recordedAt),
    usageLedgerRecordedIdx: index('usage_ledger_recorded_idx').on(t.recordedAt),
  }),
);

export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type UsageLedgerInsert = typeof usageLedger.$inferInsert;

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

// Phase — V3-W13-013 — Sigma Assistant chat persistence.
// Migration 0006_assistant owns the DDL; these Drizzle tables mirror it so
// the assistant controller and conversations DAO stay end-to-end typed.
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    kind: text('kind', { enum: ['assistant', 'swarm_dm'] }).notNull(),
    // v1.4.0 — Claude CLI session id captured from Sigma Assistant turns.
    claudeSessionId: text('claude_session_id'),
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

export const jorvisPaneEvents = sqliteTable(
  'jorvis_pane_events',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    sessionId: text('session_id').notNull(),
    kind: text('kind', { enum: ['started', 'exited', 'error', 'output-spike', 'idle'] }).notNull(),
    body: text('body'),
    ts: integer('ts').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    convTsIdx: index('jorvis_pane_events_conv_ts').on(t.conversationId, t.ts),
  }),
);
export type JorvisPaneEventRow = typeof jorvisPaneEvents.$inferSelect;
export type JorvisPaneEventInsert = typeof jorvisPaneEvents.$inferInsert;

// Phase 20 P1a — Jorvis mission board. Migration 0039_missions owns the DDL;
// these Drizzle tables mirror it. LOCAL-ONLY — not in the sync allowlist.
export const missions = sqliteTable(
  'missions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    goal: text('goal').notNull(),
    origin: text('origin', { enum: ['local', 'telegram', 'external', 'autonomous'] }).notNull(),
    clientLabel: text('client_label'),
    workspaceId: text('workspace_id'),
    status: text('status', { enum: ['draft', 'active', 'paused', 'done', 'failed', 'cancelled'] })
      .notNull()
      .default('draft'),
    report: text('report'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ missionsStatusIdx: index('missions_status_idx').on(t.status) }),
);

export const missionTasks = sqliteTable(
  'mission_tasks',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id').notNull(),
    title: text('title').notNull(),
    spec: text('spec').notNull().default(''),
    status: text('status', {
      enum: ['backlog', 'dispatched', 'working', 'reviewing', 'needs_input', 'done', 'blocked'],
    })
      .notNull()
      .default('backlog'),
    assigneeSessionId: text('assignee_session_id'),
    worktreePath: text('worktree_path'),
    attempt: integer('attempt').notNull().default(0),
    orderIdx: integer('order_idx').notNull().default(0),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    missionTasksMissionStatusIdx: index('mission_tasks_mission_status_idx').on(t.missionId, t.status),
    missionTasksAssigneeIdx: index('mission_tasks_assignee_idx').on(t.assigneeSessionId),
  }),
);

export const missionEvents = sqliteTable(
  'mission_events',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id').notNull(),
    taskId: text('task_id'),
    kind: text('kind').notNull(),
    body: text('body'),
    ts: integer('ts').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ missionEventsMissionTsIdx: index('mission_events_mission_ts_idx').on(t.missionId, t.ts) }),
);

export type MissionRow = typeof missions.$inferSelect;
export type MissionInsert = typeof missions.$inferInsert;
export type MissionTaskRow = typeof missionTasks.$inferSelect;
export type MissionTaskInsert = typeof missionTasks.$inferInsert;
export type MissionEventRow = typeof missionEvents.$inferSelect;
export type MissionEventInsert = typeof missionEvents.$inferInsert;

// Phase — V3-W14-006 — Sigma Canvas persistence.
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

// Phase 3 Step 7 — Sigma Assistant cross-session persistence: swarm origins.
// Migration 0009_swarm_origins owns the DDL; this Drizzle table mirrors it.
// Each row is a back-link from a `swarms.id` to the (`conversationId`,
// `messageId`) pair that triggered the swarm via the assistant's
// `create_swarm` tool, enabling the Operator Console to render a
// "Started from Sigma Assistant chat" link back to the originating turn.
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

// v1.4.9 #07 — Notifications + top-right bell. Migration 0018 owns the DDL;
// this Drizzle table mirrors it so the notifications manager + controller
// stay end-to-end typed. The schema is irreversible and the column set
// (severity / dedup_key / dup_count) is locked per the v1.4.8 reviewer's
// D1–D6 taxonomy decisions. See
// `docs/03-plan/v1.4.8-bundle/07-notifications-bell.md` for rationale.
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    /** NULLABLE so app-global events (auth invalid, sync conflicts) coexist
     *  with per-workspace rows in the same table. */
    workspaceId: text('workspace_id'),
    /** 'pty-exit' | 'swarm-message' | 'tool-error' | '<kind>-summary'. */
    kind: text('kind').notNull(),
    /** D1 — 4-level scale. SQLite has no CHECK; the manager validates. */
    severity: text('severity', { enum: ['info', 'warn', 'error', 'critical'] })
      .notNull()
      .default('info'),
    title: text('title').notNull(),
    body: text('body'),
    /** Kind-specific JSON (pane id, swarm id, conv id, message id, etc.). */
    payload: text('payload'),
    /** Source channel that emitted this — e.g. 'pty:exit', 'swarm:message'. */
    sourceEvent: text('source_event'),
    /** D3 — collapse tuple supplied by every source (NEVER null). */
    dedupKey: text('dedup_key').notNull(),
    /** D3 — absorbed event count; starts at 1, incremented on dedup hit. */
    dupCount: integer('dup_count').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => ({
    workspaceIdx: index('idx_notifications_workspace').on(t.workspaceId, t.createdAt),
    unreadIdx: index('idx_notifications_unread').on(t.readAt),
    dedupIdx: index('idx_notifications_dedup').on(t.workspaceId, t.dedupKey, t.createdAt),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationInsert = typeof notifications.$inferInsert;

// v1.5.0 packet 09 — Cross-machine sync metadata tables.
// Migration 0019_sync_metadata owns the DDL; these Drizzle tables mirror it
// so the sync engine stays end-to-end typed. NO plaintext row bodies are
// stored here — only pointers, packed HLC values, and JSON snapshots for
// conflict resolution review.
export const syncState = sqliteTable(
  'sync_state',
  {
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    hlcWallMs: integer('hlc_wall_ms').notNull(),
    hlcLogical: integer('hlc_logical').notNull(),
    hlcMachineId: text('hlc_machine_id').notNull(), // hex-encoded 16 bytes
    rowHash: text('row_hash').notNull(),
    dirty: integer('dirty').notNull().default(0),
    lastPushedAt: integer('last_pushed_at'),
  },
);

export const syncConflicts = sqliteTable(
  'sync_conflicts',
  {
    id: text('id').primaryKey(),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    localHlcPacked: text('local_hlc_packed').notNull(), // hex-encoded
    remoteHlcPacked: text('remote_hlc_packed').notNull(),
    remoteMachineId: text('remote_machine_id').notNull(), // hex-encoded
    localRowJson: text('local_row_json').notNull(),
    remoteRowJson: text('remote_row_json').notNull(),
    resolved: integer('resolved').notNull().default(0),
    resolution: text('resolution'),
    resolvedAt: integer('resolved_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    unresolvedIdx: index('idx_sync_conflicts_unresolved').on(t.resolved, t.createdAt),
  }),
);

export const syncHistory = sqliteTable(
  'sync_history',
  {
    id: text('id').primaryKey(),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    appliedAt: integer('applied_at').notNull(),
    source: text('source').notNull(), // 'remote' | 'conflict_resolution'
  },
  (t) => ({
    appliedIdx: index('idx_sync_history_applied').on(t.appliedAt),
  }),
);

export const syncQuarantine = sqliteTable('sync_quarantine', {
  id: text('id').primaryKey(),
  blobPath: text('blob_path').notNull(),
  reason: text('reason').notNull(), // 'aead_fail' | 'schema_unknown' | 'malformed'
  detectedAt: integer('detected_at').notNull(),
});

export const syncPendingUpgrade = sqliteTable('sync_pending_upgrade', {
  id: text('id').primaryKey(),
  blobPath: text('blob_path').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  queuedAt: integer('queued_at').notNull(),
});

export const syncTombstones = sqliteTable(
  'sync_tombstones',
  {
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    deletedAt: integer('deleted_at').notNull(),
    hlcPacked: text('hlc_packed').notNull(), // hex-encoded
  },
  (t) => ({
    gcIdx: index('idx_sync_tombstones_gc').on(t.deletedAt),
  }),
);

export type SyncStateRow = typeof syncState.$inferSelect;
export type SyncStateInsert = typeof syncState.$inferInsert;
export type SyncConflictRow = typeof syncConflicts.$inferSelect;
export type SyncConflictInsert = typeof syncConflicts.$inferInsert;
export type SyncHistoryRow = typeof syncHistory.$inferSelect;
export type SyncHistoryInsert = typeof syncHistory.$inferInsert;
export type SyncQuarantineRow = typeof syncQuarantine.$inferSelect;
export type SyncQuarantineInsert = typeof syncQuarantine.$inferInsert;
export type SyncPendingUpgradeRow = typeof syncPendingUpgrade.$inferSelect;
export type SyncPendingUpgradeInsert = typeof syncPendingUpgrade.$inferInsert;
export type SyncTombstoneRow = typeof syncTombstones.$inferSelect;
export type SyncTombstoneInsert = typeof syncTombstones.$inferInsert;

// v1.7.1 W-5 Skills Phase 2 — INFORMATIONAL skill binding persistence.
// Migration 0021_skill_bindings owns the DDL; this Drizzle table mirrors it so
// the skills controller stays end-to-end typed. A NULL pane_session_id means
// the binding is workspace-wide; a non-null value means pane-scoped.
//
// SCOPE: INFORMATIONAL ONLY. This table records a visual association between
// a skill and a pane/workspace. It does NOT affect agent dispatch, does NOT
// inject into agent context, and does NOT alter Sigma/Jorvis tool-calling.
// Behavioral activation is a deferred future enhancement.
export const skillBindings = sqliteTable(
  'skill_bindings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    /** NULL = workspace-wide binding; non-null = pane-scoped binding. */
    paneSessionId: text('pane_session_id'),
    skillName: text('skill_name').notNull(),
    skillSource: text('skill_source').notNull(),
    attachedAt: integer('attached_at').notNull(),
  },
  (t) => ({
    skillBindingsWsIdx: index('skill_bindings_ws_idx').on(t.workspaceId),
  }),
);

export type SkillBindingRow = typeof skillBindings.$inferSelect;
export type SkillBindingInsert = typeof skillBindings.$inferInsert;

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
