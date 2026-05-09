// ============================================================
// Core Types for Multi-Agent Orchestration Workspace
// ============================================================

export type Room = 'command' | 'swarm' | 'review';

export interface AgentProvider {
  id: string;
  name: string;
  command: string;
  args: string[];
  resumeArgs: string[];
  oneshotArgs: string[];
  installHint: string;
  color: string;
  icon: string;
  description: string;
}

export interface TerminalSession {
  id: string;
  providerId: string;
  worktreePath: string;
  branchName: string;
  repoRoot?: string | null;
  repoPath?: string;
  gitEnabled?: boolean;
  createdWorktree?: boolean;
  status: 'starting' | 'idle' | 'running' | 'completed' | 'error';
  createdAt: number;
  title: string;
  output: string[]; // raw PTY chunks
  pty?: PTYBridge;
}

export interface PTYBridge {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (code: number) => void): void;
  kill(): void;
}

export interface SubTask {
  id: string;
  title: string;
  description: string;
  assignedProvider: string;
  status: 'pending' | 'in_progress' | 'verifying' | 'completed' | 'failed';
  intent: string;
  inputs: string[];
  constraints: string[];
  successCriteria: string;
  verificationResult?: VerificationResult;
  terminalId?: string;
  createdAt: number;
  completedAt?: number;
}

export interface OrchestratorTask {
  id: string;
  title: string;
  description: string;
  subtasks: SubTask[];
  status: 'planning' | 'executing' | 'verifying' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

export interface VerificationResult {
  passed: boolean;
  feedback: string;
  checkedAt: number;
}

export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  timestamp: number;
  type: 'delegation' | 'response' | 'verification' | 'system';
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  agentId: string;
  createdAt: number;
}

export type ThemeMode = 'dark' | 'light';
