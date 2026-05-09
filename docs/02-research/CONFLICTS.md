# Conflicts Across Existing Docs

Places where the existing SigmaLink documents disagree. The build phase needs to pick one for each. Each entry lists the conflicting positions with citations and a recommended default (where one is obvious from precedence).

---

## C-001: Worktree branch naming pattern

- **Position A**: `sigmalink/<role>/<task>-<5char>` (project-namespaced, role-aware, with a 5-char suffix for uniqueness).
  - `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- **Position B**: `orchestrator/{agent-type}/{task-id}` (Bernstein-style, per-agent-type prefix).
  - `[research_extracted.txt §"Architecture Blueprint / Worktree Manager"]`
- **Position C**: `agent/task-001` (illustrative example in the deep dive).
  - `[research_extracted.txt §"Technical Deep Dive / Git Worktree Isolation"]`
- **Recommendation**: Position A. The rebuild plan is the more recent, project-specific document; the research blueprint and deep dive are illustrative.

---

## C-002: Maximum number of agent panes / sessions

- **Position A**: 16 simultaneous agent terminal sessions (BridgeSpace official).
  - `[video_transcript.txt §"BridgeSpace workspace demo"]`
  - `[docs/02-research/transcripts/launch-video-description.txt]`
  - `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`
- **Position B**: Workspace launcher presets cap at 16 (1, 2, 4, 6, 8, 10, 12, 14, 16).
  - `[REBUILD_PLAN.md §"Architecture (target)"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- **Position C**: Current MVP `CommandDock`'s "launch N" parser clamps at 12.
  - `[app/src/_legacy/sections/CommandDock.tsx]`
- **Position D**: Swarm roster preset slider goes "between 5 agents or 50 agents".
  - `[video_transcript.txt §"BridgeSwarm demo"]`
- **Recommendation**: Workspace panes cap at 16 (Positions A+B). Swarms can scale to 50 (Position D) — they share the cap with the renderer's pane grid only when displayed in the Command Room. Lift the MVP `CommandDock` parser cap from 12 → 16 to match.

---

## C-003: Demo swarm composition vs. coordinator addressing

- **Position A**: Demo swarm has **2 coordinators**, 5 builders, 1 reviewer, 2 scouts.
  - `[video_transcript.txt §"Live swarm demo"]`
- **Position B**: Same transcript later references "coordinator 10 sent a message to builder 3".
  - `[video_transcript.txt §"Live swarm demo"]`
- **Recommendation**: Treat as a transcription artifact (the demo had only 2 coordinators; "coordinator 10" is most likely a misheard "coordinator 1" or "coordinator one zero" referring to a different scene). The schema should still allow N coordinators (1..N). No code-impact decision needed beyond keeping the role count flexible.

---

## C-004: Provider list in v1

- **Position A**: Eight providers: Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Aider, Custom.
  - `[REBUILD_PLAN.md §"North Star"]`
- **Position B**: Six providers in the current MVP registry: Claude Code, Codex, Gemini CLI, Kimi CLI, Continue, Custom CLI.
  - `[app/src/_legacy/lib/providers.ts]`, `[app/README.md §"What is working now"]`
- **Position C**: BridgeSpace launch demo uses Claude, Codex, Gemini, and Cursor. `[video_transcript.txt §"BridgeSpace workspace demo"]`
- **Position D**: Emdash auto-detects 20+ providers (Claude Code, Codex, Gemini CLI, OpenCode, Amp, Droid, Hermes, Qwen, Cursor CLI, GitHub Copilot CLI, Aider, …).
  - `[research_extracted.txt §"Tier 1: Emdash"]`
- **Recommendation**: Ship the rebuild plan's eight (Position A) as definitions; auto-detect any additional providers from PATH (Emdash style). Drop `Continue` from the canonical list unless explicitly requested.

---

## C-005: Per-role provider mapping defaults

- **Position A**: Speaker's defaults from the demo:
  - Coordinators → Codex.
  - Builders → Claude.
  - Scouts → Gemini.
  - Reviewers → Codex.
  - `[video_transcript.txt §"BridgeSwarm demo"]`
- **Position B**: Rebuild plan does not prescribe defaults; the user picks per role at launch.
  - `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- **Recommendation**: Use the speaker's mapping as the default preset; allow per-role override at launch.

---

## C-006: Swarm "presets between 5 agents or 50 agents" vs. our discrete launcher presets

- **Position A**: BridgeSpace presents two roster presets — "5 agents" and "50 agents".
  - `[video_transcript.txt §"BridgeSwarm demo"]`
- **Position B**: Workspace launcher in the rebuild offers 1/2/4/6/8/10/12/14/16. (No swarm preset enumerated.)
  - `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- **Recommendation**: Adopt two clear swarm sizing presets (e.g., "Small ≈ 5", "Large ≈ 50") plus a custom roster builder. Keep the workspace pane presets distinct.

---

## C-007: BridgeMemory tool list — three named vs. our 12

- **Position A**: Research blueprint's deep dive names three shared-memory tools: `create_memory`, `search_memories`, `find_backlinks`.
  - `[research_extracted.txt §"Technical Deep Dive / MCP Protocol Integration"]`
- **Position B**: Research feature analysis references "12 MCP tools" without naming them.
  - `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`
- **Position C**: Rebuild plan enumerates our concrete 12: `create_memory`, `search_memories`, `find_backlinks`, `suggest_connections`, `update_memory`, `delete_memory`, `list_memories`, `get_memory`, `link_memories`, `get_graph`, `tag_memory`, `get_recent_memories`.
  - `[REBUILD_PLAN.md §"Phase 4"]`
- **Recommendation**: Position C is the source of truth. The research blueprint's three are a subset.

---

## C-008: Orchestrator pattern — manual / auto / verifier loop

- **Position A**: Emdash and Claude Squad — manual orchestration; human dispatches.
  - `[research_extracted.txt §"Comparative Analysis Matrix / Table 2"]`
- **Position B**: Bernstein — auto, deterministic, zero-token coordination, Janitor verification.
  - `[research_extracted.txt §"Tier 4: Bernstein"]`, `[research_extracted.txt §"Implementation Roadmap / Phase 3"]`
- **Position C**: Research blueprint orchestrator engine — verification loop Execute→Verify→Retry.
  - `[research_extracted.txt §"The Orchestrator Layer"]`
- **Position D**: Rebuild plan does not state which pattern wins. Phase 2 builds a swarm that "communicates" via mailbox, with operator broadcast and roll-call.
  - `[REBUILD_PLAN.md §"Phase 2 — Swarm core"]`
- **Recommendation**: Start with operator-supervised orchestration via the mailbox (Phase 2). Layer a Bernstein-style verifier loop later (Phase 3+) only if the swarm primitives prove sturdy.

---

## C-009: Phase 4 explicitly drops SSH UI; Phase 4 of research keeps it

- **Position A**: Rebuild plan Out-of-scope: SSH remote workspaces (port abstraction, no UI).
  - `[REBUILD_PLAN.md §"Out of scope"]`
- **Position B**: Research roadmap Phase 4: SSH remote development support.
  - `[research_extracted.txt §"Implementation Roadmap / Phase 4"]`
- **Recommendation**: Position A wins for v1.

---

## C-010: Phase 4 explicitly drops ticketing; Phase 4 of research adds it

- **Position A**: Rebuild plan Out-of-scope (no explicit ticketing mention, but the rebuild's Phase 4 lists Memory + Review + Polish only).
  - `[REBUILD_PLAN.md §"Phase 4 — Memory + Review + Polish"]`
- **Position B**: Research roadmap Phase 4: ticket integration (Linear, Jira, GitHub Issues).
  - `[research_extracted.txt §"Implementation Roadmap / Phase 4"]`
- **Recommendation**: Defer ticketing. Not in the rebuild plan; not blocking the ADE; touches OAuth flows that conflict with the local-first stance.

---

## C-011: Foundation strategy — fork Emdash vs. greenfield

- **Position A**: Research primary recommendation: fork Emdash, build orchestrator on top.
  - `[research_extracted.txt §"Conclusions / Primary Recommendation"]`
- **Position B**: Research alternative: greenfield using Electron + React + node-pty + xterm.js + SQLite + custom orchestrator.
  - `[research_extracted.txt §"Conclusions / Alternative: Greenfield Build"]`
- **Position C**: Rebuild plan: ground-up rebuild that **borrows patterns from Emdash** but reuses the existing SigmaLink scaffolding. Direct portable code patterns from Emdash require NOTICE attribution.
  - `[REBUILD_PLAN.md §"Header / Synthesis"]`, `[REBUILD_PLAN.md §"Legal/IP guardrails"]`
- **Recommendation**: Position C is the chosen path. We are neither forking Emdash nor going clean-room — we port specific patterns under attribution.

---

## C-012: Subtask success criteria — boilerplate vs. per-subtask

- **Position A**: Current MVP defaults `successCriteria` to a constant string: "Code compiles and tests pass".
  - `[app/src/_legacy/sections/SwarmRoom.tsx]`
- **Position B**: Research delegation contract treats `success_criteria` as a real per-subtask field.
  - `[research_extracted.txt §"The Orchestrator Layer"]`
- **Recommendation**: Position B. The rebuild's swarm UI must capture per-subtask success criteria, not a constant.

---

## C-013: Persistence locus for workspace state — localStorage vs. SQLite

- **Position A**: Current MVP persists `repoPath`, `repoRoot`, `baseBranch`, and saved workspaces in localStorage.
  - `[app/src/_legacy/hooks/useWorkspace.tsx]`, `[app/src/_legacy/sections/Sidebar.tsx]`
- **Position B**: Rebuild plan plans a SQLite `workspaces` table and persists "everything (workspaces, tasks, conversations, messages, terminals)" in SQLite.
  - `[REBUILD_PLAN.md §"North Star"]`, `[REBUILD_PLAN.md §"Phase 1 — Foundation"]`
- **Recommendation**: SQLite is the system of record (Position B). Optionally keep a thin localStorage cache for last-active selections, but the durable list of workspaces lives in SQLite.

---

## C-014: Renderer "rooms" set — three vs. five

- **Position A**: BridgeSpace docs and current MVP App: three rooms (Command, Swarm, Review).
  - `[research_extracted.txt §"BridgeSpace Feature Analysis / Core Architecture Overview"]`, `[app/src/_legacy/App.tsx]`
- **Position B**: Rebuild plan: five rooms (workspace / swarm / review / memory / browser).
  - `[REBUILD_PLAN.md §"Architecture (target)"]`
- **Recommendation**: Position B. The rebuild adds Memory and Browser as first-class rooms.

---

## C-015: "Workspace" terminology — room vs. environment

- **Position A**: Rebuild plan calls the new room `workspace` (which presumably wraps the launcher + Command Room).
  - `[REBUILD_PLAN.md §"Architecture (target)"]`
- **Position B**: Existing MVP keeps the room named `command` (Command Room) and uses `workspace` to mean the open-folder context.
  - `[app/src/_legacy/App.tsx]`
- **Recommendation**: Resolve naming early to avoid double meaning. Suggested split: keep `command` as the terminal-grid room; introduce a separate `launcher` route for the preset/agent picker; reserve "workspace" for the user-level construct (folder + repo + saved entries).
