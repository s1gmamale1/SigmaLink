# SigmaLink — Product Specification (Canonical)

Compiled: 2026-05-09
Status: canonical for the rebuild. Source of truth for the build agents in Phase 2 onward. Supersedes ad-hoc notes in `REBUILD_PLAN.md` where they disagree.

Marker conventions:
- `[CONFIRMED]` — directly attested in BridgeMind public sources.
- `[INFERRED]` — design call we made from research synthesis.
- `[CHOSEN]` — answer picked by this spec to close an open question.

---

## 0. Conflict resolutions (C-001 … C-016)

Every conflict surfaced in `docs/02-research/CONFLICTS.md` is resolved here once and applied consistently across this file, `BUILD_BLUEPRINT.md`, and `UI_SPEC.md`.

**C-016 — V3 supersedes original spec where they diverge.** After Wave 11's three-walker
frame-by-frame study of the BridgeSpace V3 video (553 frames, `docs/02-research/v3-frame-by-frame.md`)
and Wave 11.5 scope-freeze, V3 is the canonical reference for every divergent surface
listed below. The execution backlog lives at `docs/03-plan/V3_PARITY_BACKLOG.md`. Divergent items:
- Roster preset reset: **Legion 50 dropped, Battalion 20 added** (`v3-agent-roles-delta.md` §2; supersedes C-006).
- Provider matrix: **11 → 9 default**; `BridgeCode` added; `kimi` demoted to model option under OpenCode; `aider`/`continue` hidden behind Settings legacy toggle (`v3-providers-delta.md`; supersedes C-004).
- Bridge Canvas: **promoted from research-deferred to first-class room** (frames 0368-0405; supersedes master_memory deferred list).
- Bridge Assistant: **promoted from research-deferred to first-class right-rail tab + mobile tile** (frames 0080-0150, 0410, 0455; supersedes master_memory deferred list).
- Right-rail dock: **NEW** Browser / Editor / Bridge tabs (frames 0080, 0340, 0410).
- Operator Console: **NEW** TERMINALS / CHAT / ACTIVITY tabs + ESCALATIONS / REVIEW / QUIET / ERRORS counters + constellation graph (frames 0250, 0265, 0295).
- Swarm Skills: **NEW** 12-tile toggleable behavior modifiers (frames 0210, 0220).
- Voice / BridgeVoice: **NEW** title-bar mic indicator + `voice:state` event (frame 0220; supersedes "voice out of scope" line in §15).
- Mobile companion: **NEW** 6-tile dashboard sketch — high-level only, full mobile spec out of scope for v1.0 (frame 0455).

| ID | Decision | Why |
|---|---|---|
| C-001 | Worktree branch pattern is `sigmalink/<role>/<task>-<8char>`. The 5-char suffix from `REBUILD_PLAN.md` is widened to 8 to remove the collision risk flagged in `02-bug-sweep.md` P1-WORKTREE-PATH-COLLISION. Keeps the `sigmalink/` namespace the rebuild plan picked. | Rebuild plan precedence + bug-sweep evidence. |
| C-002 | Workspace pane grid caps at **16**. Swarm rosters scale to **50**. The legacy MVP `CommandDock` parser cap of 12 is lifted to 16. | Marketing + rebuild plan agree at 16; swarm spec independently supports 50. |
| C-003 | The mailbox schema allows N coordinators (1..N). The "coordinator 10" line in the launch transcript is treated as a misheard token. | No code change; schema flexibility resolves it. |
| C-004 | Provider list ships **eleven** entries: claude, codex, gemini, kimi, cursor, opencode, droid, copilot, aider, continue, custom (shell). Drop the rebuild-plan position that excluded Continue; the legacy MVP already shipped it and the cost of keeping a config row is zero. Auto-detect any other provider found on PATH (Emdash style) but list only these eleven in the picker by default. | Maximises operator coverage without code changes. |
| C-005 | Per-role provider defaults: Coordinator → Codex, Builder → Claude, Scout → Gemini, Reviewer → Codex. Operator override per role at launch. | Speaker recommendation; matches transcript. |
| C-006 | Swarm sizing presets: **Squad (5)**, **Team (10)**, **Platoon (15)**, **Battalion (20)**, plus a **Custom** roster builder (cap 20). Workspace pane presets remain `1/2/4/6/8/10/12/14/16`. *(Updated by C-016 from V3 frames 0184/0185; Legion-50 dropped.)* | Two preset axes — pane grid and roster — are kept distinct. |
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

