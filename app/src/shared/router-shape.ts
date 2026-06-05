// The cross-process Router type. Imported by both main (to enforce controller shape)
// and renderer (to type the RPC client). NO runtime imports of Node code here.

import type {
  Workspace,
  ProviderProbe,
  AgentSession,
  GitStatus,
  GitDiff,
  LaunchPlan,
  AddAgentToSwarmInput,
  AddAgentToSwarmResult,
  CreateSwarmInput,
  Swarm,
  SwarmMessage,
  SwarmMessageKind,
  BrowserState,
  BrowserTab,
  Skill,
  SkillProviderId,
  SkillProviderState,
  Memory,
  MemorySearchHit,
  MemoryGraph,
  MemoryHubStatus,
  MemoryConnectionSuggestion,
  MemoryUnlinkedMention,
  Notification,
  NotificationSeverity,
  ReviewState,
  ReviewDiff,
  ReviewConflict,
  BatchCommitResult,
  SessionCheckpoint,
  Task,
  TaskAssignment,
  TaskComment,
  TaskStatus,
  SyncConfig,
  SyncStatus,
  SyncConflict,
  GitActivityBucket,
  GitLogEntry,
  GitBranchList,
  UsageSummary,
  UsageWeekSummary,
  McpDiagnostic,
} from './types';
import type { PlanCapsule } from './plan-capsule';

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

