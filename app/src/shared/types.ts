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

export type GridPreset = 1 | 2 | 4 | 6 | 8 | 10 | 12 | 14 | 16;

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

export type SwarmPreset = 'squad' | 'team' | 'platoon' | 'legion' | 'custom';

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
