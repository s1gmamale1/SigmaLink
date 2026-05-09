# Design Decisions Log

Every architectural / design decision already made in the SigmaLink project, with the rationale and the source document(s) that motivated it. This is the canonical "we already decided this" list — the build phase should treat each item as settled unless explicitly reopened.

---

## DD-001: Electron desktop shell (no browser-only build, no Tauri)

- **Decision**: Build on Electron + TypeScript + React.
- **Rationale**:
  - Matches BridgeSpace's own platform (cross-platform Electron desktop). `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`
  - Matches Emdash, the recommended foundation. `[research_extracted.txt §"Tier 1: Emdash"]`
  - Allows shipping `WebContentsView`, `node-pty`, and on-disk userData paths without a custom runtime.
- **Sources**: `[REBUILD_PLAN.md §"North Star"]`, `[REBUILD_PLAN.md §"Architecture (target)"]`, `[research_extracted.txt §"Conclusions / Primary Recommendation"]`, `[app/README.md §"Header"]`.

## DD-002: React + Vite + Tailwind v3.4 + shadcn/ui

- **Decision**: Renderer is React + Vite + Tailwind v3.4.19, with the shadcn theme and 50+ shadcn UI components.
- **Rationale**: Already scaffolded; rebuild plan keeps Tailwind + Vite + Electron Builder config and the existing `src/components/ui/*`.
- **Sources**: `[app/info.md §"Stack"]`, `[app/info.md §"Components"]`, `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`.

## DD-003: Local-first persistence on SQLite via Drizzle + better-sqlite3

- **Decision**: SQLite-only persistence; Drizzle ORM with migrations; first migration covers `workspaces`, `projects`, `tasks`, `conversations`, `messages`, `terminals`, `skills`, `memories`.
- **Rationale**: BridgeSpace and Emdash are explicitly local-first SQLite. Avoids cloud dependencies. Out-of-scope items (cloud sync, accounts, billing) reinforce the choice.
- **Sources**: `[REBUILD_PLAN.md §"North Star"]`, `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`, `[research_extracted.txt §"Tier 1 / Table 0"]`.

## DD-004: PTY layer = ring-buffer with atomic subscribe (Emdash pattern)

- **Decision**: Reimplement local PTY in `electron/core/pty/local-pty.ts` with a ring buffer and atomic subscribe semantics, fixing the race in the current code. Port from existing PTY plumbing in `electron/main.ts` (lines 74-250).
- **Rationale**: Emdash-proven pattern. The existing PTY plumbing already works but has a race that the rebuild needs to fix.
- **Sources**: `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`.

## DD-005: Terminal renderer = xterm.js with FitAddon + WebLinksAddon

- **Decision**: Continue rendering terminals with `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`. Move `src/sections/TerminalPane.tsx` to `renderer/features/command-room/Terminal.tsx`.
- **Rationale**: Already working in current MVP. xterm.js is the consensus across all evaluated tools.
- **Sources**: `[app/src/_legacy/sections/TerminalPane.tsx]`, `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`, `[research_extracted.txt §"Technical Deep Dive / PTY Terminal Emulation"]`.

## DD-006: Per-agent isolation via Git worktrees

- **Decision**: Each agent runs inside an isolated Git worktree. Commit/merge semantics are standard Git.
- **Rationale**: Universal pattern across Emdash, dux, Claude Squad, Bernstein. Already implemented in current MVP under Electron user data.
- **Sources**: `[REBUILD_PLAN.md §"North Star"]`, `[research_extracted.txt §"Technical Deep Dive / Git Worktree Isolation"]`, `[app/README.md §"What is working now"]`.

## DD-007: Branch naming pattern `sigmalink/<role>/<task>-<5char>`

- **Decision**: Worktree branches follow `sigmalink/<role>/<task>-<5char>`.
- **Rationale**: Project-specific namespacing prevents collisions with user branches; role + task slug aids hygiene.
- **Sources**: `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`.
- **Note**: Conflicts with the alternative `orchestrator/{agent-type}/{task-id}` pattern in the research blueprint — see `CONFLICTS.md`.

## DD-008: Roles = Coordinator / Builder / Scout / Reviewer

