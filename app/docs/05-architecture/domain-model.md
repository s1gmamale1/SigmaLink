# SigmaLink Domain Model

**Version**: v1.12.x  
**Status**: Living document — update when context boundaries shift.

---

## Bounded Context Map

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CORE DOMAIN                                                             │
│                                                                          │
│  ┌─────────────────────┐      Partnership      ┌──────────────────────┐ │
│  │  Workspace & Pane   │◄─────────────────────►│  PTY / CLI           │ │
│  │  (Workspace,        │                        │  Orchestration       │ │
│  │   AgentSession,     │  owns pane slots;      │  (PtyRegistry,       │ │
│  │   SplitGroup,       │  PTY reads session id  │   SessionRecord,     │ │
│  │   LaunchPlan)       │  back via DB           │   ResumeLauncher,    │ │
│  └─────────────────────┘                        │   Sentinel)          │ │
│           │                                     └──────────────────────┘ │
│           │ Customer (Workspace drives swarm scope)                      │
│           ▼                                                              │
│  ┌─────────────────────┐                        ┌──────────────────────┐ │
│  │  SigmaSwarm         │   Published Language   │  Jorvis Assistant    │ │
│  │  (Swarm,            │◄── SwarmMessage ───────│  (Conversation,      │ │
│  │   SwarmAgent,       │    domain events        │   Message,           │ │
│  │   Mailbox,          │                        │   ToolDefinition,    │ │
│  │   Board,            │── SwarmOrigin ─────────►   JorvisPaneEvent)   │ │
│  │   SwarmReplaySnap)  │   links swarm to       │                      │ │
│  └─────────────────────┘   originating turn     └──────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  SUPPORTING DOMAIN                                                       │
│                                                                          │
│  ┌──────────────┐  ACL   ┌──────────────┐  ACL   ┌───────────────────┐ │
│  │  Skills      │◄──────►│  SigmaMemory │        │  Cross-machine    │ │
│  │  (Skill,     │        │  (Memory,    │        │  Sync             │ │
│  │   SkillBind, │        │   MemoryLink,│        │  (SyncState, HLC, │ │
│  │   Fanout,    │        │   MemoryTag, │        │   SyncConflict,   │ │
│  │   Frontmtr)  │        │   MemoryHub) │        │   DirtyTracker,   │ │
│  └──────────────┘        └──────────────┘        │   Tombstone)      │ │
│                                                   └───────────────────┘ │
│  ┌──────────────┐         ┌──────────────┐        ┌───────────────────┐ │
│  │  Voice /     │         │  Notifications│        │  Plan &           │ │
│  │  SigmaVoice  │         │  (Notif,     │        │  Capabilities     │ │
│  │  (VoiceCapture│         │   dedupKey,  │        │  (Tier, Capability│ │
│  │   Transcript, │         │   sources)   │        │   matrix)         │ │
│  │   OutputRouter│         └──────────────┘        └───────────────────┘ │
│  │   Dispatcher) │                                                       │
│  └──────────────┘                                                       │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  GENERIC / INFRASTRUCTURE DOMAIN                                         │
│                                                                          │
│  ┌─────────────────┐   Open Host Service   ┌──────────────────────────┐ │
│  │  Ruflo MCP      │◄──────────────────────│  IDE / Editor            │ │
│  │  Integration    │   per-workspace HTTP  │  (EditorFile,            │ │
│  │  (DaemonHandle, │   daemon              │   FileTree, worktree     │ │
│  │   RufloProxy,   │                        │   browsing)              │ │
│  │   HttpDaemonSup)│                        └──────────────────────────┘ │
│  └─────────────────┘                                                     │
│                                                                          │
│  ┌─────────────────┐         ┌──────────────────────────────────────┐   │
│  │  Provider /     │         │  Tasks / Kanban                      │   │
│  │  SigmaCode      │         │  (Task, TaskComment, SessionReview)  │   │
│  │  (ProviderId,   │         └──────────────────────────────────────┘   │
│  │   AgentProvider │                                                     │
│  │   Definition,   │                                                     │
│  │   ProviderProbe)│                                                     │
│  └─────────────────┘                                                     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Context: Workspace & Pane Management

**Type**: Core  
**Location**: `src/main/core/workspaces/`, `src/shared/types.ts`

