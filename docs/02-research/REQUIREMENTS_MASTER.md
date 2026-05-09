# Requirements Master

The union of every requirement, feature, role, file, mailbox protocol, MCP tool, skill behavior, and browser feature mentioned across all source documents. Grouped by topic. Marker legend:

- **`[CONFIRMED]`** — appears in BridgeMind official launch video transcript or video description (BridgeSpace official marketing).
- **`[INFERRED]`** — our own design call from the rebuild plan or research report (no direct BridgeMind source).
- **`[OPEN]`** — open question; conflicting or unspecified.

Citations follow each item.

---

## Workspaces

- `[CONFIRMED]` Operator picks a project directory before launching. `[video_transcript.txt §"BridgeSpace workspace demo"]`
- `[CONFIRMED]` Operator picks the count of agent terminal sessions to launch. `[video_transcript.txt §"BridgeSpace workspace demo"]`
- `[CONFIRMED]` Workspace can launch up to **16 simultaneous agent terminal sessions**, mixing Claude, Codex, and Gemini. `[video_transcript.txt §"BridgeSpace workspace demo"]`, `[docs/02-research/transcripts/launch-video-description.txt]`, `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`
- `[CONFIRMED]` Operator selects which agents (provider per pane) at launch time. Demo example mixed two Codex, one Gemini, one Cursor. `[video_transcript.txt §"BridgeSpace workspace demo"]`
- `[CONFIRMED]` "Workspace" is one of the two core products: BridgeSpace = isolated agents, BridgeSwarm = coordinating swarm. `[video_transcript.txt §"BridgeSwarm demo"]`
- `[INFERRED]` Workspace launcher offers preset pane counts `1 / 2 / 4 / 6 / 8 / 10 / 12 / 14 / 16`. `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` Provider per pane assigned individually in the launcher UI. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` Workspace metadata persisted in SQLite tables: workspaces, projects. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` Saved workspaces appear in sidebar; up to 12 saved at a time; localStorage key `sigmalink.savedWorkspaces`. `[app/src/_legacy/sections/Sidebar.tsx]`
- `[INFERRED]` Workspace shape: `{ id, name, path, repoRoot }`. `[app/src/_legacy/sections/Sidebar.tsx]`
- `[INFERRED]` Three rooms: Command Room (terminals), Swarm Room (parallel agents), Review Room (oversight). `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`, `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Additional rooms in the rebuild: Memory, Browser. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Per-agent isolated Git worktrees stored under Electron user data. `[app/README.md §"What is working now"]`
- `[INFERRED]` Auto-cleanup prunes merged worktrees on app start. `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Branch naming pattern: `sigmalink/<role>/<task>-<5char>` (rebuild plan) or `orchestrator/{agent-type}/{task-id}` (research blueprint). `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`, `[research_extracted.txt §"Architecture Blueprint / Worktree Manager"]`
- `[INFERRED]` Per-worktree port allocation prevents conflicts; env-var injection per provider API keys. `[research_extracted.txt §"Architecture Blueprint / Worktree Manager"]`
- `[INFERRED]` Direct-folder fallback when path is not a Git repo: terminals run, worktree/diff/merge disabled. `[app/README.md §"Important notes"]`

### Workspace launcher UI specifics
- `[INFERRED]` Layout modes in Command Room: `mosaic`, `columns`, `focus`. `[app/src/_legacy/sections/CommandRoom.tsx]`
- `[INFERRED]` Density modes: `compact`, `balanced`, `expanded`. `[app/src/_legacy/sections/CommandRoom.tsx]`
- `[INFERRED]` Compact: minWidth 260 / minHeight 240. Balanced: 320 / 300. Expanded: 400 / 360. `[app/src/_legacy/sections/CommandRoom.tsx]`
- `[INFERRED]` Columns mode picks 1/2/3 columns by terminal count. `[app/src/_legacy/sections/CommandRoom.tsx]`

---

## Swarms

