# SigmaLink — Build Blueprint

Compiled: 2026-05-09
Phase scope: from "Phase 1.5 foundation patches" through "Phase 8 visual + bug-fix loops". Every phase is sized for parallel agent execution and lists files, deps, schema migrations, IPC channels, acceptance criteria, agent count, and dependencies.

All file paths are absolute references to `app/<...>` under the repo root `C:/Users/DaddysHere/Documents/SigmaLink/`.

---

## Phase 1.5 — Foundation patches (apply BEFORE any new feature work)

**Goal**: bring the existing Phase-1 codebase to the state where Windows users can launch agents, sessions are observable, the renderer can close panes, and the preload is allow-listed. Without this, every later phase compounds these defects.

### Bugs in scope

Every P0 plus the highest-impact P1 bugs from `docs/01-investigation/02-bug-sweep.md`.

| bug-id | file:line | patch summary | owner-agent prompt |
|---|---|---|---|
| P0-PTY-WIN-CMD | `app/src/main/core/pty/local-pty.ts:41-56` | Add `resolveForCurrentOS(command)` shared helper that walks PATH+PATHEXT and returns either an `.exe` path, a wrapped `cmd.exe /d /s /c <cmd>` for `.cmd/.bat`, or a wrapped `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <cmd>` for `.ps1`. Route every spawn through it. | "You are Builder-Win. Implement `resolveForCurrentOS` in `app/src/main/core/pty/spawn-resolve.ts` and replace `platformAwareSpawnArgs` to call it. Add a unit test that, on win32, returns a `.cmd` path when only `.cmd` exists on a fake PATH." |
| P1-PROBE-EXEC-WIN | `app/src/main/core/providers/probe.ts:29-32` | Pass the resolved path (not the bare command) into the version probe. | "Builder-Win: thread `resolved` through `execCmd`. Add a probe test that returns a non-empty `version` for a synthetic `.cmd` shim." |
| P1-PROBE-CMD-NOT-USED | `app/src/main/core/providers/probe.ts:21-39` and the launcher | Persist `resolvedPath` in `providers_state.resolved_path` and have the launcher prefer it over `provider.command`. | "Builder-Win: extend `providers_state` (Phase 2 schema migration) and the launcher to use the resolved path." |
| P1-WORKTREE-LEAK | `app/src/main/core/workspaces/launcher.ts:54-90` | Wrap each pane in try/catch; on failure call `worktreePool.remove(repoRoot, worktreePath)` and either skip the DB insert or insert with `status='error'`. | "Builder-Foundation: refactor `executeLaunchPlan` so each pane is a unit with explicit cleanup; add a test where a forced spawn failure leaves no worktree on disk and no DB row." |
| P1-PTY-FAILURE-NOT-DETECTED | `app/src/main/core/pty/local-pty.ts:66-72`, `registry.ts:35-66` | Wrap `nodePty.spawn` in try/catch; emit synthetic `pty:exit` on failure; in the launcher mark sessions `error` if exit happens within 1s with code <0. | "Builder-Foundation: ensure spawn failures surface as `pty:exit` and DB transitions to `error`." |
| P1-PTY-REGISTRY-LEAK | `app/src/main/core/pty/registry.ts:94-100` | Call `forget` from the renderer "Close pane" affordance and from the post-exit grace timer (30 s). | "Builder-Foundation: wire `pty.forget` from renderer Close button and from a 30s post-exit timer." |
| P1-NO-CLOSE-PANE | `app/src/renderer/features/command-room/CommandRoom.tsx:124-134` | Add a "remove" action; reducer gains `REMOVE_SESSION`. | "Builder-UI: ship a Close (X) icon per pane that calls `pty.forget` and dispatches `REMOVE_SESSION`." |
| P1-IPC-EVENT-RACE-CROSSWINDOW | `app/src/main/rpc-router.ts:20-24`, `app/src/renderer/features/command-room/Terminal.tsx:75-93` | Per-window per-session subscription registry in main; only emit to subscribed webContents. | "Builder-Foundation: replace `broadcast` with `emitTo(webContentsId, sessionId, payload)`." |
| P1-DB-NEVER-CLOSED | `app/electron/main.ts:59-61`, `app/src/main/core/db/client.ts:50-63` | `before-quit` handler closes DB, kills surviving PTYs, removes orphan worktrees. | "Builder-Foundation: ship `quit-cleanup.ts`." |
| P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST | `app/electron/preload.ts:6-13` | Generate ALLOWED_CHANNELS from `router-shape.ts`; reject anything else. | "Builder-Sec: ship `preload-allowlist.ts`." |
| P1-WORKTREE-PATH-COLLISION | `app/src/main/core/git/git-ops.ts:35-39` | Widen suffix to 8 base-36 chars; check fs existence + retry. | "Builder-Foundation: change suffix to `randomUUID().slice(0,8)`; retry on `fatal: ... already exists`." |
| P1-RUN-SHELL-TOKENISER | `app/src/main/core/git/git-ops.ts:115-124` | Replace `runShellLine(string)` with `runArgv(cwd, args[])`; remove the regex tokeniser. | "Builder-Sec: change the RPC to take `args[]` not a line; update callers." |
| P1-RUN-SHELL-EXEC-WIN | `app/src/main/core/git/git-ops.ts:121-122` | Reuse the new `resolveForCurrentOS`. | "Builder-Win: route `runArgv` through the resolver." |
| P1-DB-EXIT-DUPLICATE-LISTENER | `app/src/main/core/workspaces/launcher.ts:116-125` | Have the launcher subscribe to the registry's exit broadcast, not directly on the PtyHandle. | "Builder-Foundation: refactor to single source of exit truth." |
| P1-INITIAL-PROMPT-DOUBLE | `app/src/main/rpc-router.ts:63-67`, launcher | One owner of initial-prompt write. | "Builder-Foundation: keep launcher as sole owner; remove from controller." |
| P1-DRIZZLE-DEFAULT-OVERRIDE | `app/src/main/core/db/schema.ts:21-26`, `factory.ts:43-54` | Drop the JS `now`; rely on `unixepoch()*1000`. | "Builder-Foundation: remove redundant timestamp pass-through." |