**Responsibility**: Owns the lifecycle of user-created workspaces and the pane grid inside each workspace. A workspace maps a filesystem root to a named environment. Each pane is an `AgentSession` row in the DB, carrying its provider, working directory, git branch, worktree path, and split-group membership.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `Workspace` | Root aggregate. Carries `rootPath`, `repoRoot`, `repoMode`. |
| `AgentSession` | Entity. One DB row per pane slot. Identity = `SessionId` (UUID). Carries `paneIndex`, `splitGroupId`, `splitDirection`, `splitIndex`, `minimised`. |
| `LaunchPlan` | Value object. Encodes `GridPreset`, `PaneAssignment[]`, optional `paneResumePlan`. |
| `SplitGroup` | Value object inlined into `AgentSession` (three columns). Max depth 2. |
| `WorktreePool` | Service. Manages per-pane git worktrees; owned by `git/worktree.ts`. |

**Ubiquitous language**: workspace, pane, pane slot, grid preset, split group, worktree, launch plan, repo mode.

**Interfaces to other contexts**:
- Supplies `workspaceId` and `AgentSession` shape to every other context (global key).
- Drives PTY Orchestration via `executeLaunchPlan` → `resolveAndSpawn`.
- Exposes `WorktreePool` as a dependency injected into Jorvis Assistant and Swarm factory.
- Emits `app:open-workspaces-changed` IPC events consumed by the renderer.
- ACL: MCP autowrite (`workspaces/mcp-autowrite.ts`) writes `.claude/settings.json` when a workspace opens; this is the only direct filesystem mutation that crosses the workspace/MCP boundary.

---

## Context: PTY / CLI Orchestration

**Type**: Core  
**Location**: `src/main/core/pty/`, `src/main/core/providers/`

**Responsibility**: Spawns, resumes, and tears down OS pseudo-terminal processes for the five supported CLI coding agents (claude, codex, gemini, kimi, opencode) plus the internal `shell` sentinel. Manages the scrollback ring buffer and sentinel-based CLI-exit detection for shell-first mode.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `PtyRegistry` | Aggregate root. In-memory map of live `SessionRecord`s. |
| `SessionRecord` | Entity. `id`, `providerId`, `cwd`, `pid`, `alive`, `exitCode`, `externalSessionId`, `spawnMode`, `buffer` (RingBuffer). |
| `AgentProviderDefinition` | Value object (shared). Encodes `command`, `altCommands`, `resumeArgs`, `autoApproveFlag`, etc. for each CLI provider. |
| `RingBuffer` | Value object. Fixed-size circular scrollback buffer. |
| `ResumeLauncher` | Service. Builds `buildResumeArgs` for claude/gemini/codex session-id resume. |
| `Sentinel` | Value object. Magic byte sequence injected in shell-first mode to detect CLI exit without tearing down the PTY. |

**Ubiquitous language**: session, pane session, provider, spawn, resume, sentinel, shell-first mode, direct mode, scrollback, PTY, external session id, ring buffer, graceful exit delay.

**Providers (5 + 1 internal)**:
- `claude`, `codex`, `gemini`, `kimi`, `opencode` — user-facing
- `shell` — internal; filtered from all pickers

**Interfaces to other contexts**:
- Workspace & Pane: reads `paneIndex` from `AgentSession` DB; writes `externalSessionId` back.
- Notifications: fires `pty:exit` and `tool-error` events consumed by notification sources.
- Jorvis Assistant: `PaneEventSink` feeds `jorvis_pane_events` table; `JorvisPaneEvent` crosses this boundary.
- Swarm: swarm factory spawns PTYs for each `SwarmAgent` via the same `PtyRegistry`.

---

## Context: SigmaSwarm

**Type**: Core  
**Location**: `src/main/core/swarms/`

**Responsibility**: Manages multi-agent swarms: lifecycle (create/pause/complete/fail), the roster of agents per swarm, mailbox-based inter-agent messaging, operator-console replay snapshots, and per-agent board posts.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `Swarm` | Aggregate root. `SwarmId`, `mission`, `preset` (squad/team/platoon/battalion/custom), `status`, `agents[]`. |
| `SwarmAgent` | Entity within Swarm. `role` (coordinator/builder/scout/reviewer), `roleIndex`, `agentKey`, `sessionId`, `inboxPath`, `autoApprove`. |
| `SwarmMessage` | Entity. `SwarmMessageKind` (SAY/ACK/STATUS/DONE/OPERATOR/ROLLCALL/etc.), `fromAgent`, `toAgent`, `resolvedAt`. |
| `Mailbox` | Service. Manages per-agent inbox files; reads and delivers messages. |
| `SwarmReplaySnapshot` | Value object. Bookmark into the swarm message timeline for the Operator Console scrubber. |
| `SwarmOrigin` | Value object. Back-link from `swarmId` to the `(conversationId, messageId)` that triggered the swarm via Jorvis. |
| `Board` | Entity. Per-agent markdown post under `<userData>/swarms/<swarmId>/boards/<agentId>/`. |
| `SwarmSkill` | Value object. (swarmId, skillKey, on/off) toggle persisted to DB. |

