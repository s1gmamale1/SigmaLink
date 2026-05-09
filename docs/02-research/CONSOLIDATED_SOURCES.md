# Consolidated Sources

Item-by-item bullet summary of every input document already in the SigmaLink project. Every fact and design decision is preserved verbatim or paraphrased without loss. Citations name the source document and section.

---

## 1. `REBUILD_PLAN.md`

### `[REBUILD_PLAN.md §"Header / Synthesis"]`
- Document title: "SigmaLink Ground-Up Rebuild Plan".
- Synthesis sources called out: existing app audit, BridgeSpace public docs/marketing, Emdash (Apache-2.0) source patterns, Anthropic Skills + Playwright MCP patterns, `BridgeSpace_Research_Report.docx`, YouTube launch video transcript.

### `[REBUILD_PLAN.md §"North Star"]`
- Product is a **local-first Electron desktop agentic development environment**.
- Capability 1: launch grids of CLI coding agents (Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Aider, custom) in **real PTYs**.
- Capability 2: each agent is **isolated in a Git worktree**.
- Capability 3: operator can launch a **swarm of role-bearing agents** with roles **Coordinator / Builder / Scout / Reviewer**, talking through a **file-system mailbox**.
- Capability 4: **drag-and-drop Skills loader** (Anthropic Skills format) with fan-out to each provider's native location.
- Capability 5: **in-app browser pane** that any agent can drive via **Playwright MCP over CDP**.
- Capability 6: **shared-memory MCP server** (wikilink notes, BridgeMemory-equivalent) readable/writable by every agent.
- Capability 7: **persistence in SQLite** for workspaces, tasks, conversations, messages, terminals.

### `[REBUILD_PLAN.md §"Architecture (target)"]`
- Top-level layout: `electron/` (main process tree) and `src/` (shared + renderer).
- `electron/main.ts` does bootstrap, window, protocol, db init, RPC router.
- `electron/preload.ts` is **ONE generic `invoke` + event bridge (proxy-driven)**.
- `electron/rpc-router.ts` assembles all controllers.
- `electron/core/` modules:
  - `pty/` ring-buffer PTY with atomic subscribe (Emdash pattern).
  - `git/` worktree pool, commit/merge, status/diff.
  - `workspaces/` workspace factory, launcher presets `1/2/4/6/8/10/12/14/16`.
  - `providers/` provider registry + PATH probe + auto-detect.
  - `swarm/` role roster, mailbox bus, broadcast, roll-call.
  - `skills/` drag-drop ingest, validate, fan-out to `.claude/.codex/.gemini`.
  - `browser/` `WebContentsView` pane + CDP endpoint + Playwright MCP supervisor.
  - `memory/` SQLite-backed wikilink graph + MCP server (Bridge memory eq.).
  - `mcp/` per-agent `mcp.json` writer, server catalog, lifecycle.
  - `tasks/` Kanban board state, task→agent assignment.
  - `db/` Drizzle ORM, migrations, schema.
- `src/shared/` modules: `rpc.ts` (typed router/client, Proxy-based), `events.ts` (typed pub/sub), `providers.ts` (`AgentProviderDefinition[]` + helpers), `skills.ts` (SKILL.md frontmatter schema, Zod validators), `mcp.ts` (`McpServer` canonical + adapter table), `swarm.ts` (Role enum, mailbox message schema).
- `src/renderer/` modules: `main.tsx` (root + theme + RPC client); `app/App.tsx` + `app/router.tsx` with rooms `workspace / swarm / review / memory / browser`.
- `src/renderer/features/`: `workspace-launcher` (preset picker, agent assignment, launch); `command-room` (terminal grid mosaic/columns/focus); `swarm-room` (roster setup, side-chat, mailbox, broadcast); `review-room` (diff viewer, test runner, commit/merge); `memory` (graph view, note editor, search); `browser` (in-app browser pane, tabs, agent-drive indicator); `skills` (skill library, drop zone, install/remove); `tasks` (Kanban: Todo / In Progress / In Review / Done); `command-palette` (Cmd+K fuzzy search); `settings` (providers, themes, MCP servers).
- `src/renderer/components/ui/` keeps existing shadcn components.

