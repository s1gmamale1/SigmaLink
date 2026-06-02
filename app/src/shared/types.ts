// Cross-process domain types.

export type WorkspaceId = string;
export type ProjectId = string;
export type SessionId = string; // PTY session id
export type TaskId = string;

export type RepoMode = 'git' | 'plain';

export interface Workspace {
  id: WorkspaceId;
  name: string;
  rootPath: string;
  repoRoot: string | null;
  repoMode: RepoMode;
  createdAt: number;
  lastOpenedAt: number;
}

export type SplitDirection = 'horizontal' | 'vertical';

export interface AgentSession {
  id: SessionId;
  workspaceId: WorkspaceId;
  providerId: string;
  cwd: string;
  branch: string | null;
  status: 'starting' | 'running' | 'exited' | 'error';
  exitCode?: number;
  startedAt: number;
  exitedAt?: number;
  worktreePath: string | null;
  initialPrompt?: string;
  /**
   * Populated when the launcher could not bring the pane up (e.g. worktree
   * creation failed, PTY spawn failed). Renderer surfaces it inline.
   */
  error?: string;
  // v1.4.3 #06 — Pane Split + Minimise. NULL fields mean the pane is a
  // standalone tile in the grid; when set, the three split fields describe
  // membership in a 2-pane split group (max-depth 2 in v1.4.x).
  splitGroupId?: string | null;
  splitDirection?: SplitDirection | null;
  splitIndex?: number | null;
  /** v1.4.3 #06 — collapsed-to-header-strip toggle. */
  minimised?: boolean;
  /**
   * SF-8 — Yolo/Bypass mode this pane was launched with (persisted on
   * agent_sessions.auto_approve so resume re-applies the provider bypass flag).
   */
  autoApprove?: boolean;
  /**
   * SF-10 — display-only CLI label override. When set (a providers.ts id), the
   * pane header shows that provider's name + colour instead of `providerId`.
   * Cosmetic only — spawn/resume/MCP still use the real `providerId`.
   */
  displayProviderId?: string | null;
}