### New / modified files

- **NEW** `app/src/main/core/pty/spawn-resolve.ts` — the shared helper.
- **NEW** `app/src/main/lib/quit-cleanup.ts` — graceful shutdown.
- **NEW** `app/src/shared/router-shape.ts` (extended) + generated `app/src/shared/preload-allowlist.ts`.
- **MOD** `app/src/main/core/pty/local-pty.ts`, `registry.ts`.
- **MOD** `app/src/main/core/providers/probe.ts`.
- **MOD** `app/src/main/core/workspaces/launcher.ts`.
- **MOD** `app/src/main/core/git/git-ops.ts`.
- **MOD** `app/electron/preload.ts`, `app/electron/main.ts`.
- **MOD** `app/src/renderer/features/command-room/CommandRoom.tsx`, `Terminal.tsx`, `app/src/renderer/app/state.tsx`.

### New dependencies
- None. (All fixes use stdlib + existing deps.)

### New DB tables / schema migrations
- Migration `0002_phase15_patches`: add `providers_state.resolved_path TEXT`. (The full `providers_state` table is introduced here so we stop persisting probe results in `kv`.)

### New IPC channels
- `pty.forget` (already declared, now wired).
- No other additions; this phase is a stabilisation pass.

### Acceptance criteria

1. T1.1 from `04-test-plan.md` passes on Win11 (Claude Code launches, no "error code: 2" text).
2. T1.5: every found provider has a non-empty `version` string.
3. T2.4: a forced spawn failure leaves no worktree directory and no `agent_sessions` row with `status='running'`.
4. T3.4: spawn-time failure produces `pty:exit` and DB row `status='error'` within 1 second.
5. T3.3: `pty.list()` no longer contains the session id after Close pane is clicked.
6. T6.2: `window.sigma.invoke('not.a.channel')` is rejected client-side and never reaches main.
7. T7.1: graceful Cmd-Q updates running sessions to `exited` or `error` and removes orphan worktrees.
8. New unit tests pass: `spawn-resolve.test.ts` (Windows path matrix), `git-ops.test.ts` (collision retry).

