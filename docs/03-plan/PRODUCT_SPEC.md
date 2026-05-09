# SigmaLink — Product Specification (Canonical)

Compiled: 2026-05-09
Status: canonical for the rebuild. Source of truth for the build agents in Phase 2 onward. Supersedes ad-hoc notes in `REBUILD_PLAN.md` where they disagree.

Marker conventions:
- `[CONFIRMED]` — directly attested in BridgeMind public sources.
- `[INFERRED]` — design call we made from research synthesis.
- `[CHOSEN]` — answer picked by this spec to close an open question.

---

## 0. Conflict resolutions (C-001 … C-015)

Every conflict surfaced in `docs/02-research/CONFLICTS.md` is resolved here once and applied consistently across this file, `BUILD_BLUEPRINT.md`, and `UI_SPEC.md`.

| ID | Decision | Why |
|---|---|---|
| C-001 | Worktree branch pattern is `sigmalink/<role>/<task>-<8char>`. The 5-char suffix from `REBUILD_PLAN.md` is widened to 8 to remove the collision risk flagged in `02-bug-sweep.md` P1-WORKTREE-PATH-COLLISION. Keeps the `sigmalink/` namespace the rebuild plan picked. | Rebuild plan precedence + bug-sweep evidence. |
| C-002 | Workspace pane grid caps at **16**. Swarm rosters scale to **50**. The legacy MVP `CommandDock` parser cap of 12 is lifted to 16. | Marketing + rebuild plan agree at 16; swarm spec independently supports 50. |
| C-003 | The mailbox schema allows N coordinators (1..N). The "coordinator 10" line in the launch transcript is treated as a misheard token. | No code change; schema flexibility resolves it. |
| C-004 | Provider list ships **eleven** entries: claude, codex, gemini, kimi, cursor, opencode, droid, copilot, aider, continue, custom (shell). Drop the rebuild-plan position that excluded Continue; the legacy MVP already shipped it and the cost of keeping a config row is zero. Auto-detect any other provider found on PATH (Emdash style) but list only these eleven in the picker by default. | Maximises operator coverage without code changes. |
| C-005 | Per-role provider defaults: Coordinator → Codex, Builder → Claude, Scout → Gemini, Reviewer → Codex. Operator override per role at launch. | Speaker recommendation; matches transcript. |
| C-006 | Swarm sizing presets: **Squad (5)**, **Team (10)**, **Platoon (15)**, **Legion (50)**, plus a **Custom** roster builder. Workspace pane presets remain `1/2/4/6/8/10/12/14/16`. | Two preset axes — pane grid and roster — are kept distinct. |
| C-007 | SigmaMemory ships exactly the 12 named tools listed in `REBUILD_PLAN.md` Phase 4. The "three tools" version in the research blueprint is a documented subset. | Rebuild plan precedence. |
| C-008 | Phase 2 starts with operator-supervised orchestration via the file-mailbox bus (no LLM coordinator-as-dispatcher). A Bernstein-style verifier loop is deferred. The Coordinator role IS an LLM agent inside the swarm, but the dispatch substrate is deterministic file IO. | Lower risk; matches the demo. |
| C-009 | SSH remote workspaces remain **out of scope** for v1. The provider abstraction will keep an SSH transport seam but no UI ships. | Rebuild plan precedence. |
| C-010 | Ticketing integrations (Linear/Jira/GitHub Issues) are **out of scope** for v1. | Rebuild plan precedence + IP/scope hygiene. |
| C-011 | Foundation strategy: ground-up rebuild that ports specific patterns from Emdash (Apache-2.0) under NOTICE attribution. Not a fork, not clean-room. | Rebuild plan precedence. |
| C-012 | Subtasks carry a real per-subtask `successCriteria` text field. The legacy "Code compiles and tests pass" constant is removed from the renderer. | Bug correctness + research delegation contract. |
| C-013 | SQLite is the system of record. localStorage holds only the last-active workspace id and last-active room (a thin selection cache). All durable lists live in DB. | Bug-sweep + rebuild plan converge here. |
| C-014 | Renderer ships **eleven** rooms (see §3): Workspaces, Command, Swarm, Review, Memory, Browser, Skills, Tasks, Settings, Bridge Assistant, Command Palette (overlay). The rebuild plan's "five rooms" is widened to capture every navigation surface. | Captures every nav target the launch+V3 videos confirm. |
| C-015 | Naming: top-tab strip lists **Workspaces** (the launcher hub). Once a workspace is open the active room defaults to **Command** (terminal grid). The word "workspace" means the user-level construct (folder + repo + saved entries). The route key for the terminal grid is `command`. | Resolves the room-vs-environment ambiguity. |

---

## 1. Product description (one paragraph)

SigmaLink is a local-first, Electron + React desktop **agentic development environment** that lets a single human operator run a grid of CLI coding agents (Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Droid, Copilot, Aider, Continue, plus a Custom shell) in real PTYs against a Git repository, isolating each agent in its own worktree, optionally coordinating those agents as a role-bearing swarm (Coordinator / Builder / Scout / Reviewer) over a deterministic file-system mailbox, with drag-and-drop Anthropic Skills loading, an embedded controllable browser, a 12-tool wikilink memory MCP server, and a SQLite-backed Kanban + review pipeline — all without cloud sync, accounts, or billing. It is for power users who already use one or more coding-agent CLIs and who want to orchestrate them on their own hardware. (Source: `docs/02-research/REQUIREMENTS_MASTER.md` Workspaces, Swarms, Browser, Memory, Skills, Out-of-scope sections; `docs/02-research/RESEARCH_SUMMARY.md`.)

---

## 2. Workspace types

A "workspace" is the user-level construct: a saved binding of a folder, optional repo root, base branch, and the rooms / sessions that have been opened against it. Three workspace **types** exist; the type is fixed at creation and determines the default room and the launcher form.

### 2.1 Bridge Space (single-workspace agent grid)

- **When to use**: parallel but **independent** CLI agents over the same repo. Default for "give me 4 Claude Code panes in this folder."
- **Who creates it**: operator, via Workspaces room → "+" → "Bridge Space".
- **Contents**:
  - 1..16 PTY panes, one per agent. (Source: `feature-matrix.md` "Up to 16 AI agents in parallel"; `glossary.md` "Pane".)
  - Each pane runs in its own Git worktree if the workspace root is a Git repo, or shares the root folder in direct-folder fallback mode (Source: `REQUIREMENTS_MASTER.md` "Direct-folder fallback".)
  - Per-pane provider, model, optional initial prompt.
- **Persists**: workspace row in `workspaces`, one `agent_sessions` row per pane, one `terminals` row per PTY history buffer flush. Worktree branch persists in Git itself; pool index persists in `worktrees` table.

### 2.2 Bridge Swarm (role-bearing coordinated swarm)

- **When to use**: one mission, multiple agents that need to talk to each other. Hand-off long-running task with minimal intervention. (Source: `glossary.md` "Bridge Swarm"; `workflows.md` W2/W3.)
- **Who creates it**: operator, via Workspaces room → "+" → "Bridge Swarm".
- **Contents**:
  - 1 swarm row (`swarms` table) holding mission, name, directory, supporting context.
  - N agent rows (`swarm_agents`) with role and provider.
  - JSONL inboxes on disk at `<userData>/swarms/<swarmId>/inboxes/<agentId>.jsonl`. (Source: `REBUILD_PLAN.md` Phase 2.)
  - Optional supporting-context files copied to `<userData>/swarms/<swarmId>/brain/`.