### Roles & roster
- `[CONFIRMED]` Four agent role types: **Coordinator, Builder, Scout, Reviewer**. `[video_transcript.txt §"Live swarm demo"]`, `[docs/02-research/transcripts/launch-video-description.txt]`
- `[CONFIRMED]` Demo swarm composition: 2 coordinators, 5 builders, 1 reviewer, 2 scouts. `[video_transcript.txt §"Live swarm demo"]`
- `[CONFIRMED]` Roster preset selector ranges between 5 agents and 50 agents. `[video_transcript.txt §"BridgeSwarm demo"]`
- `[CONFIRMED]` Per-role provider mapping is operator-configurable. Speaker's defaults:
  - Coordinators → Codex.
  - Builders → Claude.
  - Scouts → Gemini.
  - Reviewers → Codex. `[video_transcript.txt §"BridgeSwarm demo"]`
- `[CONFIRMED]` Click "launch swarm" launches the configured swarm. `[video_transcript.txt §"BridgeSwarm demo"]`
- `[CONFIRMED]` BridgeSwarm differs from BridgeSpace: BridgeSpace = isolated agents; BridgeSwarm = coordinating swarm. `[video_transcript.txt §"BridgeSwarm demo"]`

### Swarm communication
- `[CONFIRMED]` Agent-to-agent messages visible in a side-chat panel. `[video_transcript.txt §"Live swarm demo"]`, `[video_transcript.txt §"BridgeSwarm demo"]`
- `[CONFIRMED]` Operator can directly message a single agent (e.g., "I just messaged coordinator 1"). `[video_transcript.txt §"Live swarm demo"]`
- `[CONFIRMED]` Roll-call: operator asks coordinator → coordinator broadcasts to all agents → each replies with status → coordinator returns final answer. `[video_transcript.txt §"Live swarm demo"]`
- `[CONFIRMED]` Live coordination chat panel on the right side during a swarm run. `[video_transcript.txt §"BridgeSwarm demo"]`
- `[CONFIRMED]` Agents can ask the operator questions back (demo: "builder 2 asks the operator, 'How are you feeling?'"). `[video_transcript.txt §"BridgeSwarm demo"]`
- `[CONFIRMED]` BridgeSwarm is positioned for hand-off of long-running difficult tasks with minimal intervention. `[video_transcript.txt §"BridgeSwarm demo"]`, `[docs/02-research/transcripts/launch-video-description.txt]`

### Swarm prompt + knowledge upload
- `[CONFIRMED]` The swarm receives a free-text prompt at creation time. Demo: "identify any security vulnerabilities and fix them." `[video_transcript.txt §"BridgeSwarm demo"]`
- `[CONFIRMED]` Operator can upload PDFs, images, or arbitrary files into the "swarm's brain" as supporting knowledge. `[video_transcript.txt §"BridgeSwarm demo"]`