### `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`
- Survives the rebuild: `electron/main.ts` PTY plumbing (lines 74-250) → `core/pty/local-pty.ts`.
- Survives: `electron/main.ts` Git ops (lines 117-369) → `core/git/`.
- Survives: `src/sections/TerminalPane.tsx` xterm rendering → `renderer/features/command-room/Terminal.tsx`.
- Survives: `src/lib/providers.ts` provider list (extend with full Emdash-style schema).
- Survives: 50+ shadcn UI components in `src/components/ui/*`.
- Survives: Tailwind + Vite + Electron Builder config.
- Replaced: IPC contract → generic Proxy-based RPC (Emdash pattern), keep type-safety.

### `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- New `src/shared/rpc.ts` + `src/shared/events.ts` (Proxy-based, typed).
- New minimal `electron/preload.ts` exposing **only 4 methods**: `invoke`, `eventOn`, `eventSend`, `getPathForFile`.
- Drizzle + better-sqlite3 setup with first migration covering tables: workspaces, projects, tasks, conversations, messages, terminals, skills, memories.
- New `core/pty/` with ring buffer + atomic subscribe (port + race-fix).
- New `core/providers/` with extended registry + PATH/version probe.
- New `core/git/` with worktree pool + branch naming **`sigmalink/<role>/<task>-<5char>`**.
- Workspace launcher UI: pick repo, pick preset (1-16 panes), assign provider per pane, launch.
- Command Room with new terminal grid using rebuilt PTY.

### `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- Mailbox file format path: `<userData>/swarms/<swarmId>/inboxes/<agentId>.jsonl`.
- Role roster UI: select count of Coordinators / Builders / Scouts / Reviewers, assign provider per role.
- Side-chat panel with **live mailbox tail**.
- Operator broadcast tool writes a special envelope to **all inboxes**.
- Roll-call protocol: Coordinator polls Builders for status.
- Persist swarm state in SQLite.

### `[REBUILD_PLAN.md §"Phase 3 — Skills + MCP + Browser"]`
- Skills drop zone in renderer using HTML5 drag, `webkitGetAsEntry`, `webUtils.getPathForFile`.
- SKILL.md validator (Zod), copies to `<userData>/skills/<id>/`.
- Fan-out: copy to `~/.claude/skills/<id>/`, copy/translate to `~/.codex/skills/<id>/`, synthesize `~/.gemini/extensions/<id>/`.
- MCP server config writer per spawned agent: Claude → `<worktree>/.mcp.json`; Codex → `~/.codex/config.toml`; Gemini → extension.
- Bundled MCP catalog: Playwright, Memory, Filesystem, Git.
- In-app browser pane: `WebContentsView`, address bar, back/forward, tabs.
- CDP endpoint exposed; supervises `npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<port>` per workspace.
- Each agent's `.mcp.json` points to the shared Playwright MCP HTTP port → agents drive the **visible** in-app browser.

### `[REBUILD_PLAN.md §"Phase 4 — Memory + Review + Polish"]`
- Custom **SigmaMemory MCP server** (stdio, in-process) exposing **12 tools**: `create_memory`, `search_memories`, `find_backlinks`, `suggest_connections`, `update_memory`, `delete_memory`, `list_memories`, `get_memory`, `link_memories`, `get_graph`, `tag_memory`, `get_recent_memories`.
- Markdown notes stored in `.sigmamemory/` with `[[wikilinks]]`.
- Force-directed graph view (D3 or react-force-graph).
- Review Room: full diff viewer (Monaco diff or react-diff-view).
- Kanban board (dnd-kit) with task→agent assignment.
- Command palette (Cmd+K) using existing shadcn `Command`.
- 25+ themes via CSS custom properties only (no per-theme rebuild).
- Auto-cleanup: prune merged worktrees on app start.

### `[REBUILD_PLAN.md §"Out of scope (this rebuild)"]`
- Cloud sync / accounts / billing / credit metering.
- Voice assistant.
- Mobile app.
- SSH remote workspaces (port the abstraction so it can be added later, but no UI).
- BridgeMind-specific paid features.