SigmaLink is a local-first, Electron + React desktop **agentic development environment** that lets a single human operator run a grid of CLI coding agents (BridgeCode, Claude Code, Codex, Gemini, OpenCode, Cursor, Droid, Copilot, plus a Custom Command — V3 9-provider matrix per §4) in real PTYs against a Git repository, isolating each agent in its own worktree, optionally coordinating those agents as a role-bearing swarm (Coordinator / Builder / Scout / Reviewer) over a deterministic file-system mailbox, with a Bridge Assistant orchestrator (right-rail tab + chat + tool-trace), a Bridge Canvas visual design tool (element-pick → per-prompt provider picker → live-DOM HMR poke), drag-and-drop Anthropic Skills loading, an embedded controllable browser, a 12-tool wikilink memory MCP server, and a SQLite-backed Kanban + review pipeline — all without cloud sync, accounts, or billing. It is for power users who already use one or more coding-agent CLIs and who want to orchestrate them on their own hardware. (Sources: `docs/02-research/REQUIREMENTS_MASTER.md`; `docs/02-research/v3-frame-by-frame.md`; V3 deltas under `docs/02-research/v3-*-delta.md`.)

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

- **When to use**: one mission, multiple agents that need to talk to each other. Hand-off long-running task with minimal intervention. (Source: `glossary.md` "Bridge Swarm"; `workflows.md` W2/W3; V3 frames 0184/0185.)
- **Who creates it**: operator, via Workspaces room → "+" → "Bridge Swarm".
- **Roster presets** (V3-locked per `v3-agent-roles-delta.md` §2; frames 0184/0185 chips):
  - **Squad 5** — 1 Coord / 2 Builders / 1 Scout / 1 Reviewer `[CONFIRMED]`.
  - **Team 10** — 2 Coord / 5 Builders / 2 Scouts / 1 Reviewer `[CONFIRMED]`.
  - **Platoon 15** — 2 Coord / 7 Builders / 3 Scouts / 3 Reviewers `[CONFIRMED]`.
  - **Battalion 20** — **3 Coord / 11 Builders / 3 Scouts / 3 Reviewers** `[INFERRED]` (chip visible 0185, never expanded; ratios extrapolated from Platoon).
  - **Custom 1..20** — operator picks each role count; cap dropped from 50 → 20. Existing > 20-agent swarms load read-only with `legacy: true` flag.
  - Legion-50 is **removed**; the `swarms.preset` CHECK constraint accepts `'battalion'` and rejects new `'legion'` writes (existing rows survive).
- **Contents**:
  - 1 swarm row (`swarms` table) holding mission, name, directory, supporting context.
  - N agent rows (`swarm_agents`) with role, provider, `autoApprove`, `coordinatorId` (frames 0205, 0250).
  - JSONL inboxes on disk at `<userData>/swarms/<swarmId>/inboxes/<agentId>.jsonl`. (Source: `REBUILD_PLAN.md` Phase 2.)
  - Optional supporting-context files copied to `<userData>/swarms/<swarmId>/brain/`.
  - Per-agent **board** namespace at `<userData>/swarms/<swarmId>/boards/<agentId>/<postId>.md` (V3 frame 0280; transcript L247).
- **Per-role colour tokens** (V3 frames 0185/0205/0250/0295): Coordinator blue `hsl(216 90% 60%)`, Builder violet `hsl(266 85% 65%)`, Scout green `hsl(150 75% 50%)`, Reviewer amber `hsl(40 90% 60%)`. Wired as `--role-coordinator/--role-builder/--role-scout/--role-reviewer` CSS vars in every theme block.
- **Persists**: `swarms`, `swarm_agents` (with `autoApprove`, `coordinatorId`), `swarm_messages` (with `resolvedAt`), `boards`, `swarm_skills`. Inboxes are rebuildable from `swarm_messages` after a crash.

### 2.3 Bridge Canvas (visual design tool — fully spec'd)

V3 demos this surface end-to-end across frames 0368-0405. Promoted from research-deferred to **first-class room** (C-016). Sources: `v3-frame-by-frame.md` Chapter C; `v3-protocol-delta.md` §4 (`design.*` RPC); `v3-delta-vs-current.md` §"Bridge Canvas".

- **When to use**: select an HTML element in the in-app browser preview, dispatch a prompt scoped to that element to one or more chosen providers, optionally drag an asset onto the selection. The agent edits the underlying source file; an HMR poke reflects the change live in the preview.
- **Who creates it**: operator, via Workspaces room → "+" → BridgeCanvas card (`⌘K`, `ALPHA` chip — frames 0020, 0180). Also auto-spawned when the operator clicks "Activate Design Tool" inside the Browser room of any other workspace.
- **Element-picker overlay** (frames 0368, 0369; RPC `design:start-pick / design:pick-result`):
  - Banner *"Click an element in the preview"* during pick mode.
  - DevTools-style hover highlight; click freezes selection.
  - Pick result carries `{ selector, outerHTML, computedStyles, screenshotPng }`.