- **Persists**: `swarms`, `swarm_agents`, `swarm_messages`. Inboxes are rebuildable from `swarm_messages` after a crash.

### 2.3 Bridge Canvas (visual design tool) `[CHOSEN]`

The launch and V3 videos name a third workspace type but never demo it. We pick a concrete clone:

- **When to use**: select an HTML element in the in-app browser, dispatch a prompt scoped to that element to a chosen provider, optionally drag an asset onto the selection. (Source: `workflows.md` W6 — the Visual Design Tool flow that V3 demonstrates.)
- **Who creates it**: operator, via Workspaces room → "+" → "Bridge Canvas". Also auto-spawned when the operator activates Design Tool inside the Browser room of any other workspace type.
- **Contents**:
  - 1 browser tab (the canvas surface).
  - 1 element-pick overlay state (CSS selector, bounding rect, screenshot blob).
  - A scoped prompt textarea + provider picker.
  - A drop zone for assets; assets are copied to `<userData>/canvases/<canvasId>/assets/`.
  - 0..N Builder agents spawned per submitted prompt. Each builder runs as a Bridge Space pane in the underlying directory.
- **Persists**: `canvases` table (id, workspace_id, current_url, current_selector, asset_count). Each spawned builder writes to `agent_sessions` like a normal pane.
- **Unknowns**: BridgeSpace's exact element-pick visuals, marquee colour, the activation gesture. We pick a Chrome-DevTools-style overlay with `border/glow-cool` highlight and a toolbar toggle in the browser chrome. `[CHOSEN]`

---

## 3. Rooms / panels (renderer surfaces)

The renderer mounts one of eleven surfaces at a time. Sidebar + workspace tab strip pick the active surface. (Source: `REBUILD_PLAN.md` "Architecture (target)" rooms list, expanded with V3 evidence from `glossary.md` and `workflows.md`.)

### 3.1 Workspaces (route `workspaces`, default for a new app session)

- **Purpose**: launcher hub. Pick repo, pick workspace type, pick preset, pick provider per pane / per role, launch.
- **Affordances**: Recent list (sorted by `lastOpenedAt`), folder picker, type picker, preset chooser, per-pane provider grid, "Launch" button.
- **Data shape**: list of `Workspace { id, name, rootPath, repoRoot|null, baseBranch, type, lastOpenedAt }`.
- **Persistence**: every row in `workspaces`. Selection cached in localStorage key `sigmalink.lastWorkspaceId`.

### 3.2 Command (route `command`)

- **Purpose**: terminal grid for a Bridge Space workspace. (Source: `glossary.md` "Pane"; `visual-spec.md` §4.)
- **Affordances**: layout toggle (mosaic / columns / focus), density toggle (compact / balanced / expanded), per-pane Stop, per-pane Close, per-pane Restart, per-pane Jump-to-pane target, status dot, branch indicator, agent label.
- **Data shape**: array of `Session { id, workspaceId, providerId, command, args, cwd, status: 'running'|'exited'|'error', branch, worktreePath?, startedAt, exitedAt?, exitCode? }`.
- **Persistence**: `agent_sessions`, `terminals` (ring-buffer flushes for replay across restarts), `pty:data` events.

### 3.3 Swarm (route `swarm`)

- **Purpose**: roster setup, side-chat, mailbox view, broadcast control for a Bridge Swarm workspace. (Source: `REBUILD_PLAN.md` Phase 2.)
- **Affordances**:
  - Roster setup: roster preset (Squad/Team/Platoon/Legion/Custom) + per-role provider override.
  - Mission box (free text + voice via OS speech if installed).
  - Supporting-context drop zone (PDF/image/text — files copied into `brain/`).
  - Side-chat panel: live tail of `swarm_messages` for the active swarm, filterable per agent and per role.
  - Operator broadcast button: writes one envelope to every inbox.
  - Roll-call button: instructs the active Coordinator to issue a status poll.
  - Per-agent DM lane (right-side address book).
  - Per-role message-count totals (matches G54 12:50 visible counts).
- **Data shape**: `Swarm`, `SwarmAgent[]`, `SwarmMessage[]`.
- **Persistence**: `swarms`, `swarm_agents`, `swarm_messages`. JSONL inboxes are the durable bus; SQLite mirrors them for query speed.

### 3.4 Review (route `review`)

- **Purpose**: Git-mediated approval surface for completed agent work. (Source: `app/README.md` "What is working now"; `REBUILD_PLAN.md` Phase 4.)
- **Affordances**: per-session panel showing `git status`, two-pane diff (Monaco diff), file tree of changed files, command runner (run any test/lint command in the worktree), pass/fail toggle per file, "Commit & Merge" action, inline comments on diff lines.
- **Data shape**: `ReviewItem { sessionId, files: ChangedFile[], commands: CommandRun[], commentsByLine }`. ChangedFile = `{ path, status: 'A'|'M'|'D'|'?', additions, deletions }`.
- **Persistence**: comments and command runs in `review_items` and `review_command_runs`. Diff state is computed live from Git, not cached.

### 3.5 Memory (route `memory`)

- **Purpose**: notes editor + force-directed graph for SigmaMemory. (Source: `REBUILD_PLAN.md` Phase 4.)
- **Affordances**: search box, list of notes, markdown editor with `[[wikilink]]` autocomplete, backlinks panel, suggest-connections panel, tag filter, full-screen graph view (zoom/pan/drag, hover-to-pulse, shift-hover for ego mode — pattern from `mcp-tool-catalog.md` BridgeMemory visualization).
- **Data shape**: `Memory { id, title, body, tagsCsv, createdAt, updatedAt }`, `MemoryEdge { from, to, kind: 'wikilink'|'manual' }`.
- **Persistence**: `memories`, `memory_edges`. The on-disk markdown copy lives in `<workspaceRoot>/.sigmamemory/<title>.md`; SQLite is the index of record.

### 3.6 Browser (route `browser`)

- **Purpose**: in-app Chromium pane that any agent can drive via Playwright MCP. (Source: `browser-spec.md`; `REBUILD_PLAN.md` Phase 3.)
- **Affordances**: address bar, back/forward/reload, tab strip, agent-drive indicator (orange pulse when an MCP client is steering), "Open DevTools" toggle, per-tab snapshot, "Activate Design Tool" toggle (enters Bridge Canvas mode).
- **Data shape**: `BrowserTab { id, workspaceId, url, title, faviconUrl?, isDriving: boolean, createdAt }`.
- **Persistence**: `browser_tabs`. Cookies/localStorage live in a per-workspace Electron `Session` partition `persist:ws-<workspaceId>`. Per-workspace CDP port stored in `workspaces.cdpPort`.

### 3.7 Skills (route `skills`)