### `[REBUILD_PLAN.md §"Legal/IP guardrails"]`
- Visual layout, terminology (Coordinator/Builder/Scout/Reviewer roles, room naming, `.sigmamemory` directory) is allowed because it's functional/idiomatic.
- File-mailbox protocol is independently designed.
- All directly portable code patterns come from Emdash (Apache-2.0). Add NOTICE attribution.
- No screenshot reproduction, no copy of proprietary BridgeSpace assets.
- Provider names (Claude Code, Codex, etc.) are factual product references.

---

## 2. `research_extracted.txt` (extracted from `BridgeSpace_Research_Report.docx`)

### `[research_extracted.txt §"Cover / Title"]`
- Title: "Multi-Agent AI Orchestration Workspace — Research Report: Building a BridgeSpace-Style Unified Environment".
- Date: May 2026. Subtitle: "Comprehensive Technical Analysis & Implementation Blueprint".

### `[research_extracted.txt §"Executive Summary"]`
- Reference is BridgeMind's BridgeSpace product.
- Core innovation requested: dynamic multi-provider system where any CLI agent (Claude Code, Codex, Gemini CLI, OpenCode, Aider, etc.) can be launched in parallel terminals, connected to each other, and delegated tasks by a central orchestrator AI.
- Identifies **Emdash** as the strongest foundation; **dux** and **Claude Squad** as terminal-first alternatives.
- Proposes Emdash + a custom orchestrator layer inspired by **Bernstein** patterns as optimal path.
- Evaluates 15+ open-source tools.
- Includes architecture blueprint, comparative analysis matrix, **16-week implementation roadmap**.

### `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`
- BridgeSpace is a commercial Agentic Development Environment (ADE) for orchestrating **up to 16 AI coding agents in parallel**.
- Cross-platform Electron app (macOS, Windows, Linux).
- Terminal-first: multiple terminal panes running real CLI agents via PTY.
- Per-agent **Git worktree isolation**.
- **Multi-Room** workspace: Command Room (terminals), Swarm Room (parallel agents), Review Room (human oversight).
- **BridgeMemory**: local-first knowledge graph with **12 MCP tools** for shared agent memory.
- **Kanban Task Board**: integrated PM with task-to-agent assignment.

### `[research_extracted.txt §"BridgeSpace Feature Analysis / Key Differentiators"]`
- Orchestrator CLI AI capabilities:
  - Decompose high-level tasks into sub-tasks suitable for parallel execution.
  - Delegate sub-tasks to specialized agent instances with appropriate context.
  - Monitor agent progress and verify outputs before merging.
  - Maintain shared context through BridgeMemory (wikilink-based knowledge graph).
  - Support agent-to-agent communication for collaborative problem-solving.

### `[research_extracted.txt §"Tier 1: Emdash"]`
- `generalaction/emdash` on GitHub. 4,300+ stars. Apache-2.0. From YC W26 graduates.
- Auto-detected agents: Claude Code, OpenAI Codex, Gemini CLI, OpenCode, Amp, Droid (Factory CLI), Hermes Agent, Qwen Code, Cursor CLI, GitHub Copilot CLI, Aider, others.
- Adding a new provider needs only a configuration entry — no code changes.
- Strengths: Electron multi-pane terminal UI; provider abstraction; built-in worktree management and diff review; YC-backed; Apache-2.0.
- Gap: explicitly does **not** include agent-to-agent delegation or an orchestrator AI.

### `[research_extracted.txt §"Tier 1 / Table 0"]`
- License: Apache-2.0 with patent grant.
- Platform: macOS, Windows, Linux.
- Tech stack: Electron + TypeScript + React + SQLite.
- Agent support: 20+ CLI providers (auto-detected from PATH).
- Isolation: Git worktrees per agent session.
- Remote dev: full SSH with ProxyCommand support.
- Ticketing: Linear, Jira, GitHub Issues native integration.
- Storage: local-only SQLite.
- Community: 92 contributors, 106 releases.

### `[research_extracted.txt §"Tier 2: Dux"]`
- `patrickdappollonio/dux`. Go terminal-native orchestration.
- Philosophy: "No protocol layers. No adapters. No JSON-RPC. Just real CLIs in real terminals."
- Unique features: Companion Terminals (unlimited shells per agent), Session Forking, AI Commit Messages, Macro System, Command Palette.

