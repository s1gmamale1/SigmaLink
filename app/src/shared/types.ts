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
}

export type GridPreset = 1 | 2 | 4 | 6 | 8 | 10 | 12 | 14 | 16 | 18 | 20;

export interface PaneAssignment {
  paneIndex: number;
  providerId: string;
  initialPrompt?: string;
}

export interface LaunchPlan {
  workspaceRoot: string;
  preset: GridPreset;
  baseRef?: string;
  panes: PaneAssignment[];
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
  }>;
  edges: Array<{ from: MemoryId; to: MemoryId }>;
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