### Mailbox protocol (rebuild)
- `[INFERRED]` Mailbox is a file-system protocol, independently designed. `[REBUILD_PLAN.md §"Legal/IP guardrails"]`
- `[INFERRED]` Mailbox path: `<userData>/swarms/<swarmId>/inboxes/<agentId>.jsonl`. `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- `[INFERRED]` Operator broadcast tool writes a special envelope to all inboxes. `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- `[INFERRED]` Roll-call protocol: Coordinator polls Builders for status. `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- `[INFERRED]` Side-chat panel tails the mailbox live. `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- `[INFERRED]` Swarm state persisted in SQLite. `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- `[INFERRED]` Mailbox message schema lives in `src/shared/swarm.ts`. `[REBUILD_PLAN.md §"Architecture (target)"]`

### Orchestrator engine (rebuild)
- `[INFERRED]` Orchestrator decomposes high-level tasks into sub-tasks for parallel execution. `[research_extracted.txt §"BridgeSpace Feature Analysis / Key Differentiators"]`
- `[INFERRED]` Hierarchical delegation: Orchestrator → Sub-Agents → Workers. `[research_extracted.txt §"Architecture Blueprint / Orchestrator Engine"]`
- `[INFERRED]` Verification loop: Execute → Verify → Retry on failure (Bernstein pattern). `[research_extracted.txt §"The Orchestrator Layer"]`
- `[INFERRED]` Delegation contract fields: `intent`, `inputs`, `constraints`, `success_criteria`, `assigned_agent`. `[research_extracted.txt §"The Orchestrator Layer"]`
- `[INFERRED]` Deterministic scheduling targeted to spend zero LLM tokens on coordination. `[research_extracted.txt §"Architecture Blueprint / Orchestrator Engine"]`
- `[INFERRED]` MCP-driven shared memory used for orchestrator context. `[research_extracted.txt §"Architecture Blueprint / Orchestrator Engine"]`
- `[INFERRED]` Subtask form fields used by current MVP UI: `title`, `description`, `assignedProvider`, `intent`. Default success criteria: "Code compiles and tests pass". `[app/src/_legacy/sections/SwarmRoom.tsx]`

### Swarm room UI (rebuild)
- `[INFERRED]` Swarm Room features in rebuild: roster setup, side-chat, mailbox view, broadcast control. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Swarm Room (current MVP) is two-pane (task creation / current tasks), labelled "Orchestrator", subtitle "Delegate tasks to multiple AI agents in parallel". `[app/src/_legacy/sections/SwarmRoom.tsx]`

---

## Agents / Providers

### Provider list
- `[CONFIRMED]` Claude Code, Codex, Gemini supported in BridgeSpace launch video. `[video_transcript.txt §"BridgeSpace workspace demo"]`
- `[CONFIRMED]` Cursor agent shown in demo agent mix. `[video_transcript.txt §"BridgeSpace workspace demo"]`
- `[INFERRED]` Target rebuild provider set: Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Aider, Custom. `[REBUILD_PLAN.md §"North Star"]`
- `[INFERRED]` Current MVP provider registry: Claude Code, OpenAI Codex, Gemini CLI, Kimi CLI, Continue, Custom CLI. `[app/README.md §"What is working now"]`, `[app/src/_legacy/lib/providers.ts]`
- `[INFERRED]` Emdash auto-detects 20+ providers including Claude Code, Codex, Gemini CLI, OpenCode, Amp, Droid (Factory CLI), Hermes Agent, Qwen Code, Cursor CLI, GitHub Copilot CLI, Aider. `[research_extracted.txt §"Tier 1: Emdash"]`
- `[INFERRED]` Bernstein supports 30+ CLI agents. `[research_extracted.txt §"Tier 4: Bernstein"]`
- `[OPEN]` Final shipping provider list and order in v1 — at minimum the rebuild plan's eight; whether Continue, Amp, Droid, Hermes, Qwen, GitHub Copilot CLI ship is undecided.

### Provider abstraction
- `[INFERRED]` Provider definition shape: `id`, `name`, `command`, `args`, `resumeArgs`, `oneshotArgs`, `installHint`, `color`, `icon`, `description`. `[app/src/_legacy/lib/providers.ts]`
- `[INFERRED]` Research blueprint version: `command`, `args`, `resume_args`, `oneshot_args`, `install_hint`. `[research_extracted.txt §"Multi-Provider Agent Abstraction"]`
- `[INFERRED]` Provider registry is config-driven (TOML/JSON), not hardcoded; adding a provider needs only an entry. `[research_extracted.txt §"Architecture Blueprint / Agent Provider Abstraction"]`, `[research_extracted.txt §"Conclusions / Key Success Factors"]`
- `[INFERRED]` Auto-detect via PATH scan; PATH/version probe at launch. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`, `[research_extracted.txt §"Architecture Blueprint / Agent Provider Abstraction"]`
- `[INFERRED]` Specific install hints (current MVP):
  - Claude: `npm install -g @anthropic-ai/claude-code`.
  - Codex: `npm install -g @openai/codex`.
  - Gemini: `npm install -g @google/gemini-cli`.
  - Kimi: PATH-based, no npm.
  - Continue: `npm install -g @continuedev/cli`. `[app/src/_legacy/lib/providers.ts]`