### `[research_extracted.txt §"Tier 2 / Table 1"]`
- Open source. macOS + Linux. Go (native binary). TUI with three panes.
- Supports Claude, Codex, Gemini, OpenCode + any custom CLI.
- Memory footprint: ~36 MB RAM (vs 8-10 GB for agents).
- Features: worktrees, companion terminals, macros, fork sessions, git staging, PR tracking.

### `[research_extracted.txt §"Tier 3: Claude Squad"]`
- `smtg-ai/claude-squad`. 6,800+ stars. AGPL-3.0. Go-based TUI.
- Agents: Claude Code, Codex, Aider, Gemini, OpenCode, Amp.
- Isolation: Git worktrees + tmux sessions per agent.
- Coordination: human-supervised parallel dispatch (no automated orchestration).
- UI: TUI with diff preview, checkout, resume, commit-and-push.

### `[research_extracted.txt §"Tier 4: Bernstein"]`
- `chernistry/bernstein`. Apache-2.0. Most architecturally interesting orchestrator.
- Pipeline: Goal → LLM Planner → Task Graph → Orchestrator → Agents (parallel) → Janitor (verify) → Git merge.
- Deterministic scheduling with **zero LLM tokens spent on coordination**.
- Supports 30+ CLI agents including Claude Code, Codex, Gemini CLI.
- Janitor agent runs lint, type checks, and tests before merge.
- Local HTTP task server for agent progress reporting.

### `[research_extracted.txt §"Other Notable Tools"]`
- **Vibe Kanban** (community-maintained, formerly Bloop): web app, Kanban board, supports 10+ agents via MCP.
- **Composio AO**: full-automation system, web dashboard, agents fix CI failures and respond to review comments autonomously.
- **Nimbalyst**: desktop app with visual editing, successor to deprecated Crystal project.
- **Microsoft Conductor**: YAML-defined multi-agent workflows with GitHub Copilot SDK.

### `[research_extracted.txt §"Comparative Analysis Matrix / Table 2"]`
- Emdash | Apache-2.0 | All | 20+ agents | Electron | Manual orch. | Visual desktop ADE.
- Dux | Open | Mac/Linux | Any | TUI | Manual | Terminal-first control.
- Claude Squad | AGPL-3.0 | All | 6+ | TUI | Manual | Human-in-the-loop.
- Bernstein | Apache-2.0 | All | 30+ | CLI+Web | Auto | Deterministic orchestration.
- Vibe Kanban | Apache-2.0 | Web | 10+ | Web | Kanban | Kanban-driven workflows.
- Composio AO | MIT | Web+CLI | 4+ | Web | Auto | Full CI automation.

### `[research_extracted.txt §"Architecture Blueprint / System Architecture"]`
- Five core layers:
  1. **Desktop Shell (Electron + React)**: multi-pane terminal layout (xterm.js + node-pty); room-based navigation (Command, Swarm, Review); Kanban with drag-and-drop assignment; diff viewer (syntax highlighting + inline comments); activity timeline.
  2. **Worktree Manager**: isolated git worktree per session; auto branch `orchestrator/{agent-type}/{task-id}`; per-worktree port allocation; env-var injection for provider API keys.
  3. **Agent Provider Abstraction**: plugin-based (Emdash-inspired); each provider defines `command`, `args`, `resume_args`, `oneshot_args`; auto-detect by PATH scan; provider config in TOML/JSON.
  4. **Orchestrator Engine**: LLM-based decomposition with structured output (JSON mode); hierarchical delegation Orchestrator → Sub-Agents → Workers; verification loop Execute→Verify→Retry; deterministic scheduling (Bernstein pattern); shared memory via MCP tools.
  5. **Communication Layer**: MCP for agent-to-tool comms; local HTTP server for status/progress; message bus for inter-agent coordination; SQLite for state, filesystem for shared artifacts.

