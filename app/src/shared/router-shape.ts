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

export interface DiagnosticsReport {
  nativeModules: Array<{ module: string; ok: boolean; error?: string }>;
  env: {
    electron: string | null;
    node: string;
    chrome: string | null;
    platform: NodeJS.Platform;
    arch: string;
    userData: string;
  };
}

/** V3-W14-008 — auto-update check result. The main process never throws on
 *  "no update available" — it returns `{ ok: true, version: undefined }` so
 *  the renderer can show a friendly "you're up to date" toast without a
 *  catch path. `version` is populated when an update IS available. */
export interface CheckForUpdatesResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/**
 * V3-W15-005 — Plan tier surfaced over RPC. Mirrors the `Tier` literal in
 * `app/src/main/core/plan/capabilities.ts` (kept as a string union here so
 * the renderer's router-shape import stays node-free).
 */
export type AppTier = 'basic' | 'pro' | 'ultra';

export interface AppRouter {
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<NodeJS.Platform>;
    diagnostics: () => Promise<DiagnosticsReport>;
    /** V3-W14-008 — manually trigger an `electron-updater` check. */
    checkForUpdates: () => Promise<CheckForUpdatesResult>;
    /**
     * V3-W15-005 — Resolve the active plan tier. Reads `kv['plan.tier']` and
     * falls back to `'ultra'` (SigmaLink default — local-only / free).
     */
    tier: () => Promise<AppTier>;
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
    // V3-W14-007 — Editor right-rail tab needs to walk a workspace's repo root
    // and read/write files into Monaco. Writes are guarded against path
    // traversal by the main-process controller (see core/fs/controller.ts).
    readDir: (input: { path: string }) => Promise<{
      entries: Array<{
        name: string;
        type: 'file' | 'dir';
        size?: number;
        modifiedAt?: number;
      }>;
    }>;
    readFile: (input: { path: string; maxBytes?: number }) => Promise<{
      content: string;
      encoding: 'utf8' | 'binary';
      truncated: boolean;
    }>;
    writeFile: (input: {
      path: string;
      content: string;
      repoRoot: string;
    }) => Promise<{ ok: true }>;
  };
  swarms: {
    create: (input: CreateSwarmInput) => Promise<Swarm>;
    list: (workspaceId: string) => Promise<Swarm[]>;
    get: (id: string) => Promise<Swarm | null>;
    sendMessage: (input: {
      swarmId: string;
      toAgent: string; // agentKey or '*'
      body: string;
      // V3 envelope kinds (e.g. 'skill_toggle', 'directive') are accepted
      // alongside the legacy SIGMA::* verbs — see core/swarms/types.ts for
      // the MailboxKind union. The wire keeps it as a plain string.
      kind?: SwarmMessageKind | string;
      payload?: Record<string, unknown>;
      /** V3-W13-009 — pane-echo for `directive` envelopes. */
      echo?: 'pane';
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
    /**
     * Phase 4 Step 5 — clone a public GitHub repo, validate `SKILL.md`, and
     * forward the unpacked folder into the same `ingestFolder` pipeline that
     * powers drag-and-drop. Subscribes to `skills:install-progress` for
     * per-phase progress; the resolved envelope is returned only at the end.
     * `ownerRepo` accepts both `'owner/repo'` shorthand and a full GitHub URL.
     */
    installFromUrl: (input: {
      ownerRepo: string;
      ref?: string;
      subPath?: string;
      force?: boolean;
    }) => Promise<{
      ok: boolean;
      skill?: Skill;
      fanoutResults?: Array<{
        provider: 'claude' | 'codex' | 'gemini';
        enabled: boolean;
        ok: boolean;
        reason?: string;
      }>;
      error?: {
        code:
          | 'invalid-url'
          | 'metadata-failed'
          | 'download-failed'
          | 'extract-failed'
          | 'no-skill-md'
          | 'invalid-skill'
          | 'ingest-failed'
          | 'update-required';
        message: string;
      };
    }>;
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
  // ────────────────────────────────────────────────────────────────────────
  // V3-W12-017 — placeholder shapes. Bodies are filled in W13/W14/W15:
  //   • assistant.* — V3-W13-013 wires the Bridge Assistant chat panel.
  //   • design.*    — V3-W14-001+ wires the Design Mode / Bridge Canvas.
  //   • voice.*     — V3-W15-001 wires BridgeVoice intake.
  //   • swarm.*     — V3-W12-014 wires the Operator Console controller.
  // Returning `unknown` keeps the type system honest until the controllers
  // exist; renderer call-sites must narrow with their own zod parser when
  // they begin invoking these channels.
  // ────────────────────────────────────────────────────────────────────────
  assistant: {
    /**
     * Append a user message to a conversation (creating one if absent) and
     * spawn a stub assistant turn. Returns the conversation + turn ids so the
     * renderer can correlate streamed deltas. Real LLM integration ships in
     * W14+ — for W13 the assistant emits a canned response.
     */
    send: (input: {
      workspaceId: string;
      conversationId?: string;
      prompt: string;
      attachments?: string[];
    }) => Promise<{ conversationId: string; turnId: string }>;
    list: (input: {
      workspaceId: string;
    }) => Promise<
      Array<{
        id: string;
        workspaceId: string;
        kind: 'assistant' | 'swarm_dm';
        createdAt: number;
        messages: Array<{
          id: string;
          conversationId: string;
          role: 'user' | 'assistant' | 'tool' | 'system';
          content: string;
          toolCallId: string | null;
          createdAt: number;
        }>;
      }>
    >;
    cancel: (input: { conversationId: string; turnId: string }) => Promise<void>;
    /**
     * Spawn N panes via `workspaces.launch` + initial PTY prompts. Emits one
     * `assistant:dispatch-echo` event per spawned pane so the renderer can
     * surface a "Jump to pane" toast (W13-015).
     */
    dispatchPane: (input: {
      workspaceId: string;
      provider: string;
      count: number;
      initialPrompt: string;
      conversationId?: string;
    }) => Promise<{ sessionIds: string[] }>;
    tools: () => Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        // JSON-Schema-shaped object so frontends can render forms.
        inputSchema: Record<string, unknown>;
      }>
    >;
    invokeTool: (input: {
      conversationId?: string;
      name: string;
      args: Record<string, unknown>;
    }) => Promise<{ ok: boolean; result: unknown; error?: string }>;
    /**
     * P3-S7 — Cross-session persistence sub-namespace. The handlers register
     * side-band in `rpc-router.ts` (the typed RPC proxy supports a single
     * namespace level), so renderer call-sites reach these via
     * `window.sigma.invoke('assistant.conversations.<method>', …)`. The
     * shapes here exist for IDE + reviewer documentation.
     */
    conversations: {
      list: (input: { workspaceId: string }) => Promise<
        Array<{
          id: string;
          workspaceId: string;
          kind: 'assistant' | 'swarm_dm';
          createdAt: number;
          title: string;
          lastMessageAt: number;
          messageCount: number;
        }>
      >;
      get: (input: { conversationId: string }) => Promise<{
        conversation: {
          id: string;
          workspaceId: string;
          createdAt: number;
        } | null;
        messages: Array<{
          id: string;
          conversationId: string;
          role: 'user' | 'assistant' | 'tool' | 'system';
          content: string;
          toolCallId: string | null;
          createdAt: number;
        }>;
      }>;
      delete: (input: { conversationId: string }) => Promise<{ ok: true }>;
    };
  };
  design: {
    captureElement: (input: { tabId: string }) => Promise<{
      pickerToken: string;
      selector: string;
      outerHTML: string;
      computedStyles: Record<string, string>;
      screenshotPng: string;
    }>;
    dispatch: (input: {
      pickerToken: string;
      prompt: string;
      providers: string[];
      modifiers?: { shift?: boolean; alt?: boolean };
      attachments?: string[];
      canvasId?: string;
      workspaceId?: string;
    }) => Promise<{ dispatched: number; sessionIds: string[] }>;
    history: (input: { canvasId: string }) => Promise<
      Array<{
        id: string;
        canvasId: string;
        prompt: string;
        providers: string[];
        ts: number;
      }>
    >;
    /**
     * V3-W14-001 — toggle the per-tab element-picker overlay. The main process
     * injects a DevTools-style hover/click overlay into the WebContentsView and
     * starts streaming `design:capture` events when the user clicks an element.
     */
    startPick: (input: { workspaceId: string; tabId: string }) => Promise<{ pickerToken: string }>;
    stopPick: (input: { workspaceId: string; tabId: string }) => Promise<void>;
    /**
     * V3-W14-004 — copy an asset into the canvas staging directory. Returns
     * the absolute on-disk path so the renderer can drop it into the prompt
     * buffer.
     */
    attachFile: (input: {
      canvasId: string;
      filePath?: string;
      bytesBase64?: string;
      filename?: string;
    }) => Promise<{ stagingPath: string }>;
    listCanvases: (input: { workspaceId: string }) => Promise<
      Array<{
        id: string;
        workspaceId: string;
        title: string;
        lastProviders: string[];
        createdAt: number;
      }>
    >;
    createCanvas: (input: {
      workspaceId: string;
      title?: string;
      lastProviders?: string[];
    }) => Promise<{
      id: string;
      workspaceId: string;
      title: string;
      lastProviders: string[];
      createdAt: number;
    }>;
    openCanvas: (input: { canvasId: string; lastProviders?: string[] }) => Promise<void>;
    /** V3-W14-005 — register dev-server source roots for HMR poke. */
    setDevServerRoots: (input: { workspaceId: string; roots: string[] }) => Promise<void>;
    /** V3-W14-005 — manual reload fallback for the active tab. */
    reloadTab: (input: { workspaceId: string; tabId: string }) => Promise<void>;
  };
  swarm: {
    'console-tab': (input: {
      swarmId: string;
      tab: 'terminals' | 'chat' | 'activity' | 'replays';
    }) => Promise<void>;
    'stop-all': (input: { swarmId: string; reason: string }) => Promise<{ stopped: number }>;
    'constellation-layout': (input: {
      swarmId: string;
      nodePositions: Array<{ agentKey: string; x: number; y: number }>;
    }) => Promise<void>;
    'agent-filter': (input: {
      swarmId: string;
      filter: 'all' | 'coordinators' | 'builders' | 'scouts' | 'reviewers';
    }) => Promise<void>;
    'mission-rename': (input: { swarmId: string; mission: string }) => Promise<void>;
    'update-agent': (input: {
      swarmAgentId: string;
      providerId?: string;
      autoApprove?: boolean;
    }) => Promise<void>;
    /**
     * P3-S6 — Persistent Swarm Replay namespace. The mailbox is event-sourced;
     * these methods harvest the durable log into a scrubber UI so an operator
     * can replay any past session frame-by-frame.
     */
    replay: {
      list: (input: { workspaceId: string }) => Promise<
        Array<{
          swarmId: string;
          name: string;
          missionExcerpt: string;
          agentCount: number;
          messageCount: number;
          firstAt: number | null;
          lastAt: number | null;
          status: string;
        }>
      >;
      scrub: (input: { swarmId: string; frameIdx: number }) => Promise<{
        swarmId: string;
        swarmName: string;
        missionText: string;
        frameIdx: number;
        totalFrames: number;
        agents: Array<{
          id: string;
          agentKey: string;
          role: string;
          roleIndex: number;
          providerId: string;
          addedAt: number;
        }>;
        messages: Array<{
          id: string;
          fromAgent: string;
          toAgent: string;
          kind: string;
          body: string;
          ts: number;
          payload?: Record<string, unknown>;
        }>;
        counters: {
          escalations: number;
          review: number;
          quiet: number;
          errors: number;
        };
      }>;
      bookmark: (input: {
        swarmId: string;
        frameIdx: number;
        label: string;
      }) => Promise<{ snapshotId: string }>;
      listBookmarks: (input: { swarmId: string }) => Promise<
        Array<{ id: string; label: string; frameIdx: number; createdAt: number }>
      >;
      deleteBookmark: (input: { snapshotId: string }) => Promise<void>;
    };
    /**
     * P3-S7 — Origin back-link. When a swarm was created via the Bridge
     * Assistant `create_swarm` tool, the controller writes a row in
     * `swarm_origins` keyed on `swarmId`; this method reads the row so the
     * Operator Console can render "Started from Bridge Assistant chat: …"
     * and link back to the originating turn. Returns `null` for swarms
     * that were created in the Swarm Room directly.
     */
    origin: {
      get: (input: { swarmId: string }) => Promise<{
        swarmId: string;
        conversationId: string;
        messageId: string;
        createdAt: number;
      } | null>;
    };
  };
  // Phase 4 Track C — Ruflo MCP embed. Six channels under the `ruflo.*`
  // namespace forward into the embedded `@claude-flow/cli` MCP server. Each
  // tool-call channel returns either a typed success envelope or
  // `{ ok: false, code: 'ruflo-unavailable', reason: string }` so renderer
  // call-sites can degrade silently when the supervisor is `absent` / `down`
  // / `degraded`.
  ruflo: {
    health: () => Promise<{
      state: 'absent' | 'starting' | 'ready' | 'degraded' | 'down';
      lastError?: string;
      pid?: number;
      uptimeMs?: number;
      version?: string;
      runtimePath?: string;
    }>;
    'embeddings.search': (input: {
      query: string;
      topK?: number;
      threshold?: number;
      namespace?: string;
    }) => Promise<
      | {
          ok: true;
          results: Array<{
            id: string;
            score: number;
            text: string;
            namespace?: string;
          }>;
        }
      | { ok: false; code: 'ruflo-unavailable'; reason: string }
    >;
    'embeddings.generate': (input: {
      text: string;
      hyperbolic?: boolean;
      normalize?: boolean;
    }) => Promise<
      | { ok: true; embedding: number[]; dimensions: number }
      | { ok: false; code: 'ruflo-unavailable'; reason: string }
    >;
    'patterns.search': (input: {
      query: string;
      topK?: number;
      minConfidence?: number;
    }) => Promise<
      | {
          ok: true;
          results: Array<{
            pattern: string;
            type?: string;
            confidence: number;
            score: number;
          }>;
        }
      | { ok: false; code: 'ruflo-unavailable'; reason: string }
    >;
    /** CRITICAL: payload is `{ pattern, type, confidence }` — NOT
     *  `{ namespace, key, value }`. The upstream `agentdb_pattern-store`
     *  tool rejects the latter shape. */
    'patterns.store': (input: {
      pattern: string;
      type?: string;
      confidence?: number;
    }) => Promise<
      | { ok: true; id?: string }
      | { ok: false; code: 'ruflo-unavailable'; reason: string }
    >;
    'autopilot.predict': () => Promise<
      | {
          ok: true;
          suggestion: {
            title: string;
            detail?: string;
            commandId?: string;
            args?: unknown;
          } | null;
        }
      | { ok: false; code: 'ruflo-unavailable'; reason: string }
    >;
    'install.start': () => Promise<{ jobId: string }>;
  };
  voice: {
    start: (input: {
      source: 'mission' | 'assistant' | 'palette';
    }) => Promise<{ sessionId: string }>;
    stop: (input: { sessionId: string }) => Promise<void>;
    /**
     * V1.1 — Run the intent classifier against an arbitrary transcript and
     * route the resolved intent through the same controllers the
     * SigmaVoice native pipeline uses. Useful for accessibility flows that
     * bypass the microphone + unit tests.
     */
    dispatch: (input: { transcript: string }) => Promise<{
      intent: string;
      controller: string;
      ok: boolean;
      reason: string;
    }>;
    /**
     * V1.1 — Switch the routing strategy at runtime. `auto` picks native-mac
     * on darwin (when the prebuild is loaded) and Web Speech everywhere
     * else. `off` short-circuits both — `start` rejects with `voice-disabled`.
     */
    setMode: (input: {
      mode: 'auto' | 'web-speech' | 'native-mac' | 'off';
    }) => Promise<{
      mode: 'auto' | 'web-speech' | 'native-mac' | 'off';
    }>;
    /**
     * V1.1.1 — Re-prompt the OS microphone authorisation dialog. Resolves
     * with `'unsupported'` on non-darwin or when the native module is
     * missing so the renderer can render a steady-state Settings row
     * without special-casing the platform branch.
     */
    permissionRequest: () => Promise<{
      status: 'granted' | 'denied' | 'undetermined' | 'unsupported';
    }>;
  };
}