- `[INFERRED]` Specific oneshot patterns (current MVP):
  - Claude: `-p {prompt}`. Codex: `-q {prompt}`. Gemini: `--prompt {prompt}`. Kimi: `--prompt {prompt}`. `[app/src/_legacy/lib/providers.ts]`

---

## Browser

- `[INFERRED]` In-app browser pane is a first-class room. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Implementation: Electron `WebContentsView`. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Features: address bar, back/forward, tabs. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Per-workspace CDP endpoint exposed. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Per-workspace Playwright MCP supervisor: `npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<port>`. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Each agent's `.mcp.json` points to the shared Playwright MCP HTTP port — agents drive the visible in-app browser. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` UI shows an "agent-drive indicator" when an agent is controlling the browser. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Browser dock tab in the current MVP `CommandDock` defaults to `https://openai.com`. `[app/src/_legacy/sections/CommandDock.tsx]`
- `[OPEN]` Whether the browser pane has any presence in BridgeMind's BridgeSpace product (no mention in transcript / description) — design decision is wholly ours.

---

## Skills

- `[INFERRED]` Drag-and-drop Skills loader using **Anthropic Skills format** (SKILL.md). `[REBUILD_PLAN.md §"North Star"]`, `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Drop zone uses HTML5 drag, `webkitGetAsEntry`, and Electron `webUtils.getPathForFile`. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` SKILL.md frontmatter validated with Zod (schema in `src/shared/skills.ts`). `[REBUILD_PLAN.md §"Phase 3"]`, `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Storage canonical: `<userData>/skills/<id>/`. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Fan-out targets:
  - Claude: `~/.claude/skills/<id>/`.
  - Codex: `~/.codex/skills/<id>/` (copy/translate).
  - Gemini: `~/.gemini/extensions/<id>/` (synthesize). `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Skills feature includes a library UI, drop zone, install/remove. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Skills table is part of the first SQLite migration. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[OPEN]` BridgeSpace's official position on Anthropic Skills is not stated in any source. Skills support is our addition.

---

## Memory (BridgeMemory equivalent)

- `[CONFIRMED]` BridgeSpace has BridgeMemory: local-first knowledge graph with **12 MCP tools** for shared agent memory. `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`
- `[CONFIRMED]` Wikilink-based knowledge graph; supports orchestrator shared context. `[research_extracted.txt §"BridgeSpace Feature Analysis / Key Differentiators"]`
- `[INFERRED]` Our SigmaMemory MCP server runs in-process over stdio. `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` SigmaMemory exposes 12 tools: `create_memory`, `search_memories`, `find_backlinks`, `suggest_connections`, `update_memory`, `delete_memory`, `list_memories`, `get_memory`, `link_memories`, `get_graph`, `tag_memory`, `get_recent_memories`. `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Markdown notes stored in `.sigmamemory/` with `[[wikilinks]]`. `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Force-directed graph view (D3 or react-force-graph). `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Backed by SQLite tables (`memories`). `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`

---

## MCP