### `[research_extracted.txt §"The Orchestrator Layer"]`
- Pseudocode loop:
  - For each subtask: 1) EXECUTE (delegate to specialist agent); 2) VERIFY (verifier agent, "Is this correct enough?"); 3) if NO, re-delegate with feedback → goto 1; 4) if YES, next subtask.
- Delegation contract fields: `intent`, `inputs`, `constraints`, `success_criteria`, `assigned_agent`.

### `[research_extracted.txt §"Multi-Provider Agent Abstraction"]`
- Provider config example (TOML-style):
  - `[providers.claude]` `command = "claude"`, `resume_args = ["--resume"]`, `oneshot_args = ["-p", "{prompt}"]`, `install_hint = "npm install -g @anthropic/claude-code"`.
  - `[providers.codex]` `command = "codex"`, `resume_args = ["--resume"]`.
  - `[providers.gemini]` `command = "gemini"`, `resume_args = ["--resume"]`, `install_hint = "npm install -g @google/gemini-cli"`.

### `[research_extracted.txt §"Implementation Roadmap"]`
- 16-week phased approach.
- **Phase 1 (Weeks 1-4) Foundation**: fork Emdash, audit codebase, set up dev env (Electron + TS), understand worktree manager / agent runner / IPC bridge, add custom provider definitions, basic orchestrator config UI. Deliverable: modified Emdash with custom provider set + orchestrator config panel.
- **Phase 2 (Weeks 5-8) Multi-Agent Core**: agent-to-agent message bus over local HTTP; agent session manager with fork/branch; Swarm Room UI; task decomposition with structured LLM output; verification agent pattern. Deliverable: orchestrator delegating to 3+ parallel agents.
- **Phase 3 (Weeks 9-12) Orchestrator Intelligence**: MCP server for shared memory (BridgeMemory equivalent); wikilink knowledge graph with bidirectional connections; Review Room with human-in-the-loop gates; auto-merge with Janitor verification; deterministic scheduling for zero-token coordination.
- **Phase 4 (Weeks 13-16) Polish & Scale**: performance for 16+ parallel agents; SSH remote dev; ticket integration (Linear, Jira, GitHub Issues); themes + UI customization; documentation and community onboarding.

### `[research_extracted.txt §"Technical Deep Dive / Git Worktree Isolation"]`
- `git worktree add -b agent/task-001 ../project-task-001 main`.
- Each agent runs in own directory; merge via standard git merge/PR workflow.
- Cleanup: `git worktree remove --force ../project-task-001`, `git branch -D agent/task-001`.

### `[research_extracted.txt §"Technical Deep Dive / PTY Terminal Emulation"]`
- node-pty (native Node.js module) creates pseudo-terminals; xterm.js renders.
- Full TTY emulation: colors, cursor positioning, escape sequences.
- Bidirectional I/O; process control (resize, kill, monitor).
- Cross-platform: Linux/macOS unix PTY, Windows ConPTY.

### `[research_extracted.txt §"Technical Deep Dive / MCP Protocol Integration"]`
- MCP standardizes how agents access external tools and context.
- MCP servers expose tools, resources, and prompts.
- Agents call tools via structured JSON-RPC.
- Shared memory tools: `create_memory`, `search_memories`, `find_backlinks`.
- Enables any MCP-compatible agent to participate in the workspace.

### `[research_extracted.txt §"Conclusions & Recommendations"]`
- Primary recommendation: **fork Emdash and build the orchestrator layer on top**.
- Alternative: greenfield build using Electron + React, node-pty + xterm.js, SQLite, custom orchestrator inspired by Bernstein's deterministic scheduling.
- Key success factors: provider abstraction config-driven (not hardcoded); git worktrees for conflict-free parallel exec; verification gates prevent error propagation; human-in-the-loop maintains developer control; MCP integration maximizes interoperability.
- "Build the Future of Agent Orchestration. Research compiled May 2026. Based on analysis of 15+ open-source tools and frameworks."

---

## 3. `video_transcript.txt` (and identical `docs/02-research/transcripts/launch-video-RG38jA-DFeM.txt`)

### `[video_transcript.txt §"Launch framing"]`
- Speaker says BridgeMind is launching BridgeSpace after "145 days of vibe coding".
- Claim: BridgeSpace empowers builders to ship code "at the speed of thought".

