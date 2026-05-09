// The cross-process Router type. Imported by both main (to enforce controller shape)
// and renderer (to type the RPC client). NO runtime imports of Node code here.

import type {
  Workspace,
  ProviderProbe,
  AgentSession,
  GitStatus,
  GitDiff,
  LaunchPlan,
  CreateSwarmInput,
  Swarm,
  SwarmMessage,
  SwarmMessageKind,
  BrowserState,
  BrowserTab,
  Skill,
  SkillProviderState,
  Memory,
  MemorySearchHit,
  MemoryGraph,
  MemoryHubStatus,
  MemoryConnectionSuggestion,
  ReviewState,
  ReviewDiff,
  ReviewConflict,
  BatchCommitResult,
  Task,
  TaskAssignment,
  TaskComment,
  TaskStatus,
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
  swarms: {
    create: (input: CreateSwarmInput) => Promise<Swarm>;
    list: (workspaceId: string) => Promise<Swarm[]>;
    get: (id: string) => Promise<Swarm | null>;
    sendMessage: (input: {
      swarmId: string;
      toAgent: string; // agentKey or '*'
      body: string;
      kind?: SwarmMessageKind;
    }) => Promise<SwarmMessage>;
    broadcast: (swarmId: string, body: string) => Promise<SwarmMessage>;
    rollCall: (swarmId: string) => Promise<SwarmMessage>;
    tail: (swarmId: string, opts?: { limit?: number }) => Promise<SwarmMessage[]>;
    kill: (id: string) => Promise<void>;
  };
  browser: {
    openTab: (input: { workspaceId: string; url?: string }) => Promise<BrowserTab>;
    closeTab: (input: { workspaceId: string; tabId: string }) => Promise<void>;
    navigate: (input: { workspaceId: string; tabId: string; url: string }) => Promise<void>;
    back: (input: { workspaceId: string; tabId: string }) => Promise<void>;
    forward: (input: { workspaceId: string; tabId: string }) => Promise<void>;
    reload: (input: { workspaceId: string; tabId: string }) => Promise<void>;
    stop: (input: { workspaceId: string; tabId: string }) => Promise<void>;
    listTabs: (workspaceId: string) => Promise<BrowserTab[]>;
    getActiveTab: (workspaceId: string) => Promise<BrowserTab | null>;
    setActiveTab: (input: { workspaceId: string; tabId: string }) => Promise<void>;
    setBounds: (input: { workspaceId: string; bounds: { x: number; y: number; width: number; height: number } | null }) => Promise<void>;
    getState: (workspaceId: string) => Promise<BrowserState>;
    claimDriver: (input: { workspaceId: string; agentKey: string; label?: string }) => Promise<void>;
    releaseDriver: (input: { workspaceId: string }) => Promise<void>;
    getMcpUrl: (workspaceId: string) => Promise<string | null>;
    teardown: (workspaceId: string) => Promise<void>;
  };
  skills: {
    list: () => Promise<{ skills: Skill[]; states: SkillProviderState[] }>;
    ingestFolder: (input: { path: string; force?: boolean }) => Promise<Skill>;
    ingestZip: (input: { path: string; force?: boolean }) => Promise<Skill>;
    enableForProvider: (input: { skillId: string; provider: string }) => Promise<SkillProviderState>;
    disableForProvider: (input: { skillId: string; provider: string }) => Promise<SkillProviderState>;
    uninstall: (skillId: string) => Promise<void>;
    getReadme: (skillId: string) => Promise<{ name: string; body: string } | null>;
  };
  memory: {
    // CRUD (6)
    list_memories: (input: { workspaceId: string }) => Promise<Memory[]>;
    read_memory: (input: { workspaceId: string; name: string }) => Promise<Memory | null>;
    create_memory: (input: {
      workspaceId: string;
      name: string;
      body?: string;
      tags?: string[];
    }) => Promise<Memory>;
    update_memory: (input: {
      workspaceId: string;
      name: string;
      body?: string;
      tags?: string[];
    }) => Promise<Memory>;
    append_to_memory: (input: {
      workspaceId: string;
      name: string;
      text: string;
    }) => Promise<Memory>;
    delete_memory: (input: { workspaceId: string; name: string }) => Promise<void>;
    // Discovery (4)
    search_memories: (input: {
      workspaceId: string;
      query: string;
      limit?: number;
    }) => Promise<MemorySearchHit[]>;
    find_backlinks: (input: { workspaceId: string; name: string }) => Promise<Memory[]>;
    list_orphans: (input: { workspaceId: string }) => Promise<Memory[]>;
    suggest_connections: (input: {
      workspaceId: string;
      name: string;
    }) => Promise<MemoryConnectionSuggestion[]>;
    // Hub Management (2)
    init_hub: (input: { workspaceId: string }) => Promise<MemoryHubStatus>;
    hub_status: (input: { workspaceId: string }) => Promise<MemoryHubStatus>;
    // Renderer-only helpers
    getGraph: (input: { workspaceId: string }) => Promise<MemoryGraph>;
    getMcpCommand: (input: {
      workspaceId: string;
    }) => Promise<{ command: string; args: string[] } | null>;
  };
  review: {
    list: (workspaceId: string) => Promise<ReviewState>;
    getDiff: (sessionId: string) => Promise<ReviewDiff | null>;
    getConflicts: (sessionId: string) => Promise<ReviewConflict[]>;
    runCommand: (input: {
      sessionId: string;
      command: string;
    }) => Promise<{ runId: string }>;
    killCommand: (sessionId: string) => Promise<void>;
    setNotes: (input: { sessionId: string; notes: string }) => Promise<void>;
    markPassed: (sessionId: string) => Promise<void>;
    markFailed: (sessionId: string) => Promise<void>;
    commitAndMerge: (input: {
      sessionId: string;
      message: string;
    }) => Promise<{ stdout: string; stderr: string; code: number }>;
    dropChanges: (sessionId: string) => Promise<{ code: number; stderr: string }>;
    pruneOrphans: (workspaceId: string) => Promise<void>;
    batchCommitAndMerge: (input: {
      sessionIds: string[];
      messageTemplate: string;
    }) => Promise<BatchCommitResult>;
  };
  kv: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
  };
  tasks: {
    list: (workspaceId: string) => Promise<Task[]>;
    get: (id: string) => Promise<Task | null>;
    create: (input: {
      workspaceId: string;
      title: string;
      description?: string;
      status?: TaskStatus;
      labels?: string[];
      assignment?: TaskAssignment;
    }) => Promise<Task>;
    update: (input: {
      id: string;
      title?: string;
      description?: string;
      status?: TaskStatus;
      labels?: string[];
      assignment?: TaskAssignment | null;
    }) => Promise<Task>;
    remove: (id: string) => Promise<void>;
    setStatus: (input: { id: string; status: TaskStatus }) => Promise<Task>;
    assign: (input: {
      id: string;
      assignment: TaskAssignment | null;
    }) => Promise<Task>;
    assignToSwarmAgent: (input: {
      taskId: string;
      swarmId: string;
      agentKey: string;
      swarmAgentId: string;
    }) => Promise<Task>;
    listComments: (taskId: string) => Promise<TaskComment[]>;
    addComment: (input: {
      taskId: string;
      author?: string;
      body: string;
    }) => Promise<TaskComment>;
    removeComment: (commentId: string) => Promise<void>;
  };
}