**Ubiquitous language**: swarm, mission, preset, roster, agent key, coordinator, builder, scout, reviewer, mailbox, broadcast, roll call, constellation, replay snapshot, board post, auto-approve.

**Interfaces to other contexts**:
- Workspace & Pane: `workspaceId` scopes every swarm; Swarm factory delegates PTY spawn to PTY Orchestration.
- Jorvis Assistant: `SwarmOrigin` links swarms back to the Jorvis conversation that created them; Jorvis tools (`create_swarm`, `swarm_broadcast`) cross this boundary.
- Skills: `SwarmSkill` toggles reference skills by `skillKey` (string reference, not a FK).
- Notifications: `swarm-message` notification source subscribes to swarm message events.

---

## Context: Jorvis Assistant

**Type**: Core  
**Location**: `src/main/core/assistant/`, `src/renderer/features/jorvis-assistant/`

**Responsibility**: The in-app AI assistant (previously named Sigma Assistant; folder `jorvis-assistant/`). Drives Claude CLI turns via `runClaudeCliTurn`, persists conversations and messages, exposes a 10-tool MCP tool-call surface to the CLI, and monitors pane events.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `Conversation` | Aggregate root. `kind` (assistant or swarm_dm), `workspaceId`, `claudeSessionId`. |
| `Message` | Entity. `role` (user/assistant/tool/system), `content`, `toolCallId`. |
| `JorvisPaneEvent` | Entity. `kind` (started/exited/error/output-spike/idle), links `conversationId` to `sessionId`. |
| `ToolDefinition` | Value object. Schema, parse, handler triple for each of the 10 Jorvis tools. |
| `ActiveTurn` | Value object (in-memory only). Tracks the inflight `conversationId`/`turnId`/`cancelled` state. |

**The 10 Jorvis tools** (cross-context delegates):
`launch_pane`, `create_swarm`, `add_agent_to_swarm`, `list_agent_sessions`, `list_swarms`, `swarm_broadcast`, `swarm_roll_call`, `list_memories`, `list_tasks`, `get_browser_state`.

**Ubiquitous language**: conversation, turn, tool call, tool trace, pane event, resume banner, pattern ribbon, dispatch echo, Jorvis, MCP host server.

**Interfaces to other contexts**:
- PTY Orchestration: uses `PtyRegistry` (launch/list panes) and receives `JorvisPaneEvent` via pane event sink.
- SigmaSwarm: creates and broadcasts to swarms; records `SwarmOrigin`.
- SigmaMemory: reads memories for the `list_memories` tool.
- Tasks: reads tasks for the `list_tasks` tool.
- Ruflo MCP: optionally wires trajectory start/step/end calls for pattern learning.
- ACL: `SigmaMcpHostServer` (`mcp-host-sigma.ts`) is the boundary between Jorvis and the external Claude CLI process — it runs as a local Unix socket MCP server and translates tool calls back into controller dispatch.

---

## Context: Voice / SigmaVoice

**Type**: Supporting  
**Location**: `src/main/core/voice/`

**Responsibility**: Global dictation capture, transcription (Whisper engine or platform-native ASR), intent classification, and output routing — either back into SigmaLink panes via IPC or into the frontmost external application via clipboard / accessibility paste.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `GlobalCapture` | Service. Wraps platform-native audio capture (macOS: Speech.framework via ObjC++ N-API; Windows: WASAPI N-API). |
| `WhisperEngine` | Service. Local on-device Whisper model for offline transcription. |
| `Dispatcher` | Pure function service. Classifies transcript → `ClassifiedIntent` (5 kinds) → routes to registered controllers. |
| `ClassifiedIntent` | Value object. `intent`, `raw`, `args`, `controller`. |
| `OutputRouter` | Service. Decides `OutputTarget` (sigmalink-pane / ax-paste / clipboard) based on frontmost app detection. |

**Intent kinds**: `create_swarm`, `app.navigate`, `swarms.broadcast`, `swarms.rollCall`, `assistant.freeform`.