### Estimated agent count
- **5** in parallel: Builder-Win (PTY/Provider Windows fixes), Builder-Foundation (launcher/PTY lifecycle/DB lifecycle), Builder-Sec (preload allowlist + tokeniser), Builder-UI (Close pane affordance), Reviewer (test plan T0–T9 sanity).

### Dependencies on earlier phases
- None. This phase rebases onto Phase-1 main and must merge before Phase 2.

---

## Phase 2 — Swarm Room + mailbox bus

**Goal**: launch a swarm of role-bearing agents that talk through the file-system mailbox; tail the bus into a side-chat panel; broadcast and roll-call work end-to-end.

### New / modified files

- **NEW** `app/electron/core/swarm/mailbox.ts` — JSONL writer/reader with O_APPEND, ULID ids.
- **NEW** `app/electron/core/swarm/bus.ts` — file-watcher that tails inboxes and outbox, mirrors into SQLite, emits `swarm:message` events.
- **NEW** `app/electron/core/swarm/launcher.ts` — boots a swarm: creates `<userData>/swarms/<id>/{inboxes,brain}`, materialises `swarm_agents` rows, spawns one PTY per agent, writes per-agent `mcp.json` with mailbox tool stub.
- **NEW** `app/electron/core/swarm/orchestrator.ts` — reduce envelope kinds into observable state (status, role-totals, file locks).
- **NEW** `app/src/shared/swarm.ts` — Role enum, MailboxEnvelope schema (zod), preset definitions (Squad/Team/Platoon/Legion).
- **NEW** `app/electron/controllers/swarms.ts` — RPC controller wiring `swarms.*` methods.
- **NEW** `app/src/renderer/features/swarm-room/SwarmRoom.tsx` — top-level layout.
- **NEW** `app/src/renderer/features/swarm-room/RosterSetup.tsx` — preset picker + per-role provider override + Custom roster builder.
- **NEW** `app/src/renderer/features/swarm-room/MissionEditor.tsx` — mission text + supporting-context drop zone.
- **NEW** `app/src/renderer/features/swarm-room/SideChat.tsx` — live tail viewer with role/agent filters.
- **NEW** `app/src/renderer/features/swarm-room/AddressBook.tsx` — per-agent DM lanes.
- **NEW** `app/src/renderer/features/swarm-room/RoleTotals.tsx` — message-count totals per role.
- **NEW** `app/src/renderer/features/swarm-room/BroadcastBar.tsx` — operator broadcast button + roll-call.
- **MOD** `app/src/renderer/features/sidebar/Sidebar.tsx` — un-grey the Swarm tile.

### New dependencies
- `ulid` (id generation).
- `zod` (schemas; if not already present).
- `chokidar` (file watcher; node-pty already pulls it transitively but pin it directly).

### New DB tables / schema migrations
- Migration `0003_swarm`: tables `swarms`, `swarm_agents`, `swarm_messages` (per `PRODUCT_SPEC.md` §10).

### New IPC channels
- `swarms.create`, `swarms.list`, `swarms.get`, `swarms.end`.
- `swarms.broadcast`, `swarms.rollCall`, `swarms.send`, `swarms.tail`.
- Events: `swarm:message`, `swarm:agent_status`.

### Acceptance criteria

1. Operator picks Squad preset → launcher boots 5 PTYs with role-specific initial prompts; `swarm_agents` shows 1 coordinator + 2 builders + 1 scout + 1 reviewer.
2. Operator broadcast appears in every inbox JSONL within 200 ms and in every agent's pane within 1 s.
3. Roll-call: clicking Roll Call writes one `roll_call` envelope to all non-coordinator inboxes; replies are aggregated and a single `status` envelope appears in the side chat within the 60 s deadline.
4. SideChat live-updates without polling; mailbox file deletion+re-create rebuilds state from `swarm_messages` mirror.
5. Killing the app mid-swarm and restarting reconstructs `swarm_messages` from the on-disk JSONL with no loss.
6. Custom roster builder respects the 50-agent cap.

### Estimated agent count
- **6** in parallel: Builder-Mailbox, Builder-Bus, Builder-Launcher (swarm), Builder-UI (RosterSetup + SideChat), Builder-UI-2 (MissionEditor + AddressBook + Broadcast), Reviewer.