export interface ProviderProbe {
  id: string;
  found: boolean;
  resolvedPath?: string;
  version?: string;
  error?: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

export interface GitDiff {
  stat: string;
  patches: string;
  untrackedFiles: string[];
  /**
   * True when the `git diff HEAD` output was cut because it exceeded the
   * maxBuffer cap. Callers should surface a warning rather than treating the
   * patches as complete.
   */
  truncated: boolean;
}

export type GridPreset = 1 | 2 | 4 | 6 | 8 | 10 | 12 | 14 | 16 | 18 | 20;

export interface PaneAssignment {
  paneIndex: number;
  providerId: string;
  initialPrompt?: string;
  /**
   * SF-8 — Yolo/Bypass launch mode. When true, the launcher appends the
   * provider's `autoApproveFlag` (claude `--dangerously-skip-permissions`,
   * codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--yolo`,
   * cursor `--force`). No-op for providers without an autoApproveFlag
   * (kimi/opencode/shell). Defaults to false (Yolo OFF).
   */
  autoApprove?: boolean;
}

export interface LaunchPlan {
  workspaceRoot: string;
  preset: GridPreset;
  baseRef?: string;
  panes: PaneAssignment[];
  /**
   * v1.3.0 — Session picker resume plan. When present, the launcher uses
   * `buildResumeArgs` to inject the session id into the spawn args for each
   * pane slot whose `sessionId` is non-null. The external session id is also
   * pre-stamped into `agent_sessions.externalSessionId` at insert time so the
   * v1.2.8 disk-scan capture path becomes a no-op for resumed sessions.
   */
  paneResumePlan?: Array<{ paneIndex: number; sessionId: string | null }>;
}

// ──────────────────────────────────────────────────────────────────────────
// Swarm Room (Phase 2)
// ──────────────────────────────────────────────────────────────────────────

export type SwarmId = string;
export type SwarmAgentId = string;

export type Role = 'coordinator' | 'builder' | 'scout' | 'reviewer';

// V3-W12-009: Legion → Battalion rename. Existing 'legion' rows in the DB
// stay readable (CHECK constraint accepts both via SQLite's lenient
// re-verification rule); new swarms must use 'battalion' or one of the
// canonical V3 presets. See docs/02-research/v3-agent-roles-delta.md §2.
export type SwarmPreset = 'squad' | 'team' | 'platoon' | 'battalion' | 'legion' | 'custom';

export type SwarmStatus = 'running' | 'paused' | 'completed' | 'failed';

export type SwarmMessageKind =
  | 'SAY'
  | 'ACK'
  | 'STATUS'
  | 'DONE'
  | 'OPERATOR'
  | 'ROLLCALL'
  | 'ROLLCALL_REPLY'
  | 'SYSTEM';

export interface RoleAssignment {
  role: Role;
  roleIndex: number; // 1-based
  providerId: string;
  /** V3-W12-018: optional model id (resolves via models.ts). */
  modelId?: string;
  /** V3-W12-018: per-row auto-approve toggle. Defaults to false. */
  autoApprove?: boolean;
  /**
   * C-12 SigmaBench: per-agent initial prompt sent to the CLI at spawn (via
   * buildExtraArgs / stdin). Optional — legacy roster callers leave it unset
   * and agents spawn idle as before; SigmaBench sets it so each benched agent
   * autonomously works the task.
   */
  initialPrompt?: string;
}

export interface SwarmAgent {
  id: SwarmAgentId;
  swarmId: SwarmId;
  role: Role;
  roleIndex: number;
  providerId: string;
  sessionId: string | null;
  status: 'idle' | 'busy' | 'blocked' | 'done' | 'error';
  inboxPath: string;
  agentKey: string; // e.g. "coordinator-1"
  /** V3-W12-018: per-agent auto-approve toggle, persisted on swarm_agents. */
  autoApprove?: boolean;
}

export interface Swarm {
  id: SwarmId;
  workspaceId: WorkspaceId;
  name: string;
  mission: string;
  preset: SwarmPreset;
  status: SwarmStatus;
  createdAt: number;
  endedAt: number | null;
  agents: SwarmAgent[];
}

export interface SwarmMessage {
  id: string;
  swarmId: SwarmId;
  fromAgent: string; // 'operator' or agentKey
  toAgent: string;   // '*' (broadcast) or agentKey
  kind: SwarmMessageKind;
  body: string;
  payload?: Record<string, unknown>;
  ts: number;
  readAt?: number | null;
}

export interface CreateSwarmInput {
  workspaceId: WorkspaceId;
  mission: string;
  preset: SwarmPreset;
  name?: string;
  baseRef?: string;
  // Provider assignment per role; one entry per agent in the roster.
  roster: RoleAssignment[];
}

export interface AddAgentToSwarmInput {
  swarmId: SwarmId;
  providerId: string;
  role?: Role;
  initialPrompt?: string;
  /**
   * SF-8 — Yolo/Bypass launch mode for the `+Pane` flow. When true, the swarm
   * spawn appends the provider's `autoApproveFlag` (claude
   * `--dangerously-skip-permissions`, etc.). No-op for providers without one.
   * Persisted on `swarm_agents.auto_approve` + `agent_sessions.auto_approve`.
   */
  autoApprove?: boolean;
  /**
   * v1.4.3 #06 — Pane Split. When set, the new pane shares the parent's
   * worktree (no new git worktree is allocated) and inherits the parent's
   * `cwd`. All standalone `addAgent` callers leave this undefined so the
   * legacy "create fresh worktree" path is unchanged.
   */
  worktreePath?: string;
  /**
   * v1.4.3 #06 — same intent as `worktreePath`; only consulted when the
   * worktreePath override is provided so the sub-pane lands in the same cwd
   * as the parent.
   */
  cwd?: string;
  /**
   * v1.4.3 #06 — same intent as `worktreePath`; only consulted when the
   * worktreePath override is provided so the sub-pane lands on the same git
   * branch as the parent.
   */
  branch?: string | null;
}

export interface AddAgentToSwarmResult {
  sessionId: SessionId;
  paneIndex: number;
  agentKey: string;
  session: AgentSession;
  swarm: Swarm;
}

// ──────────────────────────────────────────────────────────────────────────
// Browser Room (Phase 3)
// ──────────────────────────────────────────────────────────────────────────

export type TabId = string;

export interface BrowserTab {
  id: TabId;
  workspaceId: WorkspaceId;
  url: string;
  title: string;
  active: boolean;
  createdAt: number;
  lastVisitedAt: number;
}

/**
 * Identifies who currently holds the "driver" lock on the browser pane.
 * `null` when no agent is driving and the user has full control. The
 * `agentKey` mirrors `SwarmAgent.agentKey` (e.g., "builder-1") when an
 * agent claims the lock through the MCP bridge.
 */
export interface LockOwner {
  agentKey: string;
  claimedAt: number;
  label?: string;
}

export interface BrowserState {
  workspaceId: WorkspaceId;
  tabs: BrowserTab[];
  activeTabId: TabId | null;
  lockOwner: LockOwner | null;
  mcpUrl: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Skills Room (Phase 4)
// ──────────────────────────────────────────────────────────────────────────

export type SkillId = string;
export type SkillProviderId = 'claude' | 'codex' | 'gemini';

export interface Skill {
  id: SkillId;
  name: string;
  description: string;
  version?: string;
  /** Optional tag list pulled from frontmatter (renderer chips). */
  tags?: string[];
  /** Sha-256 of the managed folder contents (relpath:size:filehash join). */
  contentHash: string;
  /** Absolute path under `<userData>/skills/<name>/`. */
  managedPath: string;
  installedAt: number;
}

export interface SkillProviderState {
  skillId: SkillId;
  providerId: SkillProviderId;
  enabled: boolean;
  lastFanoutAt?: number;
  lastError?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Memory (Phase 5)
// ──────────────────────────────────────────────────────────────────────────

export type MemoryId = string;

export interface Memory {
  id: MemoryId;
  workspaceId: WorkspaceId;
  name: string;
  body: string;
  tags: string[];
  links: string[]; // outgoing wikilink targets (de-duplicated, in order seen)
  createdAt: number;
  updatedAt: number;
  /** P4 BUG-10 — parsed YAML frontmatter (properties / aliases). Null/absent when none. */
  frontmatter?: Record<string, unknown> | null;
}

export interface MemorySearchHit {
  id: MemoryId;
  name: string;
  snippet: string;
  score: number;
  updatedAt: number;
}

export interface MemoryGraph {
  nodes: Array<{
    id: MemoryId;
    label: string;
    tagCount: number;
    refCount: number; // incoming link count (backlinks)
    /** P4 MEM-1 — node class. Local notes default to 'note'; Ruflo AgentDB entries 'ruflo'. */
    kind?: 'note' | 'ruflo';
    /** P4 MEM-1 — Ruflo namespace (patterns/feedback/verdict/…) used as a color + legend facet. */
    group?: string;
  }>;
  edges: Array<{
    from: MemoryId;
    to: MemoryId;
    /** P4 MEM-1 — wikilink (default, between notes) vs Ruflo similarity/causal edges. */
    kind?: 'wikilink' | 'similarity' | 'causal';
    /** P4 MEM-1 — similarity weight 0..1 (Ruflo similarity edges only). */
    weight?: number;
  }>;
}

/** P4 MEM-1 — a Ruflo AgentDB entry surfaced into the Memory graph as a
 *  distinct, read-only node class. `id` is the stable AgentDB key. */
export interface RufloEntry {
  id: string;
  text: string;
  namespace: string;
  score?: number;
  createdAt?: number;
}

/** P4 MEM-1 — an edge between two Ruflo entries (semantic similarity now;
 *  causal edges are a P4.2 follow-up pending the daemon's read API). */
export interface RufloEntryEdge {
  fromId: string;
  toId: string;
  kind: 'similarity' | 'causal';
  weight: number;
}

export interface MemoryHubStatus {
  workspaceId: WorkspaceId;
  hubPath: string;
  memoryCount: number;
  linkCount: number;
  tagCount: number;
  initialized: boolean;
  mcpCommand: string | null;
  mcpArgs: string[];
}

export interface MemoryConnectionSuggestion {
  id: MemoryId;
  name: string;
  sharedTags: string[];
  score: number;
}

/** P4 MEM-3 — a distinct tag in a workspace with its note count. */
export interface MemoryTagCount {
  tag: string;
  count: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Review Room (Phase 6)
// ──────────────────────────────────────────────────────────────────────────

export type ReviewDecision = 'passed' | 'failed' | null;

export interface DiffFileSummary {
  /** Path inside the worktree, forward-slashed. */
  path: string;
  /** Pre-rename path, when applicable. */
  oldPath?: string;
  /**
   * `A`dded, `M`odified, `D`eleted, `R`enamed, `C`opied, `T`ype-change,
   * or `U`ntracked (not yet `git add`ed).
   */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface ReviewDiff {
  repoRoot: string;
  branch: string;
  files: DiffFileSummary[];
  /** Concatenated unified-diff output (`git diff HEAD`). */
  patches: string;
  /** Output of `git diff --stat HEAD`, used as a quick summary. */
  stat: string;
  /** True when patches were trimmed because the repo blew the budget. */
  truncated: boolean;
  /** True if HEAD is detached (pre-commit, rebase in progress, etc.). */
  detached: boolean;
}

export interface ReviewConflict {
  path: string;
  /**
   * Which strategy produced this prediction. Modern git has `merge-tree`,
   * older fallbacks use a name-only intersection heuristic.
   */
  method: 'merge-tree' | 'heuristic' | 'unavailable';
}

export interface ReviewSession {
  sessionId: string;
  workspaceId: string;
  providerId: string;
  branch: string | null;
  worktreePath: string | null;
  cwd: string;
  status: AgentSession['status'];
  startedAt: number;
  notes: string;
  decision: ReviewDecision;
  decidedAt: number | null;
  lastTestCommand: string | null;
  lastTestExitCode: number | null;
  /** Live `git status` summary; populated by the controller's list call. */
  gitStatus?: GitStatus | null;
}

export interface ReviewState {
  workspaceId: string;
  sessions: ReviewSession[];
}

export interface BatchCommitResult {
  results: Array<{
    sessionId: string;
    ok: boolean;
    code: number;
    stderr?: string;
    error?: string;
  }>;
}

// ──────────────────────────────────────────────────────────────────────────
// Tasks / Kanban (Phase 6)
// ──────────────────────────────────────────────────────────────────────────

export type TaskStatus = 'backlog' | 'in_progress' | 'in_review' | 'done' | 'archived';

export interface TaskAssignment {
  /** Direct PTY session assignment (no swarm). */
  sessionId?: string | null;
  /** Swarm container, when assigned via the swarm roster. */
  swarmId?: string | null;
  /** The exact roster slot. */
  swarmAgentId?: string | null;
}

export interface Task {
  id: TaskId;
  workspaceId: WorkspaceId;
  title: string;
  description: string;
  status: TaskStatus;
  assignedSessionId: string | null;
  assignedSwarmId: string | null;
  assignedSwarmAgentId: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface TaskComment {
  id: string;
  taskId: TaskId;
  author: string;
  body: string;
  createdAt: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Notifications (v1.4.9 #07) — top-right bell.
// Cross-process shape; the manager owns the DB persistence and dedup logic.
// See `docs/03-plan/v1.4.8-bundle/07-notifications-bell.md` for the locked
// D1–D6 taxonomy this type encodes.
// ──────────────────────────────────────────────────────────────────────────

/** D1 — 4-level severity scale. `critical` reserved for future events that
 *  block the operator's mental model (DB corruption, auth invalid). */
export type NotificationSeverity = 'info' | 'warn' | 'error' | 'critical';

/** Source channel that produced the row. Free-form so summary rows like
 *  `'pty-exit-summary'` stay typeable without widening the union explosively. */
export type NotificationKind = string;

export interface Notification {
  id: string;
  /** Nullable for app-global events (auth invalid, sync conflicts). */
  workspaceId: WorkspaceId | null;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  /** Mutated by dedup to append ` (×N)` once duplicates absorb. */
  body: string | null;
  /** Kind-specific JSON payload. Parsed at the renderer for deep-linking. */
  payload: Record<string, unknown> | null;
  /** e.g. `'pty:exit'`, `'swarm:message'`, `'assistant:tool-error'`. */
  sourceEvent: string | null;
  /** D3 — collapse tuple. Sources MUST supply this. */
  dedupKey: string;
  /** D3 — absorbed event count; ≥ 1. */
  dupCount: number;
  createdAt: number;
  /** Per-row read marker (D4). `null` means unread. */
  readAt: number | null;
}

/** D2 — IPC delta envelope. Main emits this on every change rather than the
 *  full list (the original v1.4.7 brief's full-list approach saturates IPC
 *  under broadcast flood). Renderer reconciles via reducer. */
export interface NotificationsDelta {
  added: Notification[];
  removed: string[];
  unreadCount: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-machine sync (v1.5.0 packet 09)
// ──────────────────────────────────────────────────────────────────────────

/** Packed HLC value for IPC transport (52-char hex string). */
export type HlcPacked = string;

/**
 * User-provided configuration for the sync feature.
 * SECURITY: username + password are renderer-supplied and forwarded to the
 * main process only for the duration of a setup call. They are NEVER stored
 * in IPC channels as plaintext; the main process stores them via CredentialStore.
 */
export interface SyncConfig {
  remoteUrl: string;
  /** Git HTTPS username / token prefix. */
  username?: string;
  /** Git HTTPS password / personal access token. */
  password?: string;
}

/** Sync status snapshot — safe to cross IPC; contains NO key material. */
export interface SyncStatus {
  enabled: boolean;
  lastPushAt?: number;
  lastPullAt?: number;
  lastError?: string;
  /** Count of unresolved LWW conflicts awaiting user review. */
  pendingConflicts: number;
  /** Count of blobs quarantined pending a schema upgrade. */
  pendingUpgrade: number;
}

/** Conflict record for the renderer's ConflictReview UI. */
export interface SyncConflict {
  id: string;
  tableName: string;
  rowId: string;
  localRowJson: string;
  remoteRowJson: string;
  createdAt: number;
}