### `[video_transcript.txt §"Live swarm demo"]`
- Demo swarm composition: **2 coordinators, 5 builders, 1 reviewer, 2 scouts**.
- Side-chat panel shows inter-agent messages. Example: "coordinator 10 sent a message to builder 3" (note: this contradicts the demo composition having only 2 coordinators — see CONFLICTS).
- Operator can directly message a single agent ("just messaged coordinator 1").
- Operator command: "Check with all agents to confirm the job is complete." Coordinator 1 then performs a roll call: "operator wants confirmation from all agents that the job is complete. Please reply with your status."
- Coordinator returns final "job complete" confirmation after polling.
- Speaker says he "built BridgePace using BridgePace".

### `[video_transcript.txt §"BridgeSpace workspace demo"]`
- Operator picks any project directory.
- Operator picks how many Claude Code or Codex agents to launch.
- "I can launch up to **16 terminal sessions**".
- Operator selects which agents to use; example mix: "two codex, one Gemini, one cursor agent".
- Click launch → workspace ready.
- "BridgeSwarm is the other core product inside of BridgeSpace."

### `[video_transcript.txt §"BridgeSwarm demo"]`
- Differentiation: BridgeSpace = isolated agents; BridgeSwarm = coordinating swarm.
- Example prompt: "I want this swarm to be able to identify any security vulnerabilities and fix them."
- Knowledge upload: "You can upload PDFs, images, anything that you want in the swarm's brain." (Skipped in demo.)
- Roster preset selector: "presets between **5 agents or 50 agents**".
- Per-role provider assignment guidance from speaker:
  - Coordinators → Codex ("very good coordinator capabilities").
  - Builders → Claude ("able to write code incredibly well").
  - Scouts → Gemini.
  - Reviewers → Codex.
- Click "launch swarm" launches a 5-agent swarm.
- Right panel shows live coordination chat. Example: "builder 2 asks the operator, 'How are you feeling?'"
- Speaker positions BridgeSwarm for hand-off of long-running difficult tasks with minimal intervention.

### `[video_transcript.txt §"Pricing"]`
- BridgeSpace is gated behind "BridgeMind basic plan".
- Price: **$20 per month**.
- Limited-time discount: 20% off with code `LAUNCH20` at checkout.
- Distribution: download from `bridgemind.ai`.

### `[docs/02-research/transcripts/launch-video-description.txt]`
- Promotional description repeating: "Run up to 16 simultaneous AI agent sessions, mixing Claude, Codex, and Gemini, each assigned a specific role: coordinators, builders, scouts, and reviewers."
- "With BridgeSwarm, your agents communicate, coordinate, and complete long-running tasks with minimal intervention."
- Tagline: "Stop typing. Start shipping."
- Chapter list: BridgeSwarm Live, "I Built BridgeSpace Using BridgeSpace", BridgeSpace Workspaces (mix Claude/Codex/Gemini), BridgeSwarm Deep Dive (Coordinators/Builders/Scouts/Reviewers), Real-World Demo: Security Vulnerability Swarm Task, Setting Up Your Agent Roster, Watching the Swarm Come to Life, Pricing/Launch Discount.
- Keywords: vibe coding, agentic coding, agentic development environment, AI IDE, multi-agent orchestration, "Claude Opus 4.6", "GPT 5.4", Gemini, BridgeSpace, BridgeSwarm, BridgeMind, etc.

---

## 4. `app/README.md`

### `[app/README.md §"Header"]`
- Title: "SigmaLink Agent Orchestrator".
- Description: "Electron desktop workspace for running multiple CLI coding agents in parallel. It launches real PTY-backed terminals, isolates agent work in Git worktrees, and gives you a review room for live diffs, test commands, and commit/merge approval."

### `[app/README.md §"What is working now"]`
- Real Electron + React desktop app.
- Real terminal sessions via `node-pty` and `@xterm/xterm`.
- Provider registry for Claude Code, Codex, Gemini CLI, **Kimi CLI**, **Continue**, and Custom CLI.
- Workspace folder picker.
- Git repo detection.
- Per-agent isolated Git worktrees under Electron user data.
- Swarm task delegation that launches real agent sessions and sends structured prompts.
- Review Room with real `git status`, `git diff`, untracked file listing, command runner, pass/fail marking, commit/merge action.
- Safer command execution for Git ops via argument arrays (no string-interpolated shell).