- **Decision**: Adopt the four BridgeSpace role names verbatim.
- **Rationale**: Functional/idiomatic terminology, allowed under our IP guardrails. Matches the launch video and marketing.
- **Sources**: `[REBUILD_PLAN.md §"North Star"]`, `[REBUILD_PLAN.md §"Legal/IP guardrails"]`, `[video_transcript.txt §"Live swarm demo"]`, `[docs/02-research/transcripts/launch-video-description.txt]`.

## DD-009: Swarm communication via file-system mailbox (independently designed)

- **Decision**: Swarm communication uses a file-mailbox protocol at `<userData>/swarms/<swarmId>/inboxes/<agentId>.jsonl`. Roll-call and operator broadcast are first-class envelopes.
- **Rationale**: Independently designed to avoid IP concerns with BridgeSpace's internal mechanism. JSONL inbox per agent is durable, observable, and cheap to tail for the side-chat panel.
- **Sources**: `[REBUILD_PLAN.md §"North Star"]`, `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`, `[REBUILD_PLAN.md §"Legal/IP guardrails"]`.

## DD-010: Provider abstraction is config-driven (no hardcoded list)

- **Decision**: Each provider is a configuration entry with `command`, `args`, `resumeArgs`, `oneshotArgs`, `installHint` (plus UI metadata: color/icon/description). New providers ship as config, not code.
- **Rationale**: Emdash-style design; explicit "Key Success Factor" in the research report.
- **Sources**: `[research_extracted.txt §"Architecture Blueprint / Agent Provider Abstraction"]`, `[research_extracted.txt §"Multi-Provider Agent Abstraction"]`, `[research_extracted.txt §"Conclusions / Key Success Factors"]`, `[app/src/_legacy/lib/providers.ts]`.

## DD-011: Auto-detect providers via PATH/version probe

- **Decision**: At startup the provider registry scans PATH for known CLI binaries and records detected versions.
- **Rationale**: Emdash and others rely on this; gives accurate launcher state without manual config.
- **Sources**: `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`, `[research_extracted.txt §"Architecture Blueprint / Agent Provider Abstraction"]`, `[research_extracted.txt §"Tier 1: Emdash"]`.

## DD-012: Generic Proxy-based RPC, minimal preload

- **Decision**: Replace the existing IPC contract with a generic Proxy-based RPC (Emdash pattern). Preload exposes exactly four methods: `invoke`, `eventOn`, `eventSend`, `getPathForFile`. Typed pub/sub lives in `src/shared/events.ts`. RPC types in `src/shared/rpc.ts`. Controllers assembled in `electron/rpc-router.ts`.
- **Rationale**: Type-safe, minimal attack surface, easy to extend without churn on `preload`.
- **Sources**: `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`, `[REBUILD_PLAN.md §"Architecture (target)"]`.

## DD-013: Multi-Room navigation (Workspace, Swarm, Review, Memory, Browser)

- **Decision**: Renderer is room-based. Existing rooms: Command (terminals), Swarm, Review. Rebuild adds Memory and Browser rooms.
- **Rationale**: Matches BridgeSpace's three-room model and adds the rebuild's new browser/memory features.
- **Sources**: `[REBUILD_PLAN.md §"Architecture (target)"]`, `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`, `[app/src/_legacy/App.tsx]`.

## DD-014: Workspace launcher presets `1/2/4/6/8/10/12/14/16`

- **Decision**: Workspace launcher offers preset pane counts 1, 2, 4, 6, 8, 10, 12, 14, 16. Operator assigns provider per pane and launches.
- **Rationale**: Matches BridgeSpace's "up to 16" demo; presets reduce friction.
- **Sources**: `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`, `[video_transcript.txt §"BridgeSpace workspace demo"]`.

## DD-015: Drag-and-drop Skills loader using Anthropic Skills format

- **Decision**: Adopt Anthropic Skills format (SKILL.md + frontmatter). Drop zone uses HTML5 drag, `webkitGetAsEntry`, `webUtils.getPathForFile`. Skills validated by Zod and stored at `<userData>/skills/<id>/`.
- **Rationale**: Anthropic Skills is the de facto multi-vendor skill format; ingest by drop matches operator expectation.
- **Sources**: `[REBUILD_PLAN.md §"North Star"]`, `[REBUILD_PLAN.md §"Phase 3"]`, `[REBUILD_PLAN.md §"Architecture (target)"]`.

## DD-016: Skills fan-out to provider-native locations

