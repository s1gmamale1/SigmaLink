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