### Dependencies on earlier phases
- Phase 1.5. The mailbox launcher reuses the patched `pty.create` and `worktreePool`. The `swarm_messages` table reuses the patched DB lifecycle.

---

## Phase 3 — In-app browser + Playwright MCP supervisor

**Goal**: ship the Browser room with a controllable Chromium pane and a per-workspace supervised Playwright MCP server; agents can drive the browser visibly.

### New / modified files

- **NEW** `app/electron/core/browser/view-host.ts` — owns one `WebContentsView` per active browser tab; manages session partitioning, attachment, debugger mounting.
- **NEW** `app/electron/core/browser/cdp-port.ts` — port allocator (random in `49152..65535`, fallbacks on collision).
- **NEW** `app/electron/core/browser/playwright-supervisor.ts` — spawns `npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<port>` per workspace; restarts on crash; tears down with the workspace.
- **NEW** `app/electron/core/browser/element-pick.ts` — runs CSS selector synthesis script in the page; returns selector + bounding rect + screenshot blob.
- **NEW** `app/electron/controllers/browser.ts` — RPC controller for `browser.*`.
- **NEW** `app/electron/core/mcp/agent-config-writer.ts` — writes provider-native MCP configs that include a Playwright entry pointing to the workspace's MCP HTTP port.
- **NEW** `app/src/renderer/features/browser/BrowserRoom.tsx` — tab strip + address bar + chrome.
- **NEW** `app/src/renderer/features/browser/BrowserTabBar.tsx`.
- **NEW** `app/src/renderer/features/browser/AddressBar.tsx`.
- **NEW** `app/src/renderer/features/browser/AgentDriveIndicator.tsx`.

### New dependencies
- `@playwright/mcp` (peer expected on PATH via `npx`; not bundled).
- No new direct deps; Electron `WebContentsView` is built in.

### New DB tables / schema migrations
- Migration `0004_browser`: tables `browser_tabs`, `browser_history`, plus `workspaces.cdp_port INTEGER` column.

### New IPC channels
- `browser.openTab`, `browser.closeTab`, `browser.navigate`, `browser.back`, `browser.forward`, `browser.reload`, `browser.attachDevTools`, `browser.activateDesignTool`, `browser.pickElement`, `browser.cdpEndpoint`.
- Events: `browser:driving`.

### Acceptance criteria

1. Opening the Browser room opens a tab pointing to a configurable home URL (default `about:blank`).
2. The supervisor process is spawned lazily on first browser-tab open per workspace and is killed on workspace close.
3. A Claude agent in the same workspace, given a stub MCP config, can call `browser_navigate(url)` and the visible tab navigates.
4. The agent-drive indicator turns warm-amber within 100 ms of an MCP call and clears within 500 ms of completion.
5. CDP port stays stable across the workspace lifetime and is freed on close.
6. Navigation history is persisted; back/forward respect it.

### Estimated agent count
- **5** in parallel: Builder-View, Builder-Supervisor, Builder-MCPConfig, Builder-UI, Reviewer.

### Dependencies on earlier phases
- Phase 1.5 (preload allowlist), Phase 2 (per-workspace supervisor lifecycle parallels per-swarm bus lifecycle).

---

## Phase 4 — Skills drag-and-drop + per-provider fan-out

**Goal**: drop a SKILL.md or skill folder into the app, validate it, store canonical, fan out to provider-native paths.

### New / modified files

- **NEW** `app/src/shared/skills.ts` — frontmatter Zod schema, validator helpers.
- **NEW** `app/electron/core/skills/parser.ts` — YAML frontmatter parse + body extraction.
- **NEW** `app/electron/core/skills/validator.ts` — Zod + path-glob check + shell-allowlist.
- **NEW** `app/electron/core/skills/store.ts` — copy to `<userData>/skills/<id>/`, idempotent.
- **NEW** `app/electron/core/skills/fanout.ts` — three target writers: Claude (copy), Codex (copy + tool translation), Gemini (synthesize `extension.json`).
- **NEW** `app/electron/core/skills/loader.ts` — drag entry point: detects single file vs folder vs multi-skill plugin, returns per-skill outcomes.
- **NEW** `app/electron/controllers/skills.ts`.
- **NEW** `app/src/renderer/features/skills/SkillsRoom.tsx`.
- **NEW** `app/src/renderer/features/skills/SkillDropZone.tsx` — global Shift+drop overlay + per-room drop zone.
- **NEW** `app/src/renderer/features/skills/SkillCard.tsx`.
- **MOD** `app/electron/preload.ts` — already exposes `getPathForFile`; this phase relies on it.