**Ubiquitous language**: voice capture, transcript, intent, dispatch echo, output target, AX paste, frontmost app, SigmaVoice.

**Interfaces to other contexts**:
- Jorvis Assistant: `assistant.freeform` intent routes to `assistant.send`.
- SigmaSwarm: `create_swarm`, `swarms.broadcast`, `swarms.rollCall` intents delegate to swarm controllers.
- Plan & Capabilities: `sigmavoice.enabled` capability gates the entire context (pro+ only).

---

## Context: Skills

**Type**: Supporting  
**Location**: `src/main/core/skills/`

**Responsibility**: Install, fan-out, and manage skills (Ruflo slash-command markdown packages). A skill is stored in `<userData>/skills/<name>/` with a `SKILL.md` frontmatter. Fan-out writes the skill into each provider's config dir (`.claude/`, codex, gemini). Bindings persist a visual association between a skill and a workspace/pane (currently informational only; behavioral activation is deferred).

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `Skill` | Aggregate root. `id`, `name`, `contentHash`, `managedPath`, `version`, `tags`. |
| `SkillProviderState` | Entity. Per-(skill, provider) enabled flag + `lastFanoutAt`. |
| `SkillBinding` | Entity. Associates a skill with a `workspaceId` and optional `paneSessionId`. Currently informational. |
| `SkillFrontmatter` | Value object. Parsed YAML header of `SKILL.md` (`name`, `description`, `whenToUse`, `allowedTools`, etc.). |
| `FanoutResult` | Value object. Per-provider success/failure record from a fan-out operation. |

**Providers targeted**: `claude`, `codex`, `gemini` (type alias `ProviderTarget`).

**Ubiquitous language**: skill, fan-out, binding, slash-command activation, frontmatter, managed path, skill marketplace, content hash.

**Interfaces to other contexts**:
- SigmaSwarm: `SwarmSkill` references skills by `skillKey` string (loose coupling; no FK).
- Ruflo MCP: marketplace fetch calls Ruflo's transfer store endpoint via the HTTP daemon proxy.
- Provider / SigmaCode: fan-out writes into each provider's config directory.

---

## Context: SigmaMemory

**Type**: Supporting  
**Location**: `src/main/core/memory/`

**Responsibility**: Wikilink-based markdown notes per workspace. Persists to SQLite (`memories`, `memory_links`, `memory_tags`). Exposes a graph view and a search/suggest surface. Also runs an optional embedded Ruflo MCP memory server per workspace.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `Memory` | Aggregate root. `id`, `workspaceId`, `name`, `body`, `tags[]`, `links[]` (outgoing wikilink targets). |
| `MemoryLink` | Entity. `fromMemoryId` → `toMemoryName` edge. |
| `MemoryTag` | Value object. (memoryId, tag) pair. |
| `MemoryGraph` | Read model. Nodes (id, label, tagCount, refCount) + edges. |
| `MemoryHubStatus` | Read model. Hub path, MCP command, counts. |
| `MemoryConnectionSuggestion` | Read model. Similarity suggestions based on shared tags. |

**Ubiquitous language**: memory, note, wikilink, backlink, memory hub, tag, memory graph, connection suggestion.

**Interfaces to other contexts**:
- Jorvis Assistant: tools read memories; assistant can create/update memories via tool calls.
- Cross-machine Sync: `memories`, `memory_links`, `memory_tags` are in the sync scope (CRDT dirty-tracked).
- Ruflo MCP: per-workspace Ruflo memory MCP server (`memory/mcp-server.ts`) runs alongside the HTTP daemon.

---

## Context: Cross-machine Sync

**Type**: Supporting  
**Location**: `src/main/core/sync/`

**Responsibility**: CRDT-style LWW conflict resolution with Hybrid Logical Clocks (HLC). Encrypts rows via AEAD, stages them as git blobs in a remote bare repo, pushes/pulls on a 30s ± 5s interval. Manages conflict quarantine and schema-version upgrade queues.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `SyncState` | Entity. Per-(table, rowId) HLC vector + dirty flag + rowHash. |
| `SyncConflict` | Entity. Captured LWW conflict with local/remote JSON snapshots for user review. |
| `SyncTombstone` | Value object. Deleted row marker with HLC for propagation. |
| `HLC` | Value object. Hybrid Logical Clock (wallMs, logical, machineId). |
| `KeyManager` | Service. Derives and zeros the AEAD key; never stores plaintext. |
| `DirtyTracker` | Service. Application-level write hook; marks rows dirty after INSERT/UPDATE. |