### `[app/README.md §"Requirements"]`
- Node.js 20+.
- Git.
- At least one CLI agent installed.
- Provider commands and install hints editable in `src/lib/providers.ts`.

### `[app/README.md §"Development / Build / Package"]`
- Dev: `npm install`, `npm run electron:dev`.
- Build check: `npm run product:check`.
- Package: `npm run electron:build`.

### `[app/README.md §"Workflow"]`
- Steps: open SigmaLink → select repo/folder → launch agent manually from Command Room or create task in Swarm Room → run orchestrator (launches worktrees, sends prompts) → review diffs & run commands in Review Room → mark subtasks pass/fail → "Commit & Merge" to commit approved worktree changes and merge into selected repo.

### `[app/README.md §"Important notes"]`
- If folder is not a Git repo, falls back to direct-folder mode (terminals run; worktree/diff/merge disabled).
- Commit & Merge requires `git config --global user.name` and `user.email` set.
- "This is a working MVP, not a hosted SaaS."
- "It executes local commands, so only run it against repos and agents you trust."

---

## 5. `app/info.md`

### `[app/info.md §"Stack"]`
- Node.js 20.
- Tailwind CSS v3.4.19.
- Vite v7.2.4.
- Tailwind set up with the shadcn theme.
- Setup completed at `/mnt/agents/output/app`.

### `[app/info.md §"Components (40+)"]`
- Listed shadcn/ui components: accordion, alert-dialog, alert, aspect-ratio, avatar, badge, breadcrumb, button-group, button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, empty, field, form, hover-card, input-group, input-otp, input, item, kbd, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle-group, toggle, tooltip.

### `[app/info.md §"Usage / Structure"]`
- Import pattern: `import { Button } from '@/components/ui/button'`.
- Folder map: `src/sections/` (page sections), `src/hooks/`, `src/types/`, `src/App.css`, `src/App.tsx`, `src/index.css`, `src/main.tsx`, `index.html`, `tailwind.config.js`, `vite.config.ts`, `postcss.config.js`.

---

## 6. `app/src/_legacy/` markdown / source quick-summary

No `.md` files exist under `app/src/_legacy/`. The legacy TypeScript source captures decisions baked into the current MVP, summarised here.

### `[app/src/_legacy/lib/providers.ts]`
- Default `AGENT_PROVIDERS` array with entries:
  - `claude` — Claude Code, command `claude`, resume `--resume`, oneshot `-p {prompt}`, install hint `npm install -g @anthropic-ai/claude-code`, color `#E57035`, icon `Bot`.
  - `codex` — OpenAI Codex, command `codex`, resume `--resume`, oneshot `-q {prompt}`, install `npm install -g @openai/codex`, color `#10A37F`, icon `Code2`.
  - `gemini` — Gemini CLI, command `gemini`, resume `--resume`, oneshot `--prompt {prompt}`, install `npm install -g @google/gemini-cli`, color `#4285F4`, icon `Sparkles`.
  - `kimi` — Kimi CLI, command `kimi`, oneshot `--prompt {prompt}`, install hint generic, color `#22D3EE`, icon `Moon`.
  - `continue` — Continue, command `continue`, install `npm install -g @continuedev/cli`, color `#6366F1`, icon `Play`.
  - `custom` — Custom CLI placeholder, color `#6B7280`, icon `Settings`.
- Helpers: `getProviderById(id)`, `getDefaultProvider()`.

### `[app/src/_legacy/App.tsx]`
- Imports `WorkspaceProvider`, `Sidebar`, `CommandRoom`, `SwarmRoom`, `ReviewRoom`.
- Defines header band: "SigmaLink Control Surface" tag, room name (Command Room / Swarm Room / Review Room) with green / purple / amber accent.
- Live stats badges: Live agents, Running, Base (base branch).
- Quick-launch chips for first 5 providers.
- Single state mux of `state.currentRoom` between Command/Swarm/Review.