### New dependencies
- `js-yaml` (frontmatter parser).
- `picomatch` (path glob compiler).

### New DB tables / schema migrations
- Migration `0005_skills`: `skills` table.

### New IPC channels
- `skills.list`, `skills.ingest`, `skills.remove`, `skills.setProviderEnabled`.
- Events: `skills:changed`.

### Acceptance criteria

1. Dropping a folder containing one `SKILL.md` ingests one skill; the canonical copy lives at `<userData>/skills/<name>/SKILL.md`.
2. Dropping a multi-skill plugin layout (`skills/<a>/SKILL.md`, `skills/<b>/SKILL.md`) ingests both with one drop.
3. Validation errors are returned per-skill; partial success allowed.
4. Toggling Claude on for a skill creates `~/.claude/skills/<id>/SKILL.md`; toggling off removes it; the canonical copy is unaffected.
5. Codex fan-out preserves `allowed-tools` after translation.
6. Gemini fan-out emits a syntactically valid `extension.json`.
7. If two of three fan-out targets succeed and one fails, the canonical copy still installs and the failure is reported per provider.

### Estimated agent count
- **4** in parallel: Builder-Parser, Builder-Fanout, Builder-UI, Reviewer.

### Dependencies on earlier phases
- Phase 1.5, Phase 3 (the agent-config writer overlaps with Phase 4 fan-out conceptually; we keep them separate but reuse types).

---

## Phase 5 — SigmaMemory MCP server + notes UI + graph view

**Goal**: ship the 12-tool MCP server, the Memory room with editor and force-directed graph, and the disk-and-DB transactional write strategy.

### New / modified files

- **NEW** `app/electron/core/memory/server.ts` — in-process stdio MCP server that registers all 12 tools.
- **NEW** `app/electron/core/memory/storage.ts` — disk read/write (atomic temp+rename), markdown frontmatter handling.
- **NEW** `app/electron/core/memory/index.ts` — SQLite-side index, FTS5 search, edge rebuild.
- **NEW** `app/electron/core/memory/wikilinks.ts` — `[[Title]]` parser with `|alias` and `#section` support.
- **NEW** `app/electron/core/memory/graph.ts` — graph queries for the canvas.
- **NEW** `app/electron/controllers/memory.ts` — RPC mirror of MCP tools.
- **NEW** `app/src/renderer/features/memory/MemoryRoom.tsx`.
- **NEW** `app/src/renderer/features/memory/NoteList.tsx`.
- **NEW** `app/src/renderer/features/memory/NoteEditor.tsx` — markdown editor with wikilink autocomplete.
- **NEW** `app/src/renderer/features/memory/BacklinksPanel.tsx`.
- **NEW** `app/src/renderer/features/memory/SuggestPanel.tsx`.
- **NEW** `app/src/renderer/features/memory/MemoryGraphCanvas.tsx` — D3 / `react-force-graph` view.
- **NEW** `app/src/renderer/features/memory/TagFilter.tsx`.

### New dependencies
- `@modelcontextprotocol/sdk` (MCP server runtime).
- `react-force-graph` (or `d3-force` + custom canvas; pick `react-force-graph-2d` for v1).
- `markdown-it` + `markdown-it-wikilinks` (rendering); editor uses `@codemirror/lang-markdown`.

### New DB tables / schema migrations
- Migration `0006_memory`: `memories`, `memory_edges`, FTS5 virtual table `memories_fts`.

### New IPC channels
- `memory.create_memory` … `memory.get_recent_memories` (12 methods).
- `memory.openHub`, `memory.exportGraph`.
- Events: `memory:changed`.

### Acceptance criteria