- **Purpose**: install / inspect / remove Anthropic-format skills. (Source: `skills-spec.md`; `REBUILD_PLAN.md` Phase 3.)
- **Affordances**: "Drop SKILL.md or skill folder here" zone, list of installed skills, validation badges (zod errors per skill), per-skill enable toggle per provider (Claude/Codex/Gemini), uninstall button.
- **Data shape**: `Skill { id, name, description, version?, source: 'local'|'plugin', enabledProviders: string[], path }`.
- **Persistence**: `skills`. Files at `<userData>/skills/<id>/`. Fan-out symlinks/copies under provider-specific paths (see §7).

### 3.8 Tasks (route `tasks`)

- **Purpose**: Kanban board with task→agent assignment. (Source: `feature-matrix.md` "Built-in Kanban board".)
- **Affordances**: four columns (Todo / In Progress / In Review / Done), drag-drop with dnd-kit, "+" per column to add task, click task → side panel with title/description/successCriteria/assignee/swarmId/sessionId, "Send to agent" button writes a mailbox message, status auto-advance when the assignee marks the task complete.
- **Data shape**: `Task { id, workspaceId, title, description, successCriteria, status, assigneeAgentId?|sessionId?|swarmId?, priority, createdAt, updatedAt, dueAt? }`.
- **Persistence**: `tasks`.

### 3.9 Settings (route `settings`)

- **Purpose**: providers, themes, MCP servers, shortcuts, telemetry toggle, log viewer.
- **Affordances**: provider table (id/command/installHint/version/found checkmark/edit), theme picker (25+ themes via CSS variables), MCP server table (id, command, transport, enabled), keyboard shortcut editor, "Open log file" button, "Reset onboarding" button, "Telemetry: off" toggle (default off, opt-in only). `[CHOSEN]` (resolves open-question 7 about telemetry).
- **Data shape**: settings live in `kv` table (`provider.<id>.commandOverride`, `theme.id`, `mcp.<id>.enabled`, `shortcut.<action>`, `telemetry.optIn`).
- **Persistence**: `kv` only.

### 3.10 Bridge Assistant (route `assistant`)