export interface PaneResumeResult {
  workspaceId: string;
  resumed: Array<{
    sessionId: string;
    providerId: string;
    providerEffective: string;
    externalSessionId: string;
    pid: number;
  }>;
  failed: Array<{
    sessionId: string;
    providerId: string;
    externalSessionId: string;
    error: string;
  }>;
  skipped: Array<{
    sessionId: string;
    providerId: string;
    reason: string;
  }>;
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
    /** v1.2.4 — quit the app and install the downloaded update (Windows NSIS) or open the DMG (macOS). */
    quitAndInstall: () => Promise<void>;
    /**
     * V3-W15-005 — Resolve the active plan tier. Reads `kv['plan.tier']` and
     * falls back to `'ultra'` (SigmaLink default — local-only / free).
     */
    tier: () => Promise<AppTier>;
    /**
     * v1.4.2-06 — Reveal a path in the OS file manager (Finder/Explorer).
     */
    revealInFolder: (path: string) => Promise<{ ok: boolean }>;
    /**
     * v1.4.2-06 — Open a system terminal at the given directory.
     */
    openShell: (cwd: string) => Promise<{ ok: boolean }>;
    /**
     * v1.4.2-06 — Return the Electron userData path so the renderer can
     * explain where worktrees live.
     */
    getUserDataPath: () => Promise<string>;
    /**
     * v1.4.2-06 — Read/write the kv key tracking whether the worktree
     * info banner has been dismissed.
     */
    dismissedWorktreeBanner: () => Promise<boolean>;
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
    snapshot: (sessionId: string) => Promise<{ buffer: string }>; // returns current ring buffer
    subscribe: (sessionId: string) => Promise<{ history: string }>; // legacy alias for ring buffer
    list: () => Promise<Array<{ sessionId: string; providerId: string; cwd: string; alive: boolean; pid: number }>>;
    forget: (sessionId: string) => Promise<void>;
    /**
     * W-4 Phase 4 — Spawn an ephemeral scratch-shell PTY in the given cwd.
     * NO agent_session DB row, NO persistence, NO sidebar entry, NO resume.
     * killAll() in shutdownRouter covers cleanup automatically.
     */
    spawnScratch: (input: { cwd: string }) => Promise<{ scratchId: string }>;
    /**
     * W-4 Phase 4 — Kill and forget a scratch-shell PTY by id.
     */
    killScratch: (input: { scratchId: string }) => Promise<void>;
  };
  panes: {
    resume: (workspaceId: string) => Promise<PaneResumeResult>;
    /**
     * v1.2.8 — "Respawn fresh" recovery. Re-spawns every pane in the
     * workspace that the resume flow marked as `status='exited' AND
     * exit_code=-1`. Same worktree, same provider, no resume args. Returns
     * the spawned + still-failed counts so the renderer can surface a
     * follow-up toast after the user clicks the recovery button.
     */
    respawnFailed: (
      workspaceId: string,
    ) => Promise<{ workspaceId: string; spawned: number; failed: number }>;
    /**
     * P6 FEAT-1 — on-demand subset relaunch. Resumes ONLY the eligible panes
     * whose session id appears in `sessionIds` (every other pane is left
     * untouched), returning the same `PaneResumeResult` as `resume`. Additive:
     * the boot auto-resume path still calls `resume(workspaceId)` for the full
     * set; this is the renderer-triggered "Resume agents…" picker.
     */
    resumeSelected: (
      workspaceId: string,
      sessionIds: string[],
    ) => Promise<PaneResumeResult>;
    /**
     * v1.3.0 — Session picker: list all provider sessions associated with
     * `cwd`, sorted by `updatedAt` DESC and capped at `maxCount` (default 50).
     * Never throws — returns empty array on unknown provider or no matches.
     */
    listSessions: (input: {
      providerId: string;
      cwd: string;
      opts?: {
        maxCount?: number;
        sinceMs?: number;
      };
    }) => Promise<
      Array<{
        id: string;
        providerId: string;
        cwd: string;
        createdAt: number;
        updatedAt: number;
        title?: string;
        firstMessagePreview?: string;
      }>
    >;
    /**
     * v1.3.0 — Session picker: return the most recent `agent_sessions` row
     * per pane slot for the given workspace, ordered by `started_at DESC`.
     * `sessionId` is the row's `externalSessionId` (null if never captured).
     * Returns empty array when no history exists.
     */
    lastResumePlan: (workspaceId: string) => Promise<
      Array<{
        paneIndex: number;
        providerId: string;
        sessionId: string | null;
      }>
    >;
    /**
     * v1.4.3 (#02) — Pane rehydration. Returns ONE full AgentSession row per
     * pane slot (MAX started_at wins), ordered by pane_index ASC. The renderer
     * dispatches ADD_SESSIONS from three sites so state.sessionsByWorkspace
     * is populated on workspace reopen without requiring a fresh launch.
     * Returns empty array for fresh workspaces with no history.
     */
    listForWorkspace: (workspaceId: string) => Promise<AgentSession[]>;
    /**
     * C-5 — Inject a structured plan capsule into the pane's PTY (via pty.write)
     * and, when a worktreePath is provided, write an idempotent scope-guidance
     * block into <worktreePath>/CLAUDE.md.
     */
    brief: (a: { sessionId: string; worktreePath: string | null; capsule: PlanCapsule }) => Promise<void>;
    /**
     * SF-10 — set a display-only CLI label on a pane (cosmetic; does not change
     * spawn/resume/MCP). Pass `displayProviderId: null` to clear the override.
     */
    setDisplayProvider: (a: { sessionId: string; displayProviderId: string | null }) => Promise<{ ok: boolean }>;
  };
  providers: {
    list: () => Promise<
      Array<{ id: string; name: string; description: string; color: string; icon: string; installHint: string }>
    >;
    probeAll: () => Promise<ProviderProbe[]>;
    probe: (id: string) => Promise<ProviderProbe>;
    /**
     * v1.4.9-06 — Spawn the provider's install command in an ephemeral PTY
     * pane. Returns the pane's session id so the renderer can subscribe to
     * `pty:data` events and display live output. The pane stays open on
     * exit-0 (consistent with existing pane lifecycle).
     */
    spawnInstall: (providerId: string) => Promise<{ paneId: string }>;
    /**
     * v1.4.9-06 — Persist the user's install-consent decision for a provider.
     * `'declined'` means "never prompt again until reset". Absence of a stored
     * value means the modal will appear next time.
     */
    setInstallConsent: (providerId: string, decision: 'declined') => Promise<void>;
    /**
     * v1.4.9-06 — Read the stored install-consent decision for a provider.
     * Returns `'declined'` or `null` (not yet decided / reset).
     */
    getInstallConsent: (providerId: string) => Promise<'declined' | null>;
  };
  workspaces: {
    pickFolder: () => Promise<{ path: string } | null>;
    open: (root: string) => Promise<Workspace>;
    list: () => Promise<Workspace[]>;
    /** DEV-W2 — rename a workspace's display label (trims, rejects empty/over-120). */
    rename: (input: { id: string; name: string }) => Promise<Workspace>;
    remove: (id: string) => Promise<void>;
    launch: (plan: LaunchPlan) => Promise<{ sessions: AgentSession[] }>;
    /** DEV-W3a — force-open a DISTINCT workspace on a dir (never reuses an existing one). */
    openNew: (root: string) => Promise<Workspace>;
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
    /** BSP-G1 — create a new worktree from a repo root with an optional branch hint and base ref. */
    worktreeCreate: (input: { repoRoot: string; hint?: string; base?: string }) => Promise<{ worktreePath: string; branch: string }>;
    /** BSP-G3 — CWD-swap an IDLE pane to an existing worktree (disabled when session is running). */
    openInPane: (input: { sessionId: string; worktreePath: string }) => Promise<{ ok: boolean }>;
    // P6 FEAT-11 — agent undo/rewind via per-pane worktree git checkpoints.
    // The controller resolves sessionId→worktreePath server-side; the renderer
    // never passes a filesystem path.
    createCheckpoint: (input: {
      sessionId: string;
      label?: string;
    }) => Promise<SessionCheckpoint>;
    listCheckpoints: (sessionId: string) => Promise<SessionCheckpoint[]>;
    restoreCheckpoint: (input: {
      sessionId: string;
      sha: string;
    }) => Promise<{ ok: true; safetySha: string | null }>;
    // P6 FEAT-8 — per-worktree git-activity heatmap. Positional cwd mirrors
    // git.status (the renderer poller passes the worktree path); contained
    // server-side via assertAllowedPath.
    activityLog: (cwd: string, days?: number) => Promise<GitActivityBucket[]>;
    // BSP-G2 — staged-only diff (git diff --cached) for the Git panel.
    diffStaged: (cwd: string) => Promise<GitDiff | null>;
    // BSP-G2 — unstaged diff (git diff, no --cached) for the Git panel.
    diffUnstaged: (cwd: string) => Promise<GitDiff | null>;
    // BSP-G2 — commit log for the Git History panel.
    log: (cwd: string, limit?: number) => Promise<GitLogEntry[]>;
    // BSP-G2 — branch list for the Git Branches panel.
    listBranches: (cwd: string) => Promise<GitBranchList>;
    // BSP-G2 — switch to a branch (only allowed when working tree is clean).
    switchBranch: (input: { cwd: string; branch: string }) => Promise<{ ok: boolean; error?: string }>;
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
    /**
     * v1.4.2-06 — List all worktree directories under userData/worktrees
     * with their disk sizes for the Settings → Storage panel.
     */
    getWorktreeSizes: () => Promise<{
      worktrees: Array<{
        path: string;
        sizeBytes: number;
        repoHash: string;
        branchSeg: string;
      }>;
      totalBytes: number;
    }>;
  };
  swarms: {
    create: (input: CreateSwarmInput) => Promise<Swarm>;
    addAgent: (input: AddAgentToSwarmInput) => Promise<AddAgentToSwarmResult>;
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
    // v1.4.3 #06 — Pane Split + Minimise. `splitPane` shares the parent's
    // worktree (intentional design — see controller.ts comments) and rejects
    // panes that are already in a split group (max 2-level deep in v1.4.x).
    splitPane: (input: {
      paneId: string;
      direction: 'horizontal' | 'vertical';
      provider: string;
    }) => Promise<AgentSession>;
    minimisePane: (input: { paneId: string; minimised: boolean }) => Promise<void>;
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
    /** DEV-2 — recently-closed tab entries (soft-deleted) for the Recents panel. */
    listRecents: (input: { workspaceId: string; limit?: number }) => Promise<Array<{ url: string; title: string; lastVisitedAt: number }>>;

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
    verifyForWorkspace: (workspaceId: string) => Promise<{
      workspaceId: string;
      verified: number;
      refanned: number;
      errors: Array<{
        skillId: string;
        skillName: string;
        providerId: SkillProviderId;
        targetPath: string;
        message: string;
      }>;
    }>;
    /** SMK-3 — Discover skills from ALL providers (claude plugins manifest,
     *  claude user skills, codex, gemini, claude commands). Returns an empty
     *  array if nothing is installed. */
    listInstalled: () => Promise<Array<{
      name: string;
      description: string;
      source: 'superpowers' | 'ruflo' | 'claude-plugin' | 'claude' | 'claude-cmd' | 'codex' | 'gemini' | 'custom';
      provider: 'claude' | 'codex' | 'gemini' | 'unknown';
      prefix: '/' | '$';
    }>>;
    /**
     * v1.7.1 W-5 Skills Phase 2 — Attach a skill to a workspace or pane
     * (INFORMATIONAL binding only). Idempotent: if an identical binding exists
     * it is returned unchanged. paneSessionId null = workspace-wide.
     *
     * NOTE: This is INFORMATIONAL only. It does NOT affect agent dispatch,
     * does NOT inject into agent context, and does NOT alter tool-calling.
     * Behavioral activation is a deferred future enhancement.
     */
    attach: (input: {
      workspaceId: string;
      paneSessionId?: string | null;
      skillName: string;
      skillSource: string;
    }) => Promise<{
      id: string;
      workspaceId: string;
      paneSessionId: string | null;
      skillName: string;
      skillSource: string;
      attachedAt: number;
    }>;
    /**
     * v1.7.1 W-5 Skills Phase 2 — Remove a skill binding by id. No-op if
     * the binding does not exist.
     */
    detach: (input: { bindingId: string }) => Promise<void>;
    /**
     * v1.7.1 W-5 Skills Phase 2 — List all bindings for a workspace (both
     * workspace-wide and all pane-scoped bindings within that workspace).
     * Used on workspace load to restore persisted chips.
     */
    listBindings: (input: { workspaceId: string }) => Promise<Array<{
      id: string;
      workspaceId: string;
      paneSessionId: string | null;
      skillName: string;
      skillSource: string;
      attachedAt: number;
    }>>;
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
    /** P4.2 MEM-7 — notes that mention this note's name/alias as plain text (no explicit link yet). */
    find_unlinked_mentions: (input: {
      workspaceId: string;
      name: string;
    }) => Promise<MemoryUnlinkedMention[]>;
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
    /** P4 MEM-3 — distinct tags + note counts for the Tags pane / filter. */
    list_tags: (input: { workspaceId: string }) => Promise<Array<{ tag: string; count: number }>>;
    /** P4 MEM-3 — notes carrying a tag (most-recently-updated first). */
    list_by_tag: (input: { workspaceId: string; tag: string }) => Promise<Memory[]>;
    /** P4 DB-2 — main shows a save dialog, then writes a compacted DB snapshot. */
    export_db: () => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
    /** P4 DB-2 — DESTRUCTIVE: main shows an open dialog, validates + replaces the
     *  live DB, then reopens. The renderer reloads on `{ok:true}`. */
    import_db: () => Promise<{ ok: boolean; canceled?: boolean }>;
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
  //   • assistant.* — V3-W13-013 wires the Sigma Assistant chat panel.
  //   • design.*    — V3-W14-001+ wires the Design Mode / Sigma Canvas.
  //   • voice.*     — V3-W15-001 wires SigmaVoice intake.
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
        claudeSessionId: string | null;
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
     * V3-W13-013 — Spawn multiple pane batches in one call. Each item
     * specifies a `workspaceId`, `provider`, `count`, and optional
     * `initialPrompt`. Returns one result entry per pane attempted; failures
     * are reported inline so callers can act on partial success without a
     * try/catch.
     */
    dispatchBulk: (
      items: Array<{
        workspaceId: string;
        provider: string;
        count: number;
        initialPrompt?: string;
        conversationId?: string;
      }>,
    ) => Promise<
      Array<{
        paneId: string | null;
        providerId: string;
        workspaceId: string;
        success: boolean;
        error?: string;
      }>
    >;
    /**
     * V3-W13-013 — Resolve an `@filename` ref from a Sigma conversation.
     * Walks the workspace root for files whose basename contains `atRef`
     * (case-insensitive). Returns up to 10 matches with a short snippet.
     * Empty array when nothing matches or the workspace is unknown.
     */
    refResolve: (input: {
      workspaceId: string;
      atRef: string;
    }) => Promise<Array<{ absPath: string; snippet: string }>>;
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
          claudeSessionId: string | null;
        }>
      >;
      get: (input: { conversationId: string }) => Promise<{
        conversation: {
          id: string;
          workspaceId: string;
          createdAt: number;
          claudeSessionId: string | null;
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
      resumeHint: (input: {
        conversationId: string;
      }) => Promise<{ available: boolean; sessionId: string | null }>;
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
     * P3-S7 — Origin back-link. When a swarm was created via the Sigma
     * Assistant `create_swarm` tool, the controller writes a row in
     * `swarm_origins` keyed on `swarmId`; this method reads the row so the
     * Operator Console can render "Started from Sigma Assistant chat: …"
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
    /** P4 MEM-1 — list Ruflo AgentDB entries (sweep, optionally narrowed by a
     *  context query) as read-only graph nodes. */
    'entries.list': (input: { query?: string; limit?: number }) => Promise<
      | {
          ok: true;
          entries: Array<{
            id: string;
            text: string;
            namespace: string;
            score?: number;
            createdAt?: number;
          }>;
        }
      | { ok: false; code: 'ruflo-unavailable'; reason: string }
    >;
    /** P4 MEM-1 — semantic neighbors of one entry → similarity edges. */
    'entries.neighbors': (input: { id: string; text: string; topK?: number }) => Promise<
      | {
          ok: true;
          edges: Array<{
            fromId: string;
            toId: string;
            kind: 'similarity' | 'causal';
            weight: number;
          }>;
        }
      | { ok: false; code: 'ruflo-unavailable'; reason: string }
    >;
    'install.start': () => Promise<{ jobId: string }>;
    verifyForWorkspace: (workspaceRoot: string) => Promise<{
      claude: boolean;
      codex: boolean;
      gemini: boolean;
      /** v1.3.5 — vacuously true when kimi CLI is not detected. */
      kimi: boolean;
      /** v1.3.5 — vacuously true when opencode CLI is not detected. */
      opencode: boolean;
      /** v1.3.5 — PATH-probe results for optional CLIs. */
      detected: { kimi: boolean; opencode: boolean };
      mode: 'fast' | 'strict';
      errors: Array<{ cli: 'claude' | 'codex' | 'gemini' | 'kimi' | 'opencode'; message: string }>;
    }>;
    /** v1.6.1 B2 — Returns status rows for all tracked per-workspace HTTP daemons.
     *  Pass a workspaceId to filter to one; omit to list all. */
    daemonStatus: (workspaceId?: string) => Promise<Array<{
      workspaceId: string;
      status: string;
      port: number;
      pid: number;
      uptime: number;
      connections: number | null;
    }>>;
    /** v1.6.1 B2 — Stop + re-spawn the HTTP daemon for a single workspace. */
    restartDaemon: (workspaceId: string) => Promise<{ ok: boolean; error?: string }>;
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
  /**
   * v1.4.9 #07 — Notifications + top-right bell. Owned by
   * `core/notifications/manager.ts`; the renderer reaches it via the
   * `notifications.*` IPC channels. Live updates arrive on the
   * `notifications:changed` event (delta envelope `{added, removed,
   * unreadCount}`, never the full list).
   */
  notifications: {
    list: (input?: {
      limit?: number;
      offset?: number;
      workspaceId?: string | null;
      severities?: NotificationSeverity[];
    }) => Promise<Notification[]>;
    unreadCount: () => Promise<number>;
    markRead: (id: string) => Promise<void>;
    markAllRead: () => Promise<void>;
    markUnread: (id: string) => Promise<void>;
    dismiss: (id: string) => Promise<void>;
    clearRead: () => Promise<{ removed: string[] }>;
  };
  /**
   * v1.5.0 packet 09 — Cross-machine sync (opt-in, e2ee, git-backed).
   *
   * SECURITY NOTE: The sync master key NEVER appears in any response or
   * IPC payload. Only SyncStatus + SyncConflict are safe to cross IPC.
   * The `exportMnemonic` method is gated behind a re-confirmation prompt
   * in the UI and returns a one-shot value that the caller must display
   * and then discard.
   */
  sync: {
    /** Enable sync with the given config. First-time call triggers setup wizard flow. */
    enable: (config: SyncConfig) => Promise<SyncStatus>;
    /** Disable sync on this device. Local data is preserved. */
    disable: () => Promise<void>;
    /** Read current sync status. */
    status: () => Promise<SyncStatus>;
    /** List unresolved LWW conflicts. */
    listConflicts: () => Promise<SyncConflict[]>;
    /** Apply a user's explicit conflict resolution choice. */
    resolveConflict: (input: {
      conflictId: string;
      resolution: 'keep_local' | 'keep_remote';
    }) => Promise<void>;
    /**
     * Export the mnemonic for the current device's key — one-shot, must
     * only be called after a re-confirmation dialog (the renderer enforces
     * this in the setup wizard + settings UX).
     */
    exportMnemonic: () => Promise<string | null>;
    /** Check whether sync is configured on this device. */
    isConfigured: () => Promise<boolean>;
    /** Recovery: import an existing mnemonic on a new device. */
    recoverFromMnemonic: (mnemonic: string) => Promise<void>;
  };
  /**
   * R-1 — Jorvis Telegram remote (`telegram.*`). SECURITY-CRITICAL.
   *
   * Lets the operator drive Jorvis from Telegram. The bot token is WRITE-ONLY:
   * `setToken` persists it into the encrypted CredentialStore and it NEVER
   * crosses IPC again — `getStatus` reports only a `tokenSet` boolean. The
   * bridge stays INERT until enabled + token + at-rest encryption + a
   * non-empty numeric chat-id allowlist all hold. Dangerous tool calls require
   * an inline confirm tap; `/lock` drops all inbound until `/unlock`.
   */
  telegram: {
    /** Operator-safe status snapshot. NEVER includes the token value. */
    getStatus: () => Promise<TelegramRemoteStatus>;
    /** Persist the bot token (encrypted). Refuses without OS encryption. Never echoes it back. */
    setToken: (token: string) => Promise<void>;
    /** Remove the stored token and stop the bridge. */
    clearToken: () => Promise<void>;
    /** Enable / disable the remote. */
    setEnabled: (enabled: boolean) => Promise<void>;
    /** Replace the numeric chat-id allowlist. */
    setAllowlist: (ids: number[]) => Promise<void>;
    /** Set the idle auto-lock window in minutes (<=0 disables). */
    setIdleLockMinutes: (minutes: number) => Promise<void>;
    /** Manually lock — drops all inbound until unlocked. */
    lock: () => Promise<void>;
    /** Manually unlock. */
    unlock: () => Promise<void>;
    /** Tail the audit log, newest first. */
    auditTail: (n: number) => Promise<TelegramAuditEntry[]>;
  };
  // P6 FEAT-3 — per-pane usage / cost rollups.
  usage: {
    /** Summed token/cost for one pane/session. */
    sessionSummary: (input: { sessionId: string }) => Promise<UsageSummary>;
    /** Week-to-date spend for a workspace, split by provider. */
    weekSummary: (input: { workspaceId: string }) => Promise<UsageWeekSummary>;
  };
  // P6 FEAT-5 — MCP config diagnostics / server manager.
  mcp: {
    /** Read+parse each provider's MCP config for a workspace and flag issues. */
    diagnoseWorkspace: (input: { workspaceId: string }) => Promise<McpDiagnostic>;
  };
}

/** R-1 — operator-safe Telegram remote status (no token value). */
export interface TelegramRemoteStatus {
  enabled: boolean;
  running: boolean;
  locked: boolean;
  allowlist: number[];
  encryptionAvailable: boolean;
  tokenSet: boolean;
}

/** R-1 — a single remote audit row surfaced to Settings → Telegram. */
export interface TelegramAuditEntry {
  ts: number;
  kind: string;
  chatId: number | null;
  detail: string;
}