**Sync scope** (hard-coded allowlist):
- IN: workspaces, agent_sessions, swarms, swarm_agents, swarm_messages, swarm_skills, conversations, messages, jorvis_pane_events, memories, memory_links, memory_tags, tasks, task_comments, canvases, canvas_dispatches, boards, swarm_origins, swarm_replay_snapshots.
- OUT (HARD-DENY): credentials, kv, skills, skill_provider_state, session_review, browser_tabs, notifications, all sync_* tables.

**Ubiquitous language**: dirty row, HLC, AEAD, git blob, quarantine, tombstone, conflict resolution, sync cycle, machine id, mnemonic, key manager.

**Interfaces to other contexts**:
- All synced contexts (Workspace, Swarm, Jorvis, Memory, Tasks): DirtyTracker is injected at the call site of every DB write for synced tables.
- ACL: sync context never reads business objects directly — it works with opaque row JSON blobs, column allowlists, and HLC metadata only.

---

## Context: Notifications

**Type**: Supporting  
**Location**: `src/main/core/notifications/`

**Responsibility**: Aggregates events from multiple source channels (pty-exit, swarm-message, tool-error) into a deduplicated, severity-ranked notification feed. Delivers OS-level desktop notifications. Renderer receives delta envelopes rather than full-list refreshes.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `Notification` | Aggregate root. `kind`, `severity` (info/warn/error/critical), `dedupKey`, `dupCount`, `workspaceId` (nullable for app-global), `payload`. |
| `NotificationsDelta` | Read model / IPC envelope. `added[]`, `removed[]`, `unreadCount`. |

**Sources**: `pty-exit.ts`, `swarm-message.ts`, `tool-error.ts`.

**Ubiquitous language**: notification, severity, dedup key, unread count, notification bell, source event, notification delta.

**Interfaces to other contexts**:
- PTY Orchestration: subscribes to PTY exit events.
- SigmaSwarm: subscribes to swarm message events.
- Jorvis Assistant: subscribes to tool error events.

---

## Context: Ruflo MCP Integration

**Type**: Generic / Infrastructure  
**Location**: `src/main/core/ruflo/`

**Responsibility**: Manages the lifecycle of the per-workspace Ruflo HTTP daemon (`ruflo mcp start -t http`). Provides a proxy layer with circuit-breaker semantics (`RufloProxy`), health state machine, and install/upgrade orchestration. Exposes 5 MCP tool names to callers.

**Key aggregates / entities**:

| Type | Role |
|------|------|
| `DaemonHandle` | Entity. Per-workspace daemon: `pid`, `port`, `workspaceRoot`, `status` (starting/running/crashed/down), `restartCount`. |
| `RufloHealth` | Value object. `state` (absent/starting/ready/degraded/down), `lastError`, `version`, `runtimePath`. |
| `RufloProxy` | Service. HTTP client with circuit breaker. Forwards tool calls to the HTTP daemon. |

**Exposed tool names**: `embeddings_search`, `embeddings_generate`, `agentdb_pattern-search`, `agentdb_pattern-store`, `autopilot_predict`.

**Ubiquitous language**: Ruflo daemon, HTTP daemon, circuit breaker, health probe, restart budget, pattern store, trajectory.

**Interfaces to other contexts**:
- Jorvis Assistant: trajectory tracking calls flow through RufloProxy.
- Skills: marketplace fetch proxied through Ruflo.
- All contexts: health state published to renderer via IPC so settings UI can show degraded/down status.

---

## Context: Plan & Capabilities

**Type**: Generic  
**Location**: `src/main/core/plan/capabilities.ts`

**Responsibility**: Tier × capability matrix. Forward-compat scaffolding for a potential hosted model. Currently always returns ultra (all capabilities on) for SigmaLink local builds.

**Key types**: `Tier` (basic/pro/ultra), `Capability` (swarm.maxSize, sigmamcp.slotCount, sigmavoice.enabled, sigmajarvis.enabled, canvas.enabled).

**Ubiquitous language**: tier, capability, plan gate, ultra, basic, pro.

**Interfaces**: Read-only by swarm factory (maxSize), voice context (enabled gate), assistant (sigmajarvis.enabled), canvas (canvas.enabled).

---

## Context: Provider / SigmaCode

**Type**: Generic  
**Location**: `src/shared/providers.ts`, `src/main/core/providers/`

**Responsibility**: Registry of the 5 CLI coding agent providers. Pure data + probe + spawn façade. No business logic — just the definition objects and `resolveAndSpawn`.