- **Purpose**: in-app autonomous orchestration agent (the SigmaLink equivalent of "Bridge"). Has tools to launch panes, prompt agents, read workspace files. (Source: `glossary.md` "Bridge agent"; `workflows.md` W5.)
- **Affordances**: a chat panel pinned to the right side or full-room, tool-call inspector, context preview ("see what the assistant sees"), per-turn cancel.
- **Data shape**: `Conversation { id, workspaceId, kind: 'assistant', createdAt }`, `Message { id, conversationId, role: 'user'|'assistant'|'tool', content, toolCallId?, createdAt }`.
- **Persistence**: `conversations`, `messages`.
- **Provider**: configurable; defaults to Claude (opus tier if available) `[CHOSEN]` (resolves video-question E.15).
- **Tools** (the assistant's MCP tool set): `launch_pane(provider,count,initialPrompt?)`, `prompt_agent(sessionId,text)`, `read_files(globs)`, `open_url(url)`, `create_task(title,description,successCriteria,assignee?)`, `create_swarm(name,mission,roster)`, `create_memory(title,body,tags?)`, `search_memories(query)`, `broadcast_to_swarm(swarmId,text)`, `roll_call(swarmId)`. `[CHOSEN]`

### 3.11 Command Palette (overlay; not a route)

- **Purpose**: Cmd/Ctrl+K fuzzy search across all actions, rooms, recent workspaces, providers, skills, tasks, memory notes.
- **Affordances**: shadcn `Command` dialog with grouped results.
- **Data shape**: in-memory only.
- **Persistence**: none. Recent searches cached in localStorage `sigmalink.paletteRecent`.

---

## 4. Agent providers (canonical list)

The eleven entries below are the default registry. A 12th seam, "auto-detected" providers, lets PATH-discovered agents (Amp, Hermes, Qwen, etc.) appear at the bottom of the picker greyed-out until the operator confirms.

Field shape (all entries):
```
ProviderDefinition {
  id: string;                       // stable kebab-case
  name: string;                     // display
  command: string;                  // bare binary name
  altCommands?: string[];           // Windows/PATHEXT alternates
  args?: string[];                  // default args appended on every spawn
  resumeArgs?: string[];            // appended when resuming an existing session
  oneshotArgs?: (prompt: string) => string[]; // builds args for a single prompt
  installHint?: string;             // shown when not found on PATH
  color: string;                    // hex for UI accent
  icon: string;                     // lucide-react icon name
  description: string;
  recommendedRoles?: Role[];        // for swarm picker defaults
}
```

| id | command | install hint | resume / oneshot | recommended roles |
|---|---|---|---|---|
| claude | `claude` (alt `claude.cmd`) | `npm i -g @anthropic-ai/claude-code` | `--resume` / `-p {prompt}` | Builder, Reviewer, Assistant default |
| codex | `codex` (alt `codex.cmd`) | `npm i -g @openai/codex` | `--resume` / `-q {prompt}` | Coordinator, Reviewer |
| gemini | `gemini` (alt `gemini.cmd`) | `npm i -g @google/gemini-cli` | `--resume` / `--prompt {prompt}` | Scout |
| kimi | `kimi` (alt `kimi.cmd`) | manual install (PATH) | none / `--prompt {prompt}` | Builder |
| cursor | `cursor-agent` (alt `cursor-agent.cmd`) | install via Cursor app | `--resume` / `--prompt {prompt}` | Builder |
| opencode | `opencode` (alt `opencode.cmd`) | `npm i -g opencode` | `--resume` / `--prompt {prompt}` | Builder |
| droid | `droid` (alt `droid.cmd`) | `npm i -g @factory-ai/droid` | `--resume` / `--prompt {prompt}` | Builder |
| copilot | `gh copilot` | `gh extension install github/gh-copilot` | n/a / `suggest -t {prompt}` | Reviewer, Scout |
| aider | `aider` | `pipx install aider-chat` | none / `--message {prompt}` | Builder |
| continue | `continue` (alt `continue.cmd`) | `npm i -g @continuedev/cli` | none / `--prompt {prompt}` | Builder |
| custom | (operator-supplied) | n/a | n/a | any |

Sources: `REQUIREMENTS_MASTER.md` Providers; legacy `app/src/_legacy/lib/providers.ts`; `glossary.md` Providers/agent backends; `feature-matrix.md`.

Spawn-resolution rule for Windows (resolves P0 + P1-PROBE-EXEC-WIN): one shared helper `resolveForCurrentOS(command)` walks PATH and PATHEXT; if the resolved path ends in `.cmd`/`.bat` it is wrapped through `cmd.exe /d /s /c`; if it ends in `.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`. Both `core/pty/local-pty.ts`, `core/providers/probe.ts`, and `core/git/runShellLine` route through this helper. (Source: `01-known-bug-windows-pty.md`.)

---

## 5. Swarm protocol

### 5.1 Roles

Four roles, fixed enum `'coordinator' | 'builder' | 'scout' | 'reviewer'`. (Source: `agent-roles-and-protocol.md`.)

- **Coordinator** — staff-engineer persona. Decomposes the mission, assigns file ownership, manages dependencies, unblocks builders.
- **Builder** — senior-engineer persona. Implements, validates, marks done.
- **Scout** — codebase-intelligence persona. Maps the project, surfaces risks/conventions.
- **Reviewer** — principal-engineer persona. Audits, blocks substandard work.

### 5.2 Roster presets

| preset | total | composition |
|---|---|---|
| Squad | 5 | 1 coordinator + 2 builders + 1 scout + 1 reviewer |
| Team | 10 | 2 coordinators + 5 builders + 2 scouts + 1 reviewer |
| Platoon | 15 | 2 coordinators + 7 builders + 3 scouts + 3 reviewers |
| Legion | 50 | 4 coordinators + 30 builders + 10 scouts + 6 reviewers |
| Custom | 1..50 | operator picks each role count |

Sources: `glossary.md` Workspace concepts; `video-frames-log.md` swarm-test counts; `[CHOSEN]` for the Legion 50 split.

### 5.3 Mailbox

- **Path**: `<userData>/swarms/<swarmId>/inboxes/<agentId>.jsonl`. JSON-Lines, one envelope per line, append-only via POSIX `O_APPEND` for crash safety. (Source: `REBUILD_PLAN.md` Phase 2; `mcp-tool-catalog.md` BridgeMemory storage style.)
- **Outbox** mirror at `<userData>/swarms/<swarmId>/outbox.jsonl` for the side-chat tail (every message also appears here in arrival order). `[INFERRED]`
- **DB mirror** in `swarm_messages`. The watcher streams new lines into SQLite; the renderer subscribes to `swarm:message` events.

### 5.4 Message envelope

```ts
type MailboxEnvelope = {
  id: string;                       // ULID
  swarmId: string;
  fromAgentId: string | 'operator';
  toAgentId: string | '*';          // '*' = broadcast
  kind:
    | 'directive'                   // operator → agent, or coordinator → worker
    | 'status'                      // agent self-report
    | 'completion'                  // structured completion report
    | 'escalation'                  // blocker
    | 'roll_call'                   // coordinator-initiated poll
    | 'roll_call_reply'             // worker reply to roll_call
    | 'broadcast'                   // operator broadcast
    | 'artifact';                   // pointer to a file the agent produced
  body: string;                     // free-text payload
  payload?: Record<string, unknown>;// structured fields per kind
  createdAt: number;                // ms epoch
};
```

Per-kind required fields (`payload`):
- `completion`: `{ taskId, filesTouched: string[], validations: { type: 'test'|'lint'|'build', ok: boolean, output? }[], followUps: string[] }`. (Source: `agent-roles-and-protocol.md` "Completion reports" implied minimums.)
- `escalation`: `{ taskId, blockedOn: string, attempts: number, askingOf: 'coordinator'|'operator' }`.
- `roll_call`: `{ pollId, deadlineAt }`.
- `roll_call_reply`: `{ pollId, status: 'idle'|'busy'|'blocked'|'done', currentTaskId?, summary }`.
- `artifact`: `{ taskId, path: string, sizeBytes, mime }`.

### 5.5 Behavioral rules (8 — the 4 confirmed plus 4 inferred)

The bridgeswarm landing page lists 8 rules; the bridgeswarm blog only spells out 4 verbatim. We ship all 8; the 4 added by the marketing page are kept verbatim. (Source: `agent-roles-and-protocol.md`.)

| # | Rule | Source |
|---|---|---|
| 1 | Agents always know full project context before starting. | bridgeswarm landing |
| 2 | Real-time status tracking keeps the swarm synchronized. | bridgeswarm landing |
| 3 | Strict file ownership prevents merge conflicts by design. | bridgeswarm landing |
| 4 | Zero idle chatter — every message advances the goal. | bridgeswarm landing + blog |
| 5 | Structured completion reporting prevents falling through cracks. | bridgeswarm landing (text only) `[INFERRED schema in §5.4]` |
| 6 | Automatic escalation when agents are blocked. | bridgeswarm landing (text only) `[INFERRED escalation envelope in §5.4]` |
| 7 | Safe Git practices enforced at orchestration layer. | bridgeswarm landing (text only) `[INFERRED concrete rules below]` |
| 8 | Agents prioritize shipping code over sending messages. | bridgeswarm landing |

Concrete enforcement of rule 7 in SigmaLink `[INFERRED]`:
- No force-push from agents (the orchestration layer rejects `--force` / `--force-with-lease`).
- One branch per agent (the worktree pool guarantees this).
- Commits are signed off with the agent id in the trailer (`Sigma-Agent: <providerId>:<sessionId>`).
- Merges to base branch happen only via the Review Room "Commit & Merge" button (operator gate).
- File ownership is recorded in `task_file_locks`; no two non-completed tasks may own the same file.

### 5.6 Broadcast and roll-call patterns

- **Operator broadcast**: operator writes one `broadcast` envelope. The mailbox bus copies it to every agent inbox, then writes an outbox marker. Agents render it as a system message at next read.
- **Roll-call**: operator clicks "Roll call" or messages a coordinator with a `directive` whose body matches `/roll call/i`. The coordinator emits a `roll_call` envelope to every other agent in the same swarm. Each agent replies with a `roll_call_reply` within the deadline (default 60s `[CHOSEN]`). The coordinator aggregates and emits one `status` envelope summarising. The operator sees the aggregate in the side chat.

---

## 6. SigmaMemory (BridgeMemory equivalent)

### 6.1 Tools (12, full signatures) `[CHOSEN]` for parameter shapes

The 12 tool names come from `REBUILD_PLAN.md` Phase 4. Their parameter signatures are not published by BridgeMind, so we pick the following:

```ts
type Memory = {
  id: string;          // ULID
  title: string;       // unique within hub; URL-safe by default
  body: string;        // markdown, may include [[wikilinks]]
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

// 1. create_memory
// returns Memory; errors: { code: 'TITLE_TAKEN' | 'INVALID_TITLE' }
create_memory(title: string, body: string, tags?: string[]): Memory

// 2. search_memories
// returns array sorted by relevance (title hits ranked higher than body, ties by recency)
search_memories(query: string, limit?: number /*default 20*/): Memory[]

// 3. find_backlinks
// returns Memory[] that contain [[title]]
find_backlinks(title: string): Memory[]

// 4. suggest_connections
// keyword-based ranking (no embeddings); tokenize active memory, filter stop-words, rank by shared 4+ char keywords
suggest_connections(memoryId: string, limit?: number /*default 5*/): { memory: Memory; score: number }[]

// 5. update_memory
// errors: { code: 'NOT_FOUND' | 'TITLE_TAKEN' }
update_memory(id: string, patch: { title?: string; body?: string; tags?: string[] }): Memory

// 6. delete_memory
// returns { ok: true }; errors: { code: 'NOT_FOUND' }
delete_memory(id: string): { ok: true }

// 7. list_memories
list_memories(opts?: { tag?: string; offset?: number; limit?: number }): Memory[]

// 8. get_memory
// errors: { code: 'NOT_FOUND' }
get_memory(idOrTitle: string): Memory

// 9. link_memories
// adds an edge; idempotent
link_memories(fromId: string, toId: string, kind?: 'wikilink'|'manual'): { ok: true }

// 10. get_graph
// returns nodes + edges for the force-directed view
get_graph(opts?: { center?: string; depth?: number /*default 2*/ }): { nodes: { id: string; title: string; tagCount: number }[]; edges: { from: string; to: string; kind: string }[] }

// 11. tag_memory
tag_memory(id: string, tags: string[], op: 'add'|'remove'|'set'): Memory

// 12. get_recent_memories
get_recent_memories(limit?: number /*default 10*/): Memory[]
```

All tools speak MCP JSON-RPC over stdio; a thin in-process server lives in `core/memory/server.ts`.

### 6.2 Storage layout

- Disk: `<workspaceRoot>/.sigmamemory/<title>.md`. Title is the unique id; body is the file. Frontmatter is YAML between `---` markers carrying `id`, `tags`, `createdAt`, `updatedAt`. (Source: `REBUILD_PLAN.md` Phase 4; `mcp-tool-catalog.md` BridgeMemory storage.)
- Index: SQLite `memories` and `memory_edges`. The disk file is the source of truth for body; SQLite is the index of record for search and graph queries.

### 6.3 Wikilink syntax

`[[Title]]` — exact title match.
`[[Title|alias]]` — render `alias` but link to `Title`.
`[[Title#section]]` — point at a section anchor (slugified heading).

When a memory body changes, the edge table is rebuilt for that memory id in the same SQLite transaction as the body update.

### 6.4 Transactional write strategy

Each mutating tool (`create_memory`, `update_memory`, `delete_memory`, `tag_memory`, `link_memories`) executes inside one `db.transaction(() => { ... })` that:
1. Writes the disk file atomically via temp-file-plus-rename. (Source: `mcp-tool-catalog.md` "Atomic writes via temp-file-plus-rename".)
2. Inserts/updates/deletes the SQLite row.
3. Rebuilds outgoing edges (parses `[[...]]` from the body and replaces `memory_edges` rows where `from = id`).
4. Bumps `updatedAt`.

Failures roll back both: if the disk write succeeds but the DB transaction throws, the temp file is deleted in a finally block; if the DB transaction succeeds but the disk write fails, the transaction is aborted before commit.

---

## 7. Skills system

### 7.1 SKILL.md format

Anthropic Agent Skills format. (Source: `skills-spec.md`.) Frontmatter fields supported:

| field | required? | notes |
|---|---|---|
| `name` | recommended | lowercase + numbers + hyphens; ≤64 chars |
| `description` | yes | first 1,536 chars used in skill listing |
| `when_to_use` | optional | extra trigger phrases |
| `argument-hint` | optional | autocomplete hint |
| `arguments` | optional | yaml list or space-separated names |
| `disable-model-invocation` | optional | true ⇒ user-only |
| `user-invocable` | optional | false hides from slash menu |
| `allowed-tools` | optional | pre-approved tool names |
| `model` | optional | provider model override |
| `effort` | optional | `low|medium|high|xhigh|max` |
| `context` | optional | `fork` runs in subagent |
| `agent` | optional | subagent type (Explore/Plan/general-purpose/custom) |
| `hooks` | optional | skill-scoped hooks |
| `paths` | optional | glob patterns gating auto-activation |
| `shell` | optional | `bash|powershell` |

Substitutions and dynamic context injection follow the canonical spec verbatim (see `skills-spec.md` for the full grammar).

### 7.2 Drag-and-drop ingestion flow

1. Operator drops a file or folder into the Skills room drop zone or anywhere in the app while holding `Shift` (the latter is `[CHOSEN]`).
2. Renderer uses HTML5 drag, `webkitGetAsEntry`, and the preload's `getPathForFile(file)` to obtain the absolute filesystem path.
3. RPC call: `skills.ingest(path)`.
4. Main process resolves either:
   - a single `SKILL.md` file (treat as standalone skill, parent folder name becomes `id`),
   - a folder containing `SKILL.md` (folder-based skill),
   - a folder containing `skills/<name>/SKILL.md` subfolders (multi-skill plugin layout).
5. Each detected skill is parsed with Zod validators in `src/shared/skills.ts`. Validation errors are returned per-skill; partial success is allowed.
6. Valid skills are copied to `<userData>/skills/<id>/`. The original is not moved.
7. Fan-out (see §7.3).
8. SQLite `skills` row inserted/updated.
9. Renderer event `skills:changed` fires.

### 7.3 Per-provider fan-out

| provider | target path | strategy |
|---|---|---|
| Claude | `~/.claude/skills/<id>/` | hard copy (Anthropic's native location) |
| Codex | `~/.codex/skills/<id>/` | copy + translate `allowed-tools` to Codex tool names |
| Gemini | `~/.gemini/extensions/<id>/` | synthesize `extension.json` from frontmatter; copy SKILL.md alongside |

Skills can be enabled/disabled per-provider in the Skills room. Disabling deletes the fan-out copy but keeps the canonical copy.

### 7.4 Validation rules

- `name` must be lowercase + numbers + hyphens, ≤64 chars; default to folder name if missing.
- `description` required (≤16 KiB, first 1,536 chars used in listing).
- `model`, if present, must match a known provider model id.
- `effort`, if present, must be one of the canonical five.
- Path globs in `paths` must compile with `picomatch`.
- All shell commands referenced in `!`...`!` blocks must pass a static allowlist (`bash`, `powershell`, `python`, `node`, `git`, `npm`, `pnpm`, `yarn`, `pip`, project-relative scripts under `scripts/`). Skills referencing other shell commands install with a warning badge but do not auto-activate.

---

## 8. In-app browser

### 8.1 Embedding choice

`Electron.WebContentsView` (the modern replacement for `BrowserView`). Per-workspace `Session` partition `persist:ws-<workspaceId>` so cookies/localStorage isolate. (Source: `REBUILD_PLAN.md` Phase 3; DD-017.)

### 8.2 Agent control plumbing

Per workspace, the main process supervises `npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<port>` where `<port>` is allocated lazily on first browser open and stored in `workspaces.cdpPort`. The Electron `webContents` debugger is attached at `attach('1.3')` to expose the CDP port.

Each agent's `.mcp.json` (Claude) / `~/.codex/config.toml` (Codex) / Gemini extension manifest points to the workspace's Playwright MCP HTTP endpoint. When an agent calls a Playwright MCP tool, the browser pane shows the orange agent-drive indicator on the affected tab. (Source: `REBUILD_PLAN.md` Phase 3; DD-018.)

### 8.3 Tab model

```ts
BrowserTab { id, workspaceId, url, title, faviconUrl?, isDriving, createdAt }
```

Tabs stack horizontally above the address bar. Middle-click closes; `Ctrl/Cmd+T` opens. The drive indicator is a per-tab dot that turns orange (warm-amber `border/glow-warm`) while a Playwright MCP call is in flight, and pulses when the cursor moves under MCP control. `[CHOSEN]` for the indicator visual.

### 8.4 Address bar

Editable URL field with autocomplete from `browser_history`. Back/forward arrows, reload, "Open DevTools" toggle, "Activate Design Tool" toggle (transitions to Bridge Canvas mode for the current tab).

### 8.5 History

Stored in `browser_history` table: `{ id, workspaceId, url, title, visitedAt }`. Pruned to 10,000 most recent rows per workspace at app start.

---

## 9. Tasks / Kanban

- **Columns**: Todo / In Progress / In Review / Done. (Source: `REBUILD_PLAN.md` Phase 4; `feature-matrix.md`.)
- **Drag-drop semantics**: dnd-kit; dragging a card across columns updates `tasks.status` immediately. The "In Review" column auto-receives a card when the assignee writes a `completion` mailbox envelope (swarm context) or marks the related session done.
- **Agent assignment**: per task, choose an `assigneeAgentId` (a swarm agent), `sessionId` (a Bridge Space pane), or `swarmId` (delegate to the coordinator of the swarm).
- **Status tracking**: every transition writes a row to `task_events`. UI shows the timeline in the task side panel.

---

## 10. Persistence — final SQLite schema

All tables. Drizzle-managed, one source of truth, no hand-rolled CREATE TABLE drift (resolves W10). Schema definitions live in `electron/core/db/schema.ts`. Foreign keys ON; WAL mode; busy timeout 5000ms.

### Tables and columns

```sql
-- 1. workspaces
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,                 -- ULID
  name          TEXT NOT NULL,
  root_path     TEXT NOT NULL UNIQUE,
  repo_root     TEXT,                             -- NULL ⇒ direct-folder mode
  base_branch   TEXT NOT NULL DEFAULT 'HEAD',
  type          TEXT NOT NULL CHECK (type IN ('space','swarm','canvas')),
  cdp_port      INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  last_opened_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);
CREATE INDEX idx_workspaces_last_opened ON workspaces(last_opened_at DESC);

-- 2. projects (logical grouping; one workspace can map to one project; reserved for future ticket integration)
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_projects_workspace ON projects(workspace_id);

-- 3. agent_sessions
CREATE TABLE agent_sessions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  swarm_id        TEXT REFERENCES swarms(id) ON DELETE SET NULL,
  swarm_agent_id  TEXT REFERENCES swarm_agents(id) ON DELETE SET NULL,
  provider_id     TEXT NOT NULL,
  command         TEXT NOT NULL,
  args_json       TEXT NOT NULL DEFAULT '[]',
  cwd             TEXT NOT NULL,
  branch          TEXT,
  worktree_path   TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','exited','error')) DEFAULT 'running',
  exit_code       INTEGER,
  started_at      INTEGER NOT NULL,
  exited_at       INTEGER
);
CREATE INDEX idx_sessions_workspace ON agent_sessions(workspace_id, status);
CREATE INDEX idx_sessions_swarm ON agent_sessions(swarm_id);

-- 4. terminals (ring-buffer flushes for replay across app restarts)
CREATE TABLE terminals (
  session_id  TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  buffer      BLOB NOT NULL,                    -- last ≤256 KiB of output
  cols        INTEGER NOT NULL,
  rows        INTEGER NOT NULL,
  flushed_at  INTEGER NOT NULL
);

-- 5. worktrees (pool index)
CREATE TABLE worktrees (
  id            TEXT PRIMARY KEY,
  repo_root     TEXT NOT NULL,
  branch        TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  session_id    TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  removed_at    INTEGER
);
CREATE INDEX idx_worktrees_repo ON worktrees(repo_root);

-- 6. swarms
CREATE TABLE swarms (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  mission         TEXT NOT NULL,
  preset          TEXT NOT NULL CHECK (preset IN ('squad','team','platoon','legion','custom')),
  brain_dir       TEXT NOT NULL,                -- supporting context root
  created_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX idx_swarms_workspace ON swarms(workspace_id);

-- 7. swarm_agents
CREATE TABLE swarm_agents (
  id          TEXT PRIMARY KEY,
  swarm_id    TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('coordinator','builder','scout','reviewer')),
  role_index  INTEGER NOT NULL,                 -- 1-based per role within swarm
  provider_id TEXT NOT NULL,
  inbox_path  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idle'
                CHECK (status IN ('idle','busy','blocked','done','error'))
);
CREATE INDEX idx_swarm_agents_swarm ON swarm_agents(swarm_id);
CREATE UNIQUE INDEX uq_swarm_agents_role_index ON swarm_agents(swarm_id, role, role_index);

-- 8. swarm_messages
CREATE TABLE swarm_messages (
  id            TEXT PRIMARY KEY,
  swarm_id      TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL,                  -- 'operator' or swarm_agents.id
  to_agent_id   TEXT NOT NULL,                  -- '*' or swarm_agents.id
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  payload_json  TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_swarm_messages_swarm_time ON swarm_messages(swarm_id, created_at DESC);
CREATE INDEX idx_swarm_messages_to ON swarm_messages(swarm_id, to_agent_id);

-- 9. tasks
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  success_criteria  TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('todo','in_progress','in_review','done'))
                       DEFAULT 'todo',
  priority          INTEGER NOT NULL DEFAULT 0,
  assignee_kind     TEXT CHECK (assignee_kind IN ('agent','session','swarm')),
  assignee_id       TEXT,
  due_at            INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_tasks_workspace_status ON tasks(workspace_id, status);

-- 10. task_events (audit timeline)
CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id, created_at);

-- 11. task_file_locks (rule-3 enforcement)
CREATE TABLE task_file_locks (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file     TEXT NOT NULL,
  PRIMARY KEY (task_id, file)
);
CREATE INDEX idx_task_file_locks_file ON task_file_locks(file);

-- 12. conversations (Bridge Assistant chats)
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('assistant','swarm_dm')),
  title         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_conversations_workspace ON conversations(workspace_id);

-- 13. messages (assistant + DMs)
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content         TEXT NOT NULL,
  tool_call_id    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv_time ON messages(conversation_id, created_at);

-- 14. skills
CREATE TABLE skills (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  version           TEXT,
  source            TEXT NOT NULL CHECK (source IN ('local','plugin')),
  enabled_providers TEXT NOT NULL DEFAULT '[]',  -- JSON array
  path              TEXT NOT NULL,
  installed_at      INTEGER NOT NULL,
  validation_json   TEXT                         -- per-rule status
);

-- 15. memories
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL UNIQUE,
  body        TEXT NOT NULL,
  tags_csv    TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_memories_updated ON memories(updated_at DESC);
CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, content='memories', content_rowid='rowid');

-- 16. memory_edges
CREATE TABLE memory_edges (
  from_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('wikilink','manual')),
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX idx_memory_edges_to ON memory_edges(to_id);

-- 17. browser_tabs
CREATE TABLE browser_tabs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT,
  favicon_url   TEXT,
  is_driving    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_browser_tabs_ws ON browser_tabs(workspace_id);

-- 18. browser_history
CREATE TABLE browser_history (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT,
  visited_at    INTEGER NOT NULL
);
CREATE INDEX idx_browser_history_ws_time ON browser_history(workspace_id, visited_at DESC);

-- 19. canvases
CREATE TABLE canvases (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  current_url     TEXT,
  current_selector TEXT,
  asset_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 20. review_items
CREATE TABLE review_items (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_review_items_session ON review_items(session_id);

-- 21. review_command_runs
CREATE TABLE review_command_runs (
  id              TEXT PRIMARY KEY,
  review_item_id  TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  command_line    TEXT NOT NULL,
  exit_code       INTEGER,
  output          TEXT NOT NULL DEFAULT '',
  ran_at          INTEGER NOT NULL
);
CREATE INDEX idx_review_runs_item ON review_command_runs(review_item_id);

-- 22. review_comments
CREATE TABLE review_comments (
  id              TEXT PRIMARY KEY,
  review_item_id  TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  file            TEXT NOT NULL,
  line            INTEGER NOT NULL,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_review_comments_item_file ON review_comments(review_item_id, file);

-- 23. mcp_servers (catalog + per-server enabled state)
CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,                 -- e.g. 'playwright', 'memory', 'filesystem', 'git'
  name        TEXT NOT NULL,
  command     TEXT NOT NULL,
  args_json   TEXT NOT NULL DEFAULT '[]',
  transport   TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- 24. providers_state (per-provider runtime state — found, version, command override)
CREATE TABLE providers_state (
  id              TEXT PRIMARY KEY,             -- matches ProviderDefinition.id
  found           INTEGER NOT NULL DEFAULT 0,
  resolved_path   TEXT,
  version         TEXT,
  command_override TEXT,                        -- if user customised the command
  last_probed_at  INTEGER NOT NULL
);

-- 25. kv (settings + small flags)
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 26. migrations
CREATE TABLE migrations (
  id            INTEGER PRIMARY KEY,
  applied_at    INTEGER NOT NULL,
  description   TEXT NOT NULL
);
```

Total: 26 tables.

---

## 11. RPC surface

All RPC follows `<namespace>.<method>` and returns `{ ok: true, data } | { ok: false, error }`. Preload allowlist is the union of all method ids below; anything else is rejected (resolves W4 / P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST).

### app.*
- `app.getVersion()` → `{ version, electron, node }`
- `app.openLogFile()` → `{ path }`
- `app.relaunch()` → `void`
- `app.quit()` → `void`

### workspaces.*
- `workspaces.list()` → `Workspace[]`
- `workspaces.create(input)` → `Workspace`
- `workspaces.open(id)` → `Workspace`
- `workspaces.forget(id)` → `void`
- `workspaces.launch(plan)` → `{ sessions: SessionSummary[] }`
- `workspaces.setBaseBranch(id, branch)` → `void`

### pty.*
- `pty.create(input)` → `SessionSummary`
- `pty.write(sessionId, data)` → `void`
- `pty.resize(sessionId, cols, rows)` → `void`
- `pty.kill(sessionId)` → `void`
- `pty.subscribe(sessionId)` → `{ snapshot: string; cols, rows }`
- `pty.unsubscribe(sessionId)` → `void`
- `pty.list()` → `SessionSummary[]`
- `pty.forget(sessionId)` → `void`

### providers.*
- `providers.list()` → `ProviderDefinition[]`
- `providers.probeAll()` → `ProviderProbe[]`
- `providers.setCommandOverride(id, command|null)` → `void`

### git.*
- `git.status(sessionId)` → `GitStatus`
- `git.diff(sessionId, file?)` → `string`
- `git.commitAndMerge(sessionId, message)` → `{ commitSha }`
- `git.runCommand(cwd, args[])` → `{ stdout, stderr, exitCode }` *(args, not a tokenised line — resolves P1-RUN-SHELL-TOKENISER)*

### swarms.*
- `swarms.create(input)` → `Swarm`
- `swarms.list(workspaceId)` → `Swarm[]`
- `swarms.get(id)` → `Swarm`
- `swarms.end(id)` → `void`
- `swarms.broadcast(swarmId, body)` → `void`
- `swarms.rollCall(swarmId)` → `void`
- `swarms.send(swarmId, fromAgentId, toAgentId, kind, body, payload?)` → `MailboxEnvelope`
- `swarms.tail(swarmId, opts?)` → `MailboxEnvelope[]`

### tasks.*
- `tasks.list(workspaceId, opts?)` → `Task[]`
- `tasks.create(input)` → `Task`
- `tasks.update(id, patch)` → `Task`
- `tasks.delete(id)` → `void`
- `tasks.assign(id, kind, assigneeId)` → `Task`
- `tasks.transition(id, status)` → `Task`
- `tasks.lockFiles(id, files[])` → `{ ok: true } | { ok: false, conflicts: { file: string; taskId: string }[] }`

### skills.*
- `skills.list()` → `Skill[]`
- `skills.ingest(path)` → `{ installed: Skill[]; errors: { path: string; reason: string }[] }`
- `skills.remove(id)` → `void`
- `skills.setProviderEnabled(id, providerId, enabled)` → `Skill`

### memory.*
- `memory.create_memory(...)`, `memory.search_memories(...)`, … (all 12 tools mirrored as RPC methods with identical signatures to §6.1).
- `memory.openHub(workspaceRoot)` → `{ ok: true }`
- `memory.exportGraph()` → `{ json: string }`

### browser.*
- `browser.openTab(workspaceId, url?)` → `BrowserTab`
- `browser.closeTab(id)` → `void`
- `browser.navigate(id, url)` → `void`
- `browser.back(id)` / `browser.forward(id)` / `browser.reload(id)` → `void`
- `browser.attachDevTools(id)` → `void`
- `browser.activateDesignTool(id)` → `void`
- `browser.pickElement(id)` → `{ selector, rect, screenshotBlob }`
- `browser.cdpEndpoint(workspaceId)` → `{ url }`

### mcp.*
- `mcp.list()` → `McpServer[]`
- `mcp.setEnabled(id, enabled)` → `McpServer`
- `mcp.writeAgentConfig(sessionId)` → `{ paths: string[] }` *(writes provider-native config files for the session)*

### review.*
- `review.list(workspaceId)` → `ReviewItem[]`
- `review.get(id)` → `ReviewItem & { files, runs, comments }`
- `review.runCommand(id, line)` → `CommandRun`
- `review.addComment(id, file, line, body)` → `Comment`
- `review.decide(id, decision)` → `ReviewItem`

### settings.*
- `settings.get(key)` → `string | null`
- `settings.set(key, value)` → `void`
- `settings.allTheme()` → `Theme[]`
- `settings.setTheme(id)` → `void`

### assistant.*
- `assistant.startConversation(workspaceId)` → `Conversation`
- `assistant.sendMessage(conversationId, content)` → `Message`
- `assistant.cancel(conversationId)` → `void`
- `assistant.history(workspaceId)` → `Conversation[]`

### canvas.*
- `canvas.create(workspaceId, url?)` → `Canvas`
- `canvas.setSelection(id, selector, rect)` → `void`
- `canvas.dispatchPrompt(id, providerId, prompt, assetPaths?[])` → `SessionSummary`

### events (preload eventOn)
- `pty:data { sessionId, chunk }`
- `pty:exit { sessionId, exitCode }`
- `swarm:message { swarmId, envelope }`
- `swarm:agent_status { swarmAgentId, status }`
- `tasks:changed { workspaceId }`
- `skills:changed`
- `browser:driving { tabId, isDriving }`
- `memory:changed { id }`
- `review:changed { id }`
- `providers:changed`

Total RPC methods: ~75.

---

## 12. Visual style

Detailed pixel work lives in `UI_SPEC.md`. The headline tokens are:

- **Surface palette** (dark default): `bg/canvas #0B0C10`, `bg/pane #101216`, `bg/pane-header #16191F`, `bg/tab-active #1B1E24`, `bg/tab-inactive #0E1014`, `border/subtle #1F2229`. (Source: `visual-spec.md` §2.1.)
- **Brand glow**: warm `#E6A23A → transparent` and cool `#3FA9F5 → transparent`, 30–60 px radial blur, used on hero surfaces only — never as a default chrome accent.
- **Typography**: monospace for terminals (`JetBrains Mono, SFMono-Regular, Menlo, Consolas`), sans for chrome (`Inter, SF Pro, system-ui`). All caps display only in the wordmark.
- **Spacing**: 4 px base scale (`0, 1, 2, 3, 4, 6, 8, 12, 16, 24` × 4 px).
- **Panel layout**: tab strip 40 px tall; pane header 28 px; sidebar 48 px collapsed / 240 px expanded. Mosaic min 320 × 300 (balanced default).
- **Motion**: 120 ms standard easing, 180 ms emphasised easing, no animation longer than 240 ms outside hero glow pulses.

---

## 13. Keyboard shortcuts

Final binding table. macOS uses `Cmd`; Windows/Linux use `Ctrl`. (Source: `keyboard-shortcuts.md` for confirmed bindings; `[CHOSEN]` marked for invented bindings, resolves open-questions 2/3/5.)

| action | mac | win/linux | notes |
|---|---|---|---|
| New workspace dialog | Cmd+T | Ctrl+T | Confirmed (G54 03:50). |
| Close active tab | Cmd+W | Ctrl+W | Confirmed (BridgeSpace docs). |
| Quick Open (file in repo) | Cmd+P | Ctrl+P | Confirmed. |
| Search in active terminal | Cmd+F | Ctrl+F | Confirmed. |
| Split active pane | Cmd+D | Ctrl+D | Confirmed (mac); mirror on Win. |
| Switch to tab N (1–9) | Cmd+1..9 | Ctrl+1..9 | Confirmed. |
| Command Palette | Cmd+K | Ctrl+K | Confirmed for docs; reused here. |
| Jump to Workspaces room | Cmd+0 | Ctrl+0 | `[CHOSEN]` |
| Jump to Command room | Cmd+Shift+1 | Ctrl+Shift+1 | `[CHOSEN]` |
| Jump to Swarm room | Cmd+Shift+2 | Ctrl+Shift+2 | `[CHOSEN]` |
| Jump to Review room | Cmd+Shift+3 | Ctrl+Shift+3 | `[CHOSEN]` |
| Jump to Memory room | Cmd+Shift+4 | Ctrl+Shift+4 | `[CHOSEN]` |
| Jump to Browser room | Cmd+Shift+5 | Ctrl+Shift+5 | `[CHOSEN]` |
| Jump to Skills room | Cmd+Shift+6 | Ctrl+Shift+6 | `[CHOSEN]` |
| Jump to Tasks room | Cmd+Shift+7 | Ctrl+Shift+7 | `[CHOSEN]` |
| Jump to Settings room | Cmd+, | Ctrl+, | `[CHOSEN]` |
| Toggle Bridge Assistant | Cmd+J | Ctrl+J | `[CHOSEN]` |
| Cycle pane focus next | Alt+Tab inside grid | Alt+Tab inside grid | `[CHOSEN]` (intercept inside Command room only) |
| Focus pane N | Cmd+Alt+1..9 | Ctrl+Alt+1..9 | `[CHOSEN]` |
| Toggle layout (mosaic→cols→focus) | Cmd+\\ | Ctrl+\\ | `[CHOSEN]` |
| Toggle density | Cmd+Alt+\\ | Ctrl+Alt+\\ | `[CHOSEN]` |
| Send broadcast (Swarm room) | Cmd+Enter | Ctrl+Enter | `[CHOSEN]` |
| Roll call | Cmd+Shift+R | Ctrl+Shift+R | `[CHOSEN]` |
| Open DevTools (browser) | Cmd+Alt+I | Ctrl+Alt+I | `[CHOSEN]` |
| New browser tab | Cmd+T (when in Browser) | Ctrl+T | shared with workspace tab via context heuristic — workspace tab strip has priority unless the Browser room is full-screened |
| Activate Design Tool | Cmd+Shift+D | Ctrl+Shift+D | `[CHOSEN]` |
| Send to active agent | Cmd+Enter (in any prompt) | Ctrl+Enter | `[CHOSEN]` |

---

## 14. Pricing tiers

SigmaLink is open-source (MIT) and local-only. Every feature in this spec is free in our clone. There is no Basic/Pro/Ultra split. There are no credits, no metering, no accounts, no billing surface. The Settings room hides all pricing-related UI.

---

## 15. Out of scope (explicit, with rationale)

| feature | rationale |
|---|---|
| SSH remote development UI | Touches network/auth; out of scope per `REBUILD_PLAN.md`; the provider abstraction keeps a transport seam. |
| Voice assistant (BridgeVoice / BridgeJarvis equivalent) | Adds STT vendor risk; OS-level dictation already exists; out of scope per `REBUILD_PLAN.md`. |
| Ticket integrations (Linear / Jira / GitHub Issues) | OAuth + cloud writes; conflicts with local-first stance. |
| Cloud sync of workspaces/memory | Would require accounts and a server; out of scope. |
| Mobile companion app | The clone target mobile shell exists in V3 but is wholly out of scope. |
| Account creation, billing, credit metering | The clone is free. |
| Telemetry by default | We respect `[CHOSEN]` an explicit opt-in; default off. |
| BridgeBench-style benchmark runner | Independent product, separate scope. |
| Plugin marketplace (`@bridgemind-plugins` style) | Skills are loaded from disk; we do not host a marketplace. |
| Auto-update server | Use OS package managers for now; ship a static installer. |
| Bug-bounty program | Operational, not a product feature. |

---

## Status note

SigmaLink ships **23 product features** at v1: workspace types (Bridge Space, Bridge Swarm, Bridge Canvas), Command room with three layouts and three densities, Swarm room with file-mailbox bus, broadcast, and roll-call, Review room with diff viewer + command runner + commit/merge, Memory room with 12-tool MCP server and force-directed graph, Browser room with controllable WebContentsView and Playwright MCP supervisor, Skills drag-and-drop ingest with three-target fan-out, Tasks Kanban with file-ownership locks, Bridge Assistant chat, Command Palette overlay, Settings with 25+ themes, eleven canonical providers plus auto-detect, per-agent Git worktree isolation, per-workspace CDP endpoint, Cmd+K palette, full keyboard binding table, and one shared spawn-resolution helper that fixes the Windows PTY bug. The RPC surface comprises **~75 methods** across 13 namespaces. Persistence covers **26 SQLite tables** plus the `kv` settings store and a `migrations` ledger. The top **5 risk areas** the critique agents should focus on are: (1) the Windows PTY spawn-resolution helper and PTY-lifecycle finalisation (P0 + W1/W2/W3), (2) the swarm mailbox crash-safety boundary between JSONL append and SQLite mirror (lossless re-derivation requirement), (3) the Skills validation + fan-out atomicity when one of three target paths fails partway through, (4) the per-workspace Playwright MCP supervisor lifecycle and CDP port allocation under rapid open/close, and (5) the Memory transactional write strategy where disk + SQLite + edge rebuild must commit-or-rollback as one unit.