- **Decision**: After ingest, copy/translate/synthesize each skill into:
  - `~/.claude/skills/<id>/`
  - `~/.codex/skills/<id>/`
  - `~/.gemini/extensions/<id>/`
- **Rationale**: Each provider reads skills/extensions from a fixed path; centralised registry + fan-out makes one drop reach all providers.
- **Sources**: `[REBUILD_PLAN.md §"Phase 3"]`.

## DD-017: In-app browser pane = Electron WebContentsView with CDP exposed

- **Decision**: Browser pane uses `WebContentsView` with address bar, back/forward, tabs, and exposes a CDP endpoint per workspace.
- **Rationale**: Electron WebContentsView is the standard for embedding a controllable Chromium view; CDP is the language Playwright speaks.
- **Sources**: `[REBUILD_PLAN.md §"Phase 3"]`, `[REBUILD_PLAN.md §"Architecture (target)"]`.

## DD-018: Per-workspace Playwright MCP supervisor over CDP

- **Decision**: For each workspace, supervise `npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<port>`. Each agent's `.mcp.json` points to the shared Playwright MCP HTTP port; agents drive the visible in-app browser.
- **Rationale**: Lets every agent perform browser automation against the same visible browser surface — operator can watch the agent click around. Single supervised process per workspace, not per agent.
- **Sources**: `[REBUILD_PLAN.md §"Phase 3"]`.

## DD-019: SigmaMemory MCP server with 12 tools (BridgeMemory equivalent)

- **Decision**: Custom in-process stdio MCP server exposing 12 tools: `create_memory`, `search_memories`, `find_backlinks`, `suggest_connections`, `update_memory`, `delete_memory`, `list_memories`, `get_memory`, `link_memories`, `get_graph`, `tag_memory`, `get_recent_memories`. Markdown notes in `.sigmamemory/` with `[[wikilinks]]`. Force-directed graph view (D3 or react-force-graph).
- **Rationale**: Matches the BridgeSpace BridgeMemory feature (12 MCP tools, wikilinks). In-process stdio server avoids IPC overhead for the most-called tools.
- **Sources**: `[REBUILD_PLAN.md §"Phase 4"]`, `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`, `[research_extracted.txt §"Technical Deep Dive / MCP Protocol Integration"]`.

## DD-020: Per-agent MCP config writer

- **Decision**: When launching an agent, write the MCP config in the provider-native format/location:
  - Claude → `<worktree>/.mcp.json`.
  - Codex → `~/.codex/config.toml`.
  - Gemini → extension manifest.
- **Rationale**: Each provider expects MCP definitions in different files; a writer keeps the registration consistent.
- **Sources**: `[REBUILD_PLAN.md §"Phase 3"]`.

## DD-021: Bundled MCP server catalog (Playwright, Memory, Filesystem, Git)

- **Decision**: Ship Playwright, Memory, Filesystem, and Git MCP servers in the catalog out of the box.
- **Rationale**: Highest-leverage tools for a development environment; covers browser automation, shared memory, file IO, repo state.
- **Sources**: `[REBUILD_PLAN.md §"Phase 3"]`.

## DD-022: Kanban with Todo / In Progress / In Review / Done, dnd-kit

- **Decision**: Kanban board with columns Todo / In Progress / In Review / Done, implemented with dnd-kit. Tasks assigned to agents.
- **Rationale**: Matches BridgeSpace's task-to-agent assignment; dnd-kit is the modern standard.
- **Sources**: `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 4"]`, `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`.

## DD-023: Diff viewer = Monaco diff or react-diff-view

- **Decision**: Review Room rebuilds on top of solid Git ops; full diff viewer using Monaco diff or react-diff-view.
- **Rationale**: Replace the basic diff in the current MVP with a production-quality two-pane diff.
- **Sources**: `[REBUILD_PLAN.md §"Phase 4"]`.

## DD-024: Command palette (Cmd+K) on existing shadcn `Command`

- **Decision**: Cmd+K palette for fuzzy search across all actions, built on the existing shadcn `Command` component.
- **Rationale**: Already installed; matches dux's command-palette UX expectation.
- **Sources**: `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 4"]`, `[app/info.md §"Components"]`.

## DD-025: 25+ themes via CSS custom properties only

- **Decision**: Theming is CSS-variable-driven. No per-theme rebuild step.
- **Rationale**: Keeps theme switching instant and the bundle small.
- **Sources**: `[REBUILD_PLAN.md §"Phase 4"]`.

