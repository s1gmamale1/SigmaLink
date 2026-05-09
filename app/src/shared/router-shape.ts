// The cross-process Router type. Imported by both main (to enforce controller shape)
// and renderer (to type the RPC client). NO runtime imports of Node code here.

import type {
  Workspace,
  ProviderProbe,
  AgentSession,
  GitStatus,
  GitDiff,
  LaunchPlan,
} from './types';

export interface AppRouter {
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<NodeJS.Platform>;
  };
  pty: {
    create: (input: {
      providerId: string;
      cwd: string;
      cols: number;
      rows: number;
      args?: string[];
      env?: Record<string, string>;
      initialPrompt?: string;
    }) => Promise<{ sessionId: string; pid: number }>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    kill: (sessionId: string) => Promise<void>;
    subscribe: (sessionId: string) => Promise<{ history: string }>; // returns ring buffer + registers consumer
    list: () => Promise<Array<{ sessionId: string; providerId: string; cwd: string; alive: boolean }>>;
    forget: (sessionId: string) => Promise<void>;
  };
  providers: {
    list: () => Promise<
      Array<{ id: string; name: string; description: string; color: string; icon: string; installHint: string }>
    >;
    probeAll: () => Promise<ProviderProbe[]>;
    probe: (id: string) => Promise<ProviderProbe>;
  };
  workspaces: {
    pickFolder: () => Promise<{ path: string } | null>;
    open: (root: string) => Promise<Workspace>;
    list: () => Promise<Workspace[]>;
    remove: (id: string) => Promise<void>;
    launch: (plan: LaunchPlan) => Promise<{ sessions: AgentSession[] }>;
  };
  git: {
    status: (cwd: string) => Promise<GitStatus | null>;
    diff: (cwd: string) => Promise<GitDiff | null>;
    runCommand: (cwd: string, line: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; code: number }>;
    commitAndMerge: (input: {
      worktreePath: string;
      branch: string;
      repoRoot: string;
      message: string;
    }) => Promise<{ stdout: string; stderr: string; code: number }>;
    worktreeRemove: (worktreePath: string) => Promise<void>;
  };
  fs: {
    exists: (path: string) => Promise<boolean>;
  };
}