1. `create_memory("X","body with [[Y]]")` creates the markdown file, the DB row, and a `wikilink` edge to memory `Y` if it exists (otherwise leaves the edge dangling and reports it).
2. `update_memory` triggers a single SQLite transaction that rebuilds the outgoing edges and updates `updated_at`.
3. Concurrent `update_memory` calls serialise via SQLite; no duplicate edges; no orphaned files.
4. `search_memories` returns title hits before body hits, ties broken by recency.
5. `get_graph(center, depth=2)` returns the centre + its 1- and 2-hop neighbours.
6. The renderer graph view renders 1,000 nodes at 30+ FPS on a 2024-class laptop.
7. If a disk write fails after the SQLite transaction starts, both are rolled back; if a SQLite commit fails after the temp file is renamed, the file is deleted in the finally block.

### Estimated agent count
- **6** in parallel: Builder-Server (MCP), Builder-Storage, Builder-Index, Builder-UI-Editor, Builder-UI-Graph, Reviewer.

### Dependencies on earlier phases
- Phase 1.5.

---

## Phase 6 — Review Room rebuild + Tasks/Kanban

**Goal**: replace the legacy Review Room with a real two-pane diff viewer + command runner + commit/merge; ship the Tasks Kanban with file-ownership locks and assignee→agent linkage.

### New / modified files

- **NEW** `app/electron/core/review/items.ts` — assemble `ReviewItem` from a session: `git status`, file list, prior comments and command runs.
- **NEW** `app/electron/core/review/runner.ts` — execute test/lint commands inside the worktree (using the resolved spawn helper); persist runs.
- **NEW** `app/electron/core/review/decide.ts` — approve/reject; on approve, call `git.commitAndMerge`.
- **NEW** `app/electron/controllers/review.ts`.
- **NEW** `app/electron/controllers/tasks.ts`.
- **NEW** `app/electron/core/tasks/locks.ts` — file-ownership lock service (rule 3).
- **NEW** `app/src/renderer/features/review-room/ReviewRoom.tsx`.
- **NEW** `app/src/renderer/features/review-room/DiffViewer.tsx` (Monaco diff).
- **NEW** `app/src/renderer/features/review-room/CommandRunner.tsx`.
- **NEW** `app/src/renderer/features/review-room/CommentsPanel.tsx`.
- **NEW** `app/src/renderer/features/tasks/TasksRoom.tsx`.
- **NEW** `app/src/renderer/features/tasks/KanbanColumn.tsx`.
- **NEW** `app/src/renderer/features/tasks/TaskCard.tsx`.
- **NEW** `app/src/renderer/features/tasks/TaskDetail.tsx` (side panel).

### New dependencies
- `monaco-editor` (diff). Alternative: `react-diff-view` if Monaco bundle size is unacceptable; tentative pick: Monaco for v1.
- `@dnd-kit/core` + `@dnd-kit/sortable`.

### New DB tables / schema migrations
- Migration `0007_review_tasks`: `review_items`, `review_command_runs`, `review_comments`, `tasks`, `task_events`, `task_file_locks`.

### New IPC channels
- `review.list`, `review.get`, `review.runCommand`, `review.addComment`, `review.decide`.
- `tasks.list`, `tasks.create`, `tasks.update`, `tasks.delete`, `tasks.assign`, `tasks.transition`, `tasks.lockFiles`.
- Events: `review:changed`, `tasks:changed`.

### Acceptance criteria

1. Approving a review with a clean working tree commits and merges the worktree branch into the workspace base branch; the worktree is removed.
2. Rejecting a review surfaces the rejection in the assignee's swarm inbox (if any) as a `directive` envelope.
3. Dragging a Task card across columns persists `tasks.status` immediately and emits `task_events`.
4. Locking files for a task fails with conflict details if any file is already owned by another non-completed task.
5. The diff viewer renders unified or split mode at user choice; large diffs (> 16 MiB) stream incrementally instead of truncating silently (fixes P3-GIT-DIFF-MAX-BUFFER).
6. The runner uses the resolved spawn helper (no shell tokeniser regressions).

### Estimated agent count
- **6** in parallel: Builder-ReviewBackend, Builder-ReviewUI, Builder-TasksBackend, Builder-TasksUI, Builder-Locks, Reviewer.

### Dependencies on earlier phases
- Phase 1.5, Phase 2 (rejection feedback writes to the swarm bus when applicable).

---

## Phase 7 — UI polish: theme catalog, command palette, layout refinements, animations