### `[app/src/_legacy/sections/Sidebar.tsx]`
- Three rooms registered: `command` (Terminal icon, emerald), `swarm` (Users icon, purple), `review` (ClipboardCheck icon, amber).
- `WORKSPACES_KEY = 'sigmalink.savedWorkspaces'` localStorage key, max 12 saved entries.
- Workspace shape: `{ id, name, path, repoRoot }`.

### `[app/src/_legacy/sections/CommandRoom.tsx]`
- Layout modes: **`mosaic` / `columns` / `focus`**.
- Density modes: **`compact` / `balanced` / `expanded`**.
- Compact min width 260, balanced 320, expanded 400.
- Compact min height 240, balanced 300, expanded 360.
- Columns mode: 1, 2, or 3 columns based on terminal count.
- Mosaic uses `auto-fit, minmax(min(100%, <minWidth>px), 1fr)`.
- Empty-state shows: "Build your first command mosaic" + 5 provider quick-launch chips (excludes `custom`).

### `[app/src/_legacy/sections/CommandDock.tsx]`
- Tabs in dock: **`browser`, `editor`, `jarvis`** (default `jarvis`).
- Default browser URL: `https://openai.com`.
- Has a "Jarvis" assistant chat with starter message: "I can help you launch agents, switch rooms, and summarize the active session." Examples: `launch kimi`, `launch 2 claude`, `open review room`.
- Provider keyword extractor recognises `claude`, `codex`, `gemini`, `kimi`, `continue`, `custom`.
- Launch count parser clamps `1-12` (note: the launcher preset spec says up to 16 — see CONFLICTS).

### `[app/src/_legacy/sections/SwarmRoom.tsx]`
- Component name: "Orchestrator".
- Subtitle: "Delegate tasks to multiple AI agents in parallel".
- Subtask form fields: `title`, `description`, `assignedProvider`, `intent`. Default success criteria string: "Code compiles and tests pass".
- "New Task" button styled purple. Two-pane layout (50/50: task creation / current tasks).

### `[app/src/_legacy/sections/ReviewRoom.tsx]`
- Three task buckets: Active (planning|executing), Completed, Failed.
- Diff per subtask preview (uses `OrchestratorTask`/`SubTask` types).
- Pass/fail marking + "Commit & Merge" actions referenced.

### `[app/src/_legacy/sections/TerminalPane.tsx]`
- xterm.js Terminal config: `cursorBlink: true`, `convertEol: true`, font family `JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace`.
- Density-driven font size: compact 11, balanced 12, expanded 13. LineHeight: 1.15 / 1.2 / 1.28.
- Uses `FitAddon` and `WebLinksAddon` from `@xterm/addon-fit` and `@xterm/addon-web-links`.
- `scheduleFit` triggers `fit()` on rAF + timeouts at 80 ms and 220 ms (to handle layout transitions).

### `[app/src/_legacy/hooks/useWorkspace.tsx]`
- Reducer-driven workspace state. Fields: `currentRoom`, `terminals`, `activeTerminalId`, `tasks`, `activeTaskId`, `messages`, `providers`, `isOrchestratorRunning`, `sidebarCollapsed`, `repoPath`, `repoRoot`, `baseBranch`.
- Actions: `SET_ROOM`, `SET_WORKSPACE`, `CREATE_TERMINAL`, `UPDATE_TERMINAL`, `CLOSE_TERMINAL`, `SET_ACTIVE_TERMINAL`, `TERMINAL_OUTPUT`, `TERMINAL_STATUS`, `CREATE_TASK`, `SET_ACTIVE_TASK`, `UPDATE_SUBTASK`, `SET_ORCHESTRATOR_RUNNING`, `ADD_MESSAGE`, `TOGGLE_SIDEBAR`, `ADD_PROVIDER`.
- localStorage key `sigmalink.workspace` persists `repoPath`, `repoRoot`, `baseBranch` (default `'HEAD'`).

### `[app/src/_legacy/pages/Home.tsx]`
- Vite default scaffold (Vite + React counter); not part of the orchestrator UI. Vestigial.