- **Captured-element source paste** (frames 0368, 0380):
  - Left dock shows the captured selector (e.g. `[Design Mode • Claude — Selected: div.relative.w-full]`), the outerHTML snippet (collapsible), a screenshot thumbnail, and a "Paste source" button that injects the snippet into the prompt buffer.
- **Per-prompt provider picker** (frame 0380):
  - Four chips: **Claude · Codex · Gemini · OpenCode** (default Claude).
  - **Shift + Click** adds providers; **Alt + Click** removes. Multi-select fans the prompt out to one Builder pane per provider.
  - Selection persists per-canvas via `canvases.lastProviders`.
- **Drag-and-drop asset injection** (frames 0398, 0405; RPC `design:attach-file`):
  - HTML5 drop into the prompt buffer stages the file under `<userData>/canvases/<canvasId>/staging/<ulid>.<ext>`.
  - Absolute staging path is inserted into the prompt as a quoted string (matches V3 buffer `'/Users/.../bridgespace-v3.mp4'`).
- **Live-DOM HMR poke** (frame 0405; event `design:patch-applied`):
  - When an agent writes a file under the active dev server's source root, the browser tab posts a `location.reload()` if no HMR socket detected, otherwise nudges the dev server's HMR endpoint with a no-op WebSocket frame so the change repaints without a hard reload.
- **Persists**: `canvases (id, workspace_id, current_url, current_selector, asset_count, last_providers, created_at, updated_at)`. Each spawned builder writes to `agent_sessions` like a normal pane.

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

### 3.10 Bridge Assistant (full room spec — promoted from deferred per C-016)

V3 makes Bridge Assistant a **first-class right-rail tab** on desktop (frames 0080, 0090, 0100, 0150, 0410) and a **first-class tile** on the mobile dashboard (frame 0455). Same agent, two surfaces. Sources: `v3-frame-by-frame.md` Chapter A; `v3-protocol-delta.md` §3; `v3-delta-vs-current.md` §"Bridge Assistant".