**Goal**: ship the 25+ themes via CSS custom properties; ship Cmd+K palette; refine layouts; tighten motion.

### New / modified files

- **NEW** `app/src/renderer/styles/themes/_index.css` (manifest).
- **NEW** `app/src/renderer/styles/themes/<id>.css` — one file per theme. Initial set: 20 dark + 5 light = 25 themes (slugs: `obsidian`, `midnight-blue`, `nordic`, `dracula`, `monokai-pro`, `tokyo-night`, `gruvbox-dark`, `synthwave-84`, `sigma-amber`, `sigma-cool`, `solarized-dark`, `material-darker`, `night-owl`, `palenight`, `one-dark`, `cobalt2`, `andromeda`, `cyberpunk`, `oceanic-next`, `panda`, `solarized-light`, `github-light`, `quiet-light`, `tomorrow`, `tokyo-night-light`).
- **NEW** `app/src/renderer/features/command-palette/CommandPalette.tsx` — global shortcut handler + grouped result list.
- **NEW** `app/src/renderer/features/command-palette/registry.ts` — palette action contributions per room.
- **NEW** `app/src/renderer/features/settings/ThemePicker.tsx`.
- **NEW** `app/src/renderer/features/settings/ShortcutEditor.tsx`.
- **NEW** `app/src/renderer/styles/motion.css` — durations and easings as CSS variables.
- **MOD** every room file for tightened spacing using the 4 px scale.

### New dependencies
- `cmdk` (or rely on existing shadcn `Command`).
- `framer-motion` (for the Jump-to-pane and pane-pulse motion).

### New DB tables / schema migrations
- None. Settings live in `kv`.

### New IPC channels
- `settings.get`, `settings.set`, `settings.allTheme`, `settings.setTheme`.

### Acceptance criteria

1. Switching themes updates the entire UI within one frame; no layout shift.
2. Cmd+K opens within 50 ms; first key types into the input within 16 ms.
3. The palette finds rooms, recent workspaces, providers, skills, tasks, and memory titles.
4. All animations conform to the 120/180/240 ms scale; no animation longer than 240 ms outside hero glow pulses.
5. Spacing audit: every component uses tokens, no raw `px` values outside the theme/motion files.

### Estimated agent count
- **5** in parallel: Builder-Themes, Builder-Palette, Builder-Motion, Builder-Settings, Reviewer.

### Dependencies on earlier phases
- All previous phases (the palette indexes their actions).

---

## Phase 8 — Visual test + bug-fix loops

**Goal**: stabilise. Drive the test plan in `docs/01-investigation/04-test-plan.md` to green on Win11, macOS, and Linux. Capture and triage every visual regression. Stand up CI snapshots.

### New / modified files

- **NEW** `app/tests/e2e/*.spec.ts` — Playwright-driven Electron E2E (smoke per room).
- **NEW** `app/tests/visual/*.spec.ts` — visual regression suite using Playwright screenshot comparison.
- **NEW** `app/tests/unit/*.test.ts` — coverage for `spawn-resolve`, `git-ops`, `mailbox`, `wikilinks`, `validator`, `locks`.
- **NEW** `.github/workflows/ci.yml` — matrix of {win-latest, macos-latest, ubuntu-latest} × {unit, e2e}.
- **NEW** `app/scripts/visual-baseline.cjs` — manage baselines.
- **MOD** every file as bugs are found.

### New dependencies
- `vitest`.
- `@playwright/test`.

### New DB tables / schema migrations
- None.

### New IPC channels
- None.

### Acceptance criteria

1. T1 through T12 from `04-test-plan.md` all pass on the matrix.
2. Visual regression suite has baselines for every room in `obsidian` (default dark) and `solarized-light` themes.
3. Unit test coverage ≥ 70 % on pure-logic modules (resolver, mailbox, wikilinks, validator, locks).
4. Bug bash queue contains zero P0/P1 entries open at sign-off.
5. The two longest-running E2E specs complete under 90 s.

### Estimated agent count
- **8** in parallel: 1 per OS × 2 (unit + e2e), 1 visual lead, 1 bug-bash triage, 1 documentation. (Lead agents can fan out to additional Builders for spike fixes.)

### Dependencies on earlier phases
- All. This phase is the merge gate for v1.