- `[INFERRED]` Per-agent `mcp.json` writer + server catalog + lifecycle in `core/mcp/`. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Provider-specific MCP config locations:
  - Claude → `<worktree>/.mcp.json`.
  - Codex → `~/.codex/config.toml`.
  - Gemini → extension. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` Bundled MCP server catalog: Playwright, Memory, Filesystem, Git. `[REBUILD_PLAN.md §"Phase 3"]`
- `[INFERRED]` MCP canonical types in `src/shared/mcp.ts` (McpServer + adapter table). `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` MCP server pattern: tools, resources, prompts; agents call via JSON-RPC. `[research_extracted.txt §"Technical Deep Dive / MCP Protocol Integration"]`
- `[INFERRED]` Local HTTP server for status/progress reporting (Bernstein-pattern). `[research_extracted.txt §"Architecture Blueprint / Communication Layer"]`

---

## Tasks / Kanban

- `[CONFIRMED]` BridgeSpace has a Kanban Task Board with task-to-agent assignment. `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`
- `[INFERRED]` Columns: **Todo / In Progress / In Review / Done**. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` Implemented with dnd-kit. `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Tasks table in first SQLite migration. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` Subtask state lifecycle: planning, executing, completed, failed (matches current `OrchestratorTask` state). `[app/src/_legacy/sections/ReviewRoom.tsx]`

---

## Review Room

- `[INFERRED]` Real `git status`, `git diff`, untracked file listing, command runner, pass/fail marking, and Commit & Merge action. `[app/README.md §"What is working now"]`
- `[INFERRED]` Diff viewer using Monaco diff or react-diff-view. `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Inline commenting + activity timeline (research blueprint). `[research_extracted.txt §"Architecture Blueprint / Desktop Shell"]`
- `[INFERRED]` Human-in-the-loop approval gates. `[research_extracted.txt §"Implementation Roadmap / Phase 3"]`
- `[INFERRED]` Auto-merge with Janitor verification (Bernstein pattern). `[research_extracted.txt §"Implementation Roadmap / Phase 3"]`
- `[INFERRED]` Commit & Merge requires `git config --global user.name` and `user.email`. `[app/README.md §"Important notes"]`

---

## Settings

- `[INFERRED]` Settings room covers: providers, themes, MCP servers. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` 25+ themes via CSS custom properties only (no per-theme rebuild). `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Provider commands and install hints editable in `src/lib/providers.ts`. `[app/README.md §"Requirements"]`
- `[OPEN]` Theme picker UI structure not specified.

---

## Command palette

- `[INFERRED]` Cmd+K command palette for fuzzy search across all actions. `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 4"]`
- `[INFERRED]` Built on existing shadcn `Command` component. `[REBUILD_PLAN.md §"Phase 4"]`, `[app/info.md §"Components"]`
- `[INFERRED]` Equivalent feature exists in dux. `[research_extracted.txt §"Tier 2: Dux"]`

---

## Pricing

- `[CONFIRMED]` BridgeSpace requires the BridgeMind basic plan. `[video_transcript.txt §"Pricing"]`
- `[CONFIRMED]` Price: **$20/month**. `[video_transcript.txt §"Pricing"]`
- `[CONFIRMED]` Limited-time discount: 20% off with `LAUNCH20`. `[video_transcript.txt §"Pricing"]`
- `[CONFIRMED]` Distribution: download from `bridgemind.ai`. `[video_transcript.txt §"Pricing"]`, `[docs/02-research/transcripts/launch-video-description.txt]`
- `[INFERRED]` SigmaLink (this project) explicitly out of scope: cloud sync, accounts, billing, credit metering. `[REBUILD_PLAN.md §"Out of scope"]`

---

## Telemetry

- `[INFERRED]` Local-only persistence: SQLite for state, filesystem for shared artifacts. `[research_extracted.txt §"Architecture Blueprint / Communication Layer"]`
- `[INFERRED]` Local-only storage explicitly stated for the Emdash baseline. `[research_extracted.txt §"Tier 1 / Table 0"]`
- `[INFERRED]` SigmaLink is a working MVP, not a hosted SaaS, executes only local commands. `[app/README.md §"Important notes"]`
- `[OPEN]` Whether SigmaLink ships any opt-in telemetry. Not addressed by any document.

---

## Out-of-scope (explicit)