- **Purpose**: in-app autonomous orchestration agent. Voice-or-text intake; bulk-spawns panes; per-pane prompt dispatch; resolves `@filename` references against the indexed codebase; auditable tool-call trace.
- **Surface**: lives in the right-rail dock (§3.12) under the **Bridge** tab. Also exposed as a full-room route at `assistant` for keyboard-only operation. The mobile companion (§3.13) renders the same conversation in tile form.
- **Orb state machine** (frames 0080, 0090): **STANDBY** (`Tap to activate`) → **LISTENING** (mic open; W15 wires real STT) → **RECEIVING** (text streaming back from assistant) → **THINKING** (tool-call in flight). State transitions broadcast via `assistant:state` event.
- **Chat transcript** (frames 0080, 0100, 0150): rounded-pill role labels `BRIDGE` (assistant) and `YOU` (operator). Assistant messages stream char-by-char.
- **Per-pane prompt-injection echo** (frame 0150; transcript L147-158): when the assistant dispatches `Implement {feature}` / `Find and fix a bug in @filename` / `Run /review on my current changes` / `Write tests for @filename` to a target pane, the pane footer shows the injected prompt as a faint ghost line until the agent picks it up.
- **Bulk spawn** (frame 0080-0100; transcript L82-96): one operator prompt → N panes via `assistant:dispatch-bulk { spec: { provider, count, initialPrompt? }[] }`. The walker example *"launch two more codex agents two more cloud code agents three open code agents"* spawns 7 panes in a single round-trip.
- **`@filename` resolution** (frame 0160; transcript L147-158): `assistant:ref-resolve { atRef }` walks the workspace index and returns `{ absPath, snippet }`. The token is replaced inline in the prompt before dispatch.
- **Tool-call inspector** (auditable trace): every tool call writes a `messages` row with `toolCallId` set; the chat panel renders an expandable card per call showing tool, args, response, and elapsed time. `assistant:tool-trace` event mirrors the stream for external auditors.
- **Cross-workspace Jump-to-pane** (transcript L122-137): completion of a dispatched prompt fires a sonner toast with a "Jump to pane" action; clicking switches workspaces and focuses the target session. A subtle "ding" sound plays (user-toggleable).
- **Workspace tools** (the assistant's MCP-style tool set; `[CHOSEN]` shapes):
  - `launch_pane(provider, count, initialPrompt?)`
  - `prompt_agent(sessionId, text)` *(per-pane dispatch)*
  - `dispatch_bulk(spec[])` *(maps to `assistant:dispatch-bulk`)*
  - `ref_resolve(atRef)` *(maps to `assistant:ref-resolve`)*
  - `read_files(globs)`
  - `open_url(url)`
  - `create_task(title, description, successCriteria, assignee?)`
  - `create_swarm(name, mission, roster)`
  - `create_memory(title, body, tags?)`
  - `search_memories(query)`
  - `broadcast_to_swarm(swarmId, text)`
  - `roll_call(swarmId)`
- **Provider**: configurable; defaults to Claude (opus tier if available) `[CHOSEN]`.
- **Data shape**: `Conversation { id, workspaceId, kind: 'assistant', createdAt }`, `Message { id, conversationId, role: 'user'|'assistant'|'tool', content, toolCallId?, createdAt }`.
- **Persistence**: `conversations`, `messages`.
- **RPC namespace** (NEW; `v3-protocol-delta.md` §3): `assistant:listen`, `assistant:state` (event), `assistant:dispatch-pane`, `assistant:dispatch-bulk`, `assistant:ref-resolve`, `assistant:turn-cancel`, `assistant:tool-trace` (event). Distinct from the swarm mailbox: a Bridge dispatch lands in the target pane's PTY stdin (or as `agent_sessions.pendingPrompt`), not in `swarm_messages`.

### 3.11 Command Palette (overlay; not a route)

- **Purpose**: Cmd/Ctrl+K fuzzy search across all actions, rooms, recent workspaces, providers, skills, tasks, memory notes.
- **Affordances**: shadcn `Command` dialog with grouped results.
- **Data shape**: in-memory only.
- **Persistence**: none. Recent searches cached in localStorage `sigmalink.paletteRecent`.

### 3.12 Right-rail dock — Browser / Editor / Bridge tabs (NEW per C-016)

V3 docks three persistent tools to the right of the active workspace (frames 0080, 0340, 0410, 0420, 0430). Sources: `v3-frame-by-frame.md` Chapter B/C; `v3-delta-vs-current.md` §"Browser + Editor + Bridge dock".

- **Purpose**: keep the tools an operator alternates between (web reference, code reading, AI orchestrator) one click away without losing terminal grid state.
- **Tab strip**: three tabs always present: **Browser · Editor · Bridge**. Per-tab state persists across switches.
- **Resizable splitter**: vertical split between the workspace body and the dock. Width persisted in `kv['rightRail.width']`. Min 280 px, max 50 % of window.
- **Browser tab** (frames 0340, 0355): hosts the Browser room (§3.6) plus a **recents panel** showing the last 10 distinct origins. Click on a link inside any agent pane (PTY OSC8 hyperlink or auto-detected URL) opens it here, not in the OS browser (transcript L209).
- **Editor tab** (frames 0420, 0430; transcript L380-403): file tree rooted at the active workspace + Monaco/CodeMirror with TS/JSX syntax highlighting and line numbers. Click-on-path in any chat or pane footer focuses the file in this tab.
- **Bridge tab** (frames 0080, 0090, 0100, 0150, 0410): mounts the Bridge Assistant chat panel + orb (§3.10).
- **Data shape**: in-memory only; per-tab persistence handled by underlying rooms.

### 3.13 Mobile companion — 6-tile dashboard (NEW per C-016; v1.0 high-level only)

V3 frame 0455 shows a mobile dashboard with **six tiles**: Terminal · Kanban · Workspace · Swarm · **Canvas** · **Bridge**. Walker C confirms `Plan Pro · ACTIVE · Renews 2/11/2026` chrome.

- **Scope for v1.0**: protocol surfaces + RPC compatibility only. Full mobile shell (auth, push, native UI) is **out of scope for v1.0**; tracked for post-1.0.
- **Tiles** (mapping to existing rooms):
  - **Terminal** → §3.2 Command room (read-only mirror; no PTY input on mobile v1).
  - **Kanban** → §3.8 Tasks room.
  - **Workspace** → §3.1 Workspaces room (recent list + open).
  - **Swarm** → §3.3 Swarm room + §11.1 Operator Console.
  - **Canvas** → §2.3 Bridge Canvas (read-only previewer of dispatched prompts + thumbnails).
  - **Bridge** → §3.10 Bridge Assistant (chat-only; full tool-trace inspection deferred).
- **Connection**: mobile companion connects to a desktop instance over LAN; pairing flow + transport TBD.

---

## 4. Agent providers (canonical list — v1.2.4 5-provider matrix)

> **Updated 2026-05-13 (v1.2.4 provider-registry cleanup).** The previous V3 9-provider matrix (which included BridgeCode, Cursor, Droid, Copilot, and the demoted Kimi-as-model) is **superseded** by this 5-provider matrix. BridgeCode never materialised, Cursor's CLI fell out of scope, Droid + Copilot stubs were never implemented, Aider + Continue were removed entirely, and Kimi was promoted back to a first-class CLI provider with its own registry row. See `docs/08-bugs/BACKLOG.md` → "v1.1.10 — provider registry cleanup → Shipped & verified — v1.2.4". Sections 4.1–4.5 below are kept for historical context but no longer reflect the shipping registry.

### 4.0 v1.2.4 shipping registry (current source of truth)

| Provider | id | command | install hint |
|---|---|---|---|
| Claude Code | `claude` | `claude` (alt `claude.cmd`) | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `codex` | `codex` (alt `codex.cmd`) | `npm i -g @openai/codex` |
| Gemini CLI | `gemini` | `gemini` (alt `gemini.cmd`) | `npm i -g @google/gemini-cli` |
| Kimi Code CLI | `kimi` | `kimi` (alt `kimi.cmd`) | See moonshot.ai (npm package name pending) |
| OpenCode CLI | `opencode` | `opencode` (alt `opencode.cmd`) | `npm i -g opencode` |

An internal-only `'shell'` sentinel powers the workspace launcher's "Skip — no agents" / "Custom Command" rows by routing through `defaultShell()` in `local-pty.ts`. It is filtered out of every user-facing picker.

---

> The remainder of section 4 (4.1–4.5) is preserved for historical context only — it describes the V3 9-provider matrix that v1.2.4 obsoleted.

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
  installHint?: string;
  color: string;
  icon: string;
  description: string;
  recommendedRoles?: Role[];
  comingSoon?: boolean;             // NEW (V3): renders the chip as "Coming Soon"
  fallbackProviderId?: ProviderId;  // NEW (V3): silent fallback when binary missing
}
```

Per-provider model options live in a sibling registry:
```
ModelOption { providerId, modelId, label, via?: 'openrouter'|'native', defaultEffort? }
```

### 4.1 Default 9-provider registry (wizard order)

| id | command | install hint | resume / oneshot | recommended roles |
|---|---|---|---|---|
| **bridgecode** *(NEW; `comingSoon: true`, fallback `claude`)* | `bridgecode` (alt `bridgecode.cmd`) | (Coming Soon — falls back to Claude) | `--resume` / `-p {prompt}` | Builder, Coordinator |
| claude | `claude` (alt `claude.cmd`) | `npm i -g @anthropic-ai/claude-code` | `--resume` / `-p {prompt}` | Builder, Reviewer, Assistant default |
| codex | `codex` (alt `codex.cmd`) | `npm i -g @openai/codex` | `--resume` / `-q {prompt}` | Coordinator, Reviewer |
| gemini | `gemini` (alt `gemini.cmd`) | `npm i -g @google/gemini-cli` | `--resume` / `--prompt {prompt}` | Scout |
| opencode | `opencode` (alt `opencode.cmd`) | `npm i -g opencode` | `--resume` / `--prompt {prompt}` | Builder |
| cursor | `cursor-agent` (alt `cursor-agent.cmd`) | install via Cursor app | `--resume` / `--prompt {prompt}` | Builder |
| droid | `droid` (alt `droid.cmd`) | `npm i -g @factory-ai/droid` | `--resume` / `--prompt {prompt}` | Builder |
| copilot | `gh copilot` | `gh extension install github/gh-copilot` | n/a / `suggest -t {prompt}` | Reviewer, Scout |
| custom | (operator-supplied; UI label "Custom Command") | n/a | n/a | any |

### 4.2 Demoted: Kimi as a model option (not a top-level provider)

Frame 0100/0140 shows OpenCode booted with `Build · Kimi K2.6 OpenRouter`. Kimi is a **model selection under OpenCode** (and any OpenRouter-capable provider), not a standalone provider row. Lives in `src/main/core/providers/models.ts` as `ModelOption { providerId: 'opencode', modelId: 'kimi-k2.6', label: 'Kimi K2.6', via: 'openrouter' }`.

### 4.3 Hidden behind Settings: Aider + Continue

Aider and Continue are **not visible** in V3's default UI. They remain in the codebase and ship as off-by-default rows under `Settings → Providers → Show legacy providers` (kv key `providers.showLegacy`). Their probes still run; they simply aren't surfaced in the default picker. This supersedes original C-004 by way of C-016.

### 4.4 Per-pane chrome variants

Per-pane top-bar renders provider-specific splash + status (frames 0045, 0070, 0100, 0140):
- **Claude** → `Claude Code v2.1.116 · Opus 4.7 (1M) · Claude Max`.
- **Codex** → `OpenAI Codex (v0.121.0) · gpt-5.4 high fast · directory: ~/Desktop/<repo>`.
- **OpenCode** → giant ASCII logo + `Build · <model> <via>` chip (e.g. `Build · Kimi K2.6 OpenRouter`).
Mid-strip prompt-bar formats `<model> <effort> <speed> · <cwd>` for any (provider, model) combo. Footer hints rotate `auto mode on (shift+tab)` / `bypass permissions on` based on agent state.

### 4.5 Wizard quick-fills + Custom Command row (frame 0055)

Wizard provider matrix renders three quick-fill macros — *Enable all · One of each · Split evenly* — at the top, and a **Custom Command** row + `+ Add custom command` button at the bottom. *One of each* skips any provider with `comingSoon === true` (so BridgeCode is excluded until the binary ships).

Sources: `v3-providers-delta.md`; `v3-frame-by-frame.md` 0055/0184/0205/0380/0510.

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
- `swarms.updateAgent(swarmAgentId, patch)` → `SwarmAgent` *(NEW V3 — `autoApprove`, per-row provider override)*

### swarm:* (Operator Console — NEW, V3 per `v3-protocol-delta.md` §5)
- `swarm:console-tab { swarmId, tab: 'terminals'|'chat'|'activity' }` → `void`
- `swarm:stop-all { swarmId, reason }` → `{ stopped: number }`
- `swarm:counters` (event) → `{ escalations, review, quiet, errors }`
- `swarm:constellation-layout { swarmId, nodePositions }` → `void`
- `swarm:agent-filter { swarmId, filter: 'all'|'coordinators'|'builders'|'scouts'|'reviewers' }` → `void`
- `swarm:ledger` (event) → `{ agentsTotal, messagesTotal, elapsedMs }`
- `swarm:mission-rename { swarmId, mission }` → `void`

### assistant.* (NEW, V3 per `v3-protocol-delta.md` §3)
- `assistant.listen { workspaceId }` → `{ conversationId }`
- `assistant.state` (event) → `{ orb: 'standby'|'listening'|'receiving'|'thinking' }`
- `assistant.dispatch-pane { workspaceId, targetSessionId, prompt, attachments? }` → `void`
- `assistant.dispatch-bulk { workspaceId, spec: { provider, count, initialPrompt? }[] }` → `{ sessions: SessionSummary[] }`
- `assistant.ref-resolve { workspaceId, atRef }` → `{ absPath, snippet }`
- `assistant.turn-cancel { conversationId, turnId }` → `void`
- `assistant.tool-trace` (event) → `{ toolCallId, tool, args, result?, elapsedMs }`

### design.* (NEW, V3 per `v3-protocol-delta.md` §4)
- `design.start-pick { tabId }` → `{ pickerToken }`
- `design.pick-result` (event) → `{ pickerToken, selector, outerHTML, computedStyles, screenshotPng }`
- `design.dispatch { pickerToken, prompt, providers, modifiers: { shift?, alt? }, attachments? }` → `{ sessions: SessionSummary[] }`
- `design.attach-file { pickerToken, path }` → `{ stagingPath }`
- `design.patch-applied` (event) → `{ tabId, file, range }`

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
- `swarm:counters { swarmId, escalations, review, quiet, errors }` *(NEW V3)*
- `swarm:ledger { swarmId, agentsTotal, messagesTotal, elapsedMs }` *(NEW V3)*
- `assistant:state { conversationId, orb }` *(NEW V3)*
- `assistant:tool-trace { conversationId, toolCallId, tool, args, result?, elapsedMs }` *(NEW V3)*
- `design:pick-result { pickerToken, selector, outerHTML, computedStyles, screenshotPng }` *(NEW V3)*
- `design:patch-applied { tabId, file, range }` *(NEW V3)*
- `voice:state { active, source: 'mission'|'assistant'|'palette' }` *(NEW V3)*
- `tasks:changed { workspaceId }`
- `skills:changed`
- `browser:driving { tabId, isDriving }`
- `memory:changed { id }`
- `review:changed { id }`
- `providers:changed`

Total RPC methods: ~95 across 17 namespaces (was ~75 / 13 pre-V3).

---

## 11.1 Operator Console (under Swarm — NEW V3 per `v3-protocol-delta.md` §5)

V3 frame 0250 introduces the **Operator Console** as the canonical control surface for an active Bridge Swarm. Sources: `v3-frame-by-frame.md` Chapter B (0250-0325); `v3-delta-vs-current.md` §"Swarm".

- **Top-bar tabs** (frames 0250, 0265, 0295): three tabs **TERMINALS · CHAT · ACTIVITY**. Each carries an unread badge; CHAT shows count of unseen `swarm_messages` since last visit (frame 0265 *"8 unread"*). A **STOP ALL** red pill (frame 0295) terminates every PTY in the swarm via `swarm:stop-all { reason }`. A mission chip shows the active mission name and supports inline rename via `swarm:mission-rename`.
- **Counters bar** (frame 0295): four numeric badges **ESCALATIONS · REVIEW · QUIET · ERRORS**. Each is a live count over `swarm_messages` filtered by kind ∈ {`escalation`, `review_request`, `quiet_tick`, `error_report`} AND `resolvedAt IS NULL`. Updates stream via `swarm:counters` event.
- **Group filter chips** (frame 0295): `All Agents · COORDINATORS · BUILDERS · REVIEWERS · SCOUTS`. Filter scopes both the chat tail and the constellation graph (`swarm:agent-filter`).
- **Constellation graph** (frames 0250, 0295): hand-rolled canvas hub-and-spoke topology. Single-coordinator presets (Squad) draw one hub at centre with all workers as spokes. Multi-coordinator presets (Team / Platoon / Battalion) render multi-hub: each coordinator owns a subset of workers via `swarm_agents.coordinatorId`; glow lines only between a coordinator and its assignees. Drag-to-pan canvas (frame 0295 *"DRAG CANVAS"*); scroll-to-zoom; positions persist via `swarm:constellation-layout`.
- **Activity feed sidebar** (frame 0250): right rail per-agent timeline of status / completion / escalation / `board_post` envelopes. Filter chips reuse the group filter.
- **Bottom-bar ledger** (frame 0295): live tally `<N> agents · <M> messages · <T> elapsed`, streamed via `swarm:ledger`.
- **Composer** (frames 0250, 0265, 0310): recipient chip supports `@all`, `@coordinators`, `@builders`, `@scouts`, `@reviewers`, plus per-agent ids. Per-message status pills render via 3-letter codes (`MSG/ACK/DONE/ESCALATE/INFO/BSC/SUE/BTU`) with role-coloured backgrounds.
- **Coordinator structured task brief** (frame 0265): when a coordinator emits a `task_brief` envelope, the chat bubble renders an `URGENT` chip (red) when `urgency === 'urgent'`, headings bolded, sub-bullets indented, links live. Schema in `v3-protocol-delta.md` §1.
- **Operator → agent DM echo** (frame 0325; transcript L296-301): when the operator messages an individual agent with `directive.echo === 'pane'`, the target PTY receives `[Operator → <Role> <N>] <body>\n` on stdin in addition to the durable mailbox write.
- **Per-agent board namespace** (frame 0280; transcript L247): each agent has its own board at `<userData>/swarms/<swarmId>/boards/<agentId>/<postId>.md` (mirrored in DB table `boards`). Used for long-form notes that don't belong in chat.

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

## 13. Voice / BridgeVoice (NEW per C-016)

V3 ships voice intake as a cross-app primitive (frames 0220, 0235; transcript L86-96, L190). Source: `v3-protocol-delta.md` §6. Supersedes the original "voice out of scope" line in §17 (was §15).

- **Title-bar pill**: a centred **`BridgeVoice`** pill appears in the title bar **whenever any capture is active**, regardless of which surface initiated it (frame 0220). Disappears on capture end.
- **Global event**: `voice:state` `{ active: boolean, source: 'mission'|'assistant'|'palette' }`. Exactly one capture session is active across the app at a time; opening a new source automatically tears down the previous one.
- **OS speech adapter**: one shared adapter (macOS Speech Recognizer / Windows SAPI / Linux PocketSphinx fallback). No second capture session is ever opened.
- **Intake surfaces**:
  - **Mission textarea** (frame 0235): mic icon on the swarm wizard's mission step; streamed transcription drops into the textarea verbatim. Cmd+Enter submits.
  - **Bridge orb** (frames 0080, 0090; transcript L86-96): tapping the orb in STANDBY enters LISTENING and transcribes into the Bridge Assistant `assistant.listen` conversation.
  - **Command Palette** (transcript L190): `Cmd+Shift+K` voice-mode toggle in the palette transcribes into the search field.
- **Out-of-scope for v1.0**: BridgeJarvis-style wake word (transcript L472-475); BridgeVoice as a separate desktop sibling app (frame 0520). The pill + `voice:state` ship; the standalone app does not.

---

## 14. Swarm Skills (NEW per C-016)

V3 frames 0210/0220 show a **12-tile grid** of toggleable behavior modifiers shown during the BridgeSwarm wizard's mission step. Source: `v3-frame-by-frame.md` Chapter B (0210-0220); `v3-protocol-delta.md` §1 (`skill_toggle` envelope).

- **Purpose**: each tile, when ON, injects an instruction into the coordinator's system prompt that biases the swarm's behaviour without changing the mission. Distinct from §7 Anthropic Skills: those are operator-installed prompt assets; Swarm Skills are built-in coordinator-prompt modifiers.
- **Layout**: 3 × 4 grid grouped into four bands.
- **Tiles** (verbatim from frame 0220):
  - **Workflow** — `Incremental Commits`, `Refactor Only`, `Monorepo Aware`.
  - **Quality** — `Test-Driven`, `Code Review`, `Documentation`, `Security Audit`, `DRY`, `Accessibility`.
  - **Ops** — `Keep CI Green`, `Migration Safe`.
  - **Analysis** — `Performance`.
- **Interaction**: each tile shows an on/off pill + label. Toggling persists to a new `swarm_skills (swarmId, skillKey, on, group)` table and fires a `skill_toggle` envelope into the mailbox so the coordinator picks up the new state on next prompt assembly.
- **Persistence**: `swarm_skills` table; default off for all 12 on a fresh swarm.

---

## 15. Keyboard shortcuts

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

## 16. Pricing tiers

SigmaLink is open-source (MIT) and local-only. Every feature in this spec is free in our clone. There is no Basic/Pro/Ultra split. There are no credits, no metering, no accounts, no billing surface. The Settings room hides all pricing-related UI.

For forward-compat only, a `Capability` enum (`src/main/core/plan/capabilities.ts`) exposes a `canDo(cap): boolean` helper consulted by gated UIs; default tier `'ultra'` means every capability is unlocked. QA can override via `kv['plan.tier']`.

---

## 17. Out of scope (explicit, with rationale)

| feature | rationale |
|---|---|
| SSH remote development UI | Touches network/auth; out of scope per `REBUILD_PLAN.md`; the provider abstraction keeps a transport seam. |
| BridgeJarvis wake-word | Always-on STT raises vendor + privacy cost; OS dictation already covers explicit-trigger cases. *(BridgeVoice intake itself is in-scope per §13.)* |
| BridgeVoice as a standalone sibling app (frame 0520) | The intake pill ships in-app; a separate STT-only product is independent scope. |
| Ticket integrations (Linear / Jira / GitHub Issues) | OAuth + cloud writes; conflicts with local-first stance. |
| Cloud sync of workspaces/memory | Would require accounts and a server; out of scope. |
| Full mobile companion app (auth, push, native UI) | Tracked for post-1.0 per §3.13; v1 ships RPC compatibility seams only. |
| Account creation, billing, credit metering | The clone is free. |
| Telemetry by default | We respect `[CHOSEN]` an explicit opt-in; default off. |
| BridgeBench-style benchmark runner | Independent product, separate scope. |
| Plugin marketplace (`@bridgemind-plugins` style) | Skills are loaded from disk; we do not host a marketplace. |
| Auto-update server | Use OS package managers for now; ship a static installer. |
| Bug-bounty program | Operational, not a product feature. |

---

## Status note

After the V3 scope freeze (Wave 11.5; C-016), SigmaLink targets the V3 surface set: 9-provider matrix with BridgeCode (`comingSoon`), three workspace types (Bridge Space, **Bridge Swarm**, **Bridge Canvas — promoted to first-class**), Command room with multi-pane grid + per-pane chrome variants, Swarm room with the file-mailbox bus + V3 Operator Console (TERMINALS/CHAT/ACTIVITY tabs, ESCALATIONS/REVIEW/QUIET/ERRORS counters, constellation graph, Swarm Skills, structured task briefs, board namespaces, operator → pane echo), Review room with diff viewer + command runner + commit/merge, Memory room with 12-tool MCP server and force-directed graph, Browser room with controllable WebContentsView, Skills drag-and-drop ingest with three-target fan-out, Tasks Kanban with file-ownership locks, **Bridge Assistant first-class right-rail tab + mobile tile** (chat, orb state machine, bulk-spawn, per-pane dispatch, `@filename` resolve, tool-trace), **right-rail Browser/Editor/Bridge dock**, **BridgeVoice intake**, Command Palette overlay, Settings with 4 themes (V3 still 4-day-one per UX critique), per-agent Git worktree isolation, per-workspace CDP endpoint, full keyboard binding table, and the shared spawn-resolution helper. Roster preset reset to **Squad 5 / Team 10 / Platoon 15 / Battalion 20**. RPC surface: **~95 methods across 17 namespaces** (was 75/13 pre-V3). Persistence: **26 base tables** + 3 V3 additions (`boards`, `swarm_skills`, plus `swarm_messages.resolvedAt` column) + the `kv` settings store + `migrations` ledger. Execution backlog at `docs/03-plan/V3_PARITY_BACKLOG.md`.