## DD-026: Auto-cleanup of merged worktrees on app start

- **Decision**: At app start, prune worktrees that have already been merged into their base branch.
- **Rationale**: Prevents accumulation of stale worktrees over long use.
- **Sources**: `[REBUILD_PLAN.md §"Phase 4"]`.

## DD-027: Out-of-scope set (do not build in this rebuild)

- **Decision**: Do not implement cloud sync, user accounts, billing/credit metering, voice assistant, mobile app, BridgeMind paid features, or SSH remote workspace UI. SSH abstraction is portable so SSH can be added later, but no UI ships.
- **Rationale**: Keep the rebuild focused on the local-first ADE; everything else inflates scope and IP risk.
- **Sources**: `[REBUILD_PLAN.md §"Out of scope"]`.

## DD-028: IP guardrails

- **Decision**: Functional/idiomatic terminology (Coordinator/Builder/Scout/Reviewer; room names; `.sigmamemory`) is allowed. The mailbox protocol is independently designed. Directly portable code patterns come from Emdash (Apache-2.0) with NOTICE attribution. No screenshot reproduction; no copy of proprietary BridgeSpace assets. Provider names are factual product references.
- **Rationale**: Lets us ship a BridgeSpace-style ADE without IP exposure.
- **Sources**: `[REBUILD_PLAN.md §"Legal/IP guardrails"]`.

## DD-029: Reuse the existing 50+ shadcn components verbatim

- **Decision**: Keep the existing shadcn UI library (accordion, alert-dialog, alert, aspect-ratio, avatar, badge, breadcrumb, button-group, button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, empty, field, form, hover-card, input-group, input-otp, input, item, kbd, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle-group, toggle, tooltip).
- **Rationale**: Already installed and themed.
- **Sources**: `[app/info.md §"Components"]`, `[REBUILD_PLAN.md §"Reuse from current SigmaLink app"]`.

## DD-030: Command Room layout/density modes carry over

- **Decision**: Command Room keeps three layout modes (`mosaic` / `columns` / `focus`) and three density modes (`compact` / `balanced` / `expanded`) with the existing min-width/min-height table. Columns mode picks 1/2/3 columns by terminal count.
- **Rationale**: Already implemented; matches the workstation-style multi-pane experience the speaker calls out.
- **Sources**: `[app/src/_legacy/sections/CommandRoom.tsx]`.

## DD-031: Safer Git command execution via argument arrays

- **Decision**: Git operations execute with argument arrays, never via string-interpolated shell commands.
- **Rationale**: Prevents command injection from operator-supplied paths and keeps Windows/POSIX behaviour consistent. Already implemented.
- **Sources**: `[app/README.md §"What is working now"]`.

## DD-032: MVP requires Git user config for Commit & Merge

- **Decision**: Commit & Merge requires `git config --global user.name` and `user.email` to be set; otherwise the action fails with a clear message.
- **Rationale**: Standard Git requirement; surfacing it early avoids confusing error states.
- **Sources**: `[app/README.md §"Important notes"]`.

## DD-033: Direct-folder fallback when path is not a Git repo

- **Decision**: If the selected workspace folder is not a Git repo, fall back to direct-folder mode: terminals run, but worktree/diff/merge features are disabled.
- **Rationale**: Allows quick experiments without forcing the user to `git init`.
- **Sources**: `[app/README.md §"Important notes"]`.

## DD-034: Persist workspace settings in localStorage with key `sigmalink.workspace`

- **Decision**: Renderer persists `repoPath`, `repoRoot`, `baseBranch` (default `'HEAD'`) under `sigmalink.workspace`. Saved workspaces list under `sigmalink.savedWorkspaces`, max 12 entries.
- **Rationale**: Already implemented; small enough to keep in localStorage; SQLite tracks the durable workspace registry separately.
- **Sources**: `[app/src/_legacy/hooks/useWorkspace.tsx]`, `[app/src/_legacy/sections/Sidebar.tsx]`.

## DD-035: Operator broadcast as a first-class envelope

- **Decision**: The operator's "broadcast" message is a special mailbox envelope that fans out to all inboxes; coordinators interpret it (e.g., to start a roll-call).
- **Rationale**: Matches the demo flow where the operator messages a single coordinator and the coordinator polls all agents.
- **Sources**: `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`, `[video_transcript.txt §"Live swarm demo"]`.