- `[INFERRED]` Cloud sync. `[REBUILD_PLAN.md §"Out of scope"]`
- `[INFERRED]` User accounts. `[REBUILD_PLAN.md §"Out of scope"]`
- `[INFERRED]` Billing / credit metering. `[REBUILD_PLAN.md §"Out of scope"]`
- `[INFERRED]` Voice assistant. `[REBUILD_PLAN.md §"Out of scope"]`
- `[INFERRED]` Mobile app. `[REBUILD_PLAN.md §"Out of scope"]`
- `[INFERRED]` SSH remote workspaces (port the abstraction; no UI). `[REBUILD_PLAN.md §"Out of scope"]`
- `[INFERRED]` BridgeMind-specific paid features. `[REBUILD_PLAN.md §"Out of scope"]`

---

## Persistence schema (first migration tables)

- `[INFERRED]` `workspaces`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` `projects`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` `tasks`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` `conversations`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` `messages`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` `terminals`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` `skills`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` `memories`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`

---

## Cross-process / RPC

- `[INFERRED]` Generic Proxy-based RPC replaces the existing IPC contract. `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` Preload exposes exactly 4 methods: `invoke`, `eventOn`, `eventSend`, `getPathForFile`. `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- `[INFERRED]` Typed pub/sub event bus in `src/shared/events.ts`. `[REBUILD_PLAN.md §"Architecture (target)"]`
- `[INFERRED]` `electron/rpc-router.ts` assembles all controllers. `[REBUILD_PLAN.md §"Architecture (target)"]`

---

## Terminal stack

- `[INFERRED]` PTY: ring-buffer with atomic subscribe (Emdash pattern), ports current `electron/main.ts` PTY plumbing (lines 74-250) into `core/pty/local-pty.ts`. `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`
- `[INFERRED]` Renderer terminal: xterm.js with FitAddon and WebLinksAddon. `[app/src/_legacy/sections/TerminalPane.tsx]`, `[research_extracted.txt §"Technical Deep Dive / PTY Terminal Emulation"]`
- `[INFERRED]` Cross-platform: Linux/macOS unix PTY, Windows ConPTY. `[research_extracted.txt §"Technical Deep Dive / PTY Terminal Emulation"]`
- `[INFERRED]` Terminal font: `JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace`. `[app/src/_legacy/sections/TerminalPane.tsx]`

---

## IP / Legal

- `[INFERRED]` Functional/idiomatic terminology (Coordinator/Builder/Scout/Reviewer; room names; `.sigmamemory` directory) is permissible. `[REBUILD_PLAN.md §"Legal/IP guardrails"]`
- `[INFERRED]` File-mailbox protocol independently designed. `[REBUILD_PLAN.md §"Legal/IP guardrails"]`
- `[INFERRED]` Direct portable patterns are from Emdash (Apache-2.0). NOTICE attribution required. `[REBUILD_PLAN.md §"Legal/IP guardrails"]`
- `[INFERRED]` No screenshot reproduction; no copy of proprietary BridgeSpace assets. `[REBUILD_PLAN.md §"Legal/IP guardrails"]`
- `[INFERRED]` Provider names treated as factual product references. `[REBUILD_PLAN.md §"Legal/IP guardrails"]`

---

## Open questions (consolidated)

- `[OPEN]` Final shipping provider list (see Agents/Providers).
- `[OPEN]` Worktree branch naming: `sigmalink/<role>/<task>-<5char>` vs `orchestrator/{agent-type}/{task-id}` (see CONFLICTS).
- `[OPEN]` Maximum agent panes: video/marketing says 16; rebuild plan presets cap at 16; current MVP launch-count parser clamps at 12; swarm preset says up to 50 (see CONFLICTS).
- `[OPEN]` BridgeSpace's official Skills support and whether our Skills loader has any direct counterpart.
- `[OPEN]` Whether the in-app browser exists in BridgeSpace itself.
- `[OPEN]` Theme picker UI structure (25+ themes target).
- `[OPEN]` Telemetry policy (no doc addresses it).
- `[OPEN]` Whether the demo's "coordinator 10" reference implies dynamic count beyond initial roster (see CONFLICTS).