**Key types**: `ProviderId`, `AgentProviderDefinition`, `ProviderProbe`, `ProviderLaunchError`.

**Interfaces**: Used by PTY Orchestration (spawn), Workspace (launcher), Skills (fan-out targets), Swarm factory (roster provider lookup).

---

## Context: IDE / Editor

**Type**: Generic  
**Location**: `src/renderer/features/editor/`, `src/main/core/fs/`

**Responsibility**: Per-pane file tree and editor tab for browsing the pane's git worktree. Read/write file access via the `fs` RPC controller.

**Key types**: `EditorFile` (path, content, encoding, truncated, loadedAt).

**Interfaces**: Workspace & Pane: reads the `worktreePath` from `AgentSession` to root the file tree.

---

## Context: Tasks / Kanban

**Type**: Generic  
**Location**: `src/main/core/tasks/`, `src/renderer/features/tasks/`

**Responsibility**: Simple kanban board (backlog → in_progress → in_review → done → archived). Tasks can be assigned to a direct `AgentSession` or to a `SwarmAgent`.

**Key types**: `Task`, `TaskComment`, `SessionReview` (pass/fail decision on an agent session's diff).

**Interfaces**: Jorvis Assistant reads tasks via `list_tasks` tool; Cross-machine Sync includes tasks and task_comments in the sync scope.

---

## Context Map Summary

| Relationship | Pattern | Description |
|---|---|---|
| Workspace ↔ PTY | Partnership | Workspace owns pane slots; PTY writes `externalSessionId` back. |
| Workspace → Swarm | Customer-Supplier | Workspace `workspaceId` is a required scope key for every swarm. |
| Swarm ↔ Jorvis | Published Language | `SwarmOrigin`, `SwarmMessage` domain events cross the boundary. |
| Jorvis → PTY | ACL (downward) | Jorvis dispatches pane launches; PTY pane events flow up via sink callbacks. |
| Jorvis ↔ SigmaMcpHostServer | ACL | Unix socket MCP server is the anti-corruption layer between Claude CLI and Jorvis controller. |
| Skills → Provider | Conformist | Skills fan-out writes conform to each provider's config convention. |
| SigmaMemory ↔ Sync | Customer-Supplier | Sync treats memory rows as opaque blobs; DirtyTracker calls are injected at write sites. |
| Voice → Jorvis | Conformist | `assistant.freeform` dispatches conform to Jorvis `send` contract. |
| Ruflo ↔ All | Open Host Service | Ruflo HTTP daemon exposes a fixed JSON-RPC surface; callers use the proxy façade. |

---

## DDD Score — Ambiguity & Leaky Boundary Notes

These are observations only. No code was changed.

1. **Jorvis / Swarm boundary is blurry in tools.ts.** `src/main/core/assistant/tools.ts` directly imports `createSwarm`, `addAgentToSwarm`, `listSwarmsForWorkspace` from `swarms/factory`. There is no ACL between the two contexts at the code level — any invariant change in the swarm factory immediately impacts Jorvis tool behavior. Consider a `SwarmApplicationService` façade that Jorvis calls through.

2. **SkillBinding is declared informational but lives in the Skills context.** The comment in `schema.ts` line 718 explicitly says behavioral activation is deferred. The concept of "which skill is active in a pane" is a cross-cutting concern that future work will need to route through either Jorvis or PTY Orchestration. The current design leaves that seam open and undefined.

3. **Sync DirtyTracker is injected at call sites across many contexts.** There is no repository abstraction: controllers call `markDirty(tableName, rowId)` inline after each DB write. This scatters sync-context responsibilities across Workspace, Swarm, Jorvis, Memory, and Tasks contexts. A shared write-through repository layer would consolidate the dirty-marking invariant.

4. **Voice Dispatcher has direct import-time knowledge of Swarm controller signatures.** The `DispatchDeps.controllers` interface in `dispatcher.ts` names `swarmCreate`, `swarmBroadcast`, `swarmRollCall` explicitly. A voice-domain–agnostic intent bus with registered handlers would decouple Voice from Swarm naming conventions.

5. **`JorvisPaneEvent` straddles PTY Orchestration and Jorvis.** The event is emitted by `PtyRegistry` (PTY context) but persisted to `jorvis_pane_events` (Jorvis context). The DB table name couples PTY to Jorvis. A neutral domain event name (e.g. `AgentSessionEvent`) with a Jorvis subscriber would be cleaner.
