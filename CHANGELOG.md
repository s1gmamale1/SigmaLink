# Changelog

All notable changes to SigmaLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once tagged releases begin.

## [Unreleased]

## [0.1.0-alpha] - 2026-05-09

### Added

- Phase 1 foundation: Electron + Vite + React 19 + Tailwind 3 + shadcn UI shell with the Workspace launcher and Command Room rooms wired up.
- Provider registry of eleven CLI agents (Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Droid, Copilot, Aider, Continue, custom shell) with a PATH probe and install hints.
- Real PTY-backed terminal panes via `node-pty` and `@xterm/xterm`, with a ring-buffered history flushed to SQLite for cross-restart replay.
- Per-pane Git worktree pool under the Electron user-data directory, with branch namespace `sigmalink/<role>/<task>-<8char>`.
- SQLite persistence with Drizzle ORM and `better-sqlite3`; tables for `workspaces`, `agent_sessions`, `swarms`, `swarm_agents`, `swarm_messages`, `browser_tabs`, `skills`, `skill_provider_state`, `memories`, `memory_links`, `memory_tags`, `tasks`, `task_comments`, `session_review`, `kv`.
- Boot janitor that flips zombie `agent_sessions`/`swarms` rows on startup and best-effort `git worktree prune`s known repo roots.
- Cross-platform PTY plumbing: PATH+PATHEXT resolver routes `.cmd`/`.bat`/`.ps1` shims through their interpreters; default-shell preference order pwsh → powershell → cmd on Windows.
- Phase 2 Swarm Room: roster grid + side chat + recipient picker; `SIGMA::` line protocol with `SAY`/`ACK`/`STATUS`/`DONE`/`OPERATOR`/`ROLLCALL`/`SYSTEM` verbs; SQLite-backed `SwarmMailbox` with single-writer queue and JSONL debug mirrors; presets Squad/Team/Platoon/Legion with `defaultRoster()`.
- Phase 3 Browser Room: in-app `WebContentsView` per tab, address bar with URL normalization, tab strip, persisted `browser_tabs`; per-workspace Playwright MCP supervisor (`@playwright/mcp` over `npx -y`) with port discovery and 3-restart back-off; `claimDriver`/`releaseDriver` advisory lock with agent-driving overlay; per-provider MCP config writer (`.mcp.json`, `~/.codex/config.toml`, `~/.gemini/extensions/sigmalink-browser/`).
- Phase 4 Skills Room: drag-and-drop SKILL.md ingestion with frontmatter validation, deterministic per-folder content hash, atomic stage-then-rename to managed `<userData>/skills/<name>/`; per-provider fan-out to `~/.claude/skills/`, `~/.codex/skills/`, and synthesized Gemini extension manifests; per-provider toggle state and detail modal with built-in Markdown preview.
- Phase 5 Memory Room (SigmaMemory): wikilink notes stored as `<workspace>/.sigmamemory/<name>.md`; `memories`/`memory_links`/`memory_tags` schema with cascade deletes; in-memory inverted index; force-directed graph canvas (hand-rolled); in-process `sigmamemory` MCP server bundled as `electron-dist/mcp-memory-server.cjs` exposing 12 tools (`list_memories`, `read_memory`, `create_memory`, `update_memory`, `append_to_memory`, `delete_memory`, `search_memories`, `find_backlinks`, `list_orphans`, `suggest_connections`, `init_hub`, `hub_status`); per-workspace MCP supervisor with 3-restart linear back-off; combined browser+memory MCP entries written into provider configs.
- Phase 6 Review Room: session list with multi-select; unified/split diff renderer (no new deps); Tests/Notes/Conflicts tabs; `git merge-tree` conflict prediction with name-only intersection fallback; `commitAndMerge` + `batchCommitAndMerge` with worktree teardown; `dropChanges` and `pruneOrphans`.
- Phase 6 Tasks Room: 5-column Kanban (Backlog / In Progress / In Review / Done / Archived); `@dnd-kit/*` drag-and-drop card moves; swarm-roster drop rail that writes a `SAY` envelope `SIGMA::TASK <title>` into the assigned agent's mailbox; per-task comment thread.
- Phase 7 UI polish: four built-in themes (Obsidian, Parchment, Nord, Synthwave) driven by `:root[data-theme=...]` HSL tokens; first-run onboarding modal (welcome → detect agents → pick workspace); cmdk command palette bound to Cmd/Ctrl+K with nav, recent workspaces, theme switching, kill-all-PTY, ingest-skill, new-memory-note actions; sidebar with Σ monogram, manual + auto-collapse below 1100px, Radix tooltips on disabled rooms; universal `EmptyState` and `ErrorBanner` components; CSS-only motion (`sl-fade-in`, `sl-slide-up`, `sl-pane-enter`).
- Phase 8 visual test loop: `app/tests/e2e/smoke.spec.ts` Playwright `_electron` driver; 37-step visual sweep with screenshots committed to `docs/06-test/screenshots/` and machine-readable summary at `docs/06-test/visual-summary.json` / `visual-summary-acceptance.json`.
- IPC channel + event allowlists in `app/src/shared/rpc-channels.ts`; preload exposes a single generic `invoke` against the allowlist; renderer uses a typed Proxy bridge.
- Graceful shutdown on `before-quit`: `pty.killAll()`, MCP supervisor stops, `wal_checkpoint(TRUNCATE)`, DB close.
- Global RPC error toaster: any `{ok:false}` envelope from the preload bridge surfaces as a sonner toast; `rpcSilent` proxy for opt-out paths.

### Fixed

Phase 1.5 (Wave 5 — foundation patches):

- `P0-PTY-WIN-CMD` — Windows `.cmd`/`.bat`/`.ps1` shims now route through their interpreters via the PATH+PATHEXT resolver (`app/src/main/core/pty/local-pty.ts`).
- `P1-PROBE-EXEC-WIN` — provider `--version` probe uses the same resolver.
- `P1-PROBE-CMD-NOT-USED` — resolved `.cmd` path now used at spawn time.
- `P1-WORKTREE-LEAK` — launcher rolls back the worktree on PTY birth failure.
- `P1-PTY-FAILURE-NOT-DETECTED` — synthetic-exit path flips early-death panes to `status='error'` with surfaced text.
- `P1-DB-EXIT-DUPLICATE-LISTENER` — exit handler attached once per session.
- `P1-PTY-REGISTRY-LEAK` — graceful-exit `forget()` clears registry + listeners after a 200ms drain window; `killAll()` on `before-quit`.
- `P1-NO-CLOSE-PANE` — close button per pane + `REMOVE_SESSION` reducer action with auto-remove after 5s exit.
- `P1-INITIAL-PROMPT-DOUBLE` — initial prompt is now a single source-of-truth in the launcher.
- `P1-WORKTREE-PATH-COLLISION` — 8-char CSPRNG branch suffix + `fs.existsSync` retry.
- `P1-RUN-SHELL-TOKENISER` — state-machine tokenizer handles single/double quote escapes and concatenation.
- `P1-RUN-SHELL-EXEC-WIN` — `runShellLine` resolves Windows shims via the same PATH+PATHEXT helper.
- `P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST` — preload now rejects any invoke not in `CHANNELS`.
- `P1-DB-NEVER-CLOSED` — SQLite handle + WAL flushed on `before-quit`.
- `P2-PTY-CWD-NOT-VALIDATED` — cwd validated before spawn.
- `P2-EVENT-PAYLOAD-CASTING` — renderer guards on PTY data/exit payloads.
- `P2-RESIZE-DEBOUNCE` — terminal fit debounced on resize.
- `P2-TERMINAL-FIT-DURING-OPEN` — initial fit deferred until xterm finishes mounting.
- `P2-RPC-ERROR-STACK-LOST` — `RpcResult.stack?` carried through dev-only.

Wave 8 — visual-sweep bug-fix pass:

- `BUG-W7-001` (P1) — `workspaces.open` now activates the workspace; Launcher.tsx + state.tsx reducer aligned.
- `BUG-W7-005` (P1) — global sonner toaster on the renderer root surfaces every unhandled RPC rejection.
- `BUG-W7-006` (P1) — `wal_checkpoint(PASSIVE)` in `openWorkspace` so subsequent `workspaces.list` always sees the row; `swarms.create` returns a clearer error.
- `BUG-W7-002` (P2) — disabled sidebar buttons use `tabIndex={-1}`, no focus ring, Radix tooltip "Open a workspace to enable".
- `BUG-W7-003` (P2) — `ThemeProvider` validates kv via `isThemeId`; AppearanceTab gained "Reset to default" button.
- `BUG-W7-004` (P2) — sidebar tokens audited across all four themes; bg-sidebar resolves through `--sidebar-background`.
- `BUG-W7-008` (P2) — Tasks drawers gated on `state.room === 'tasks'`; cannot leak across rooms.
- `BUG-W7-011` (P2) — Launcher derives selection from `state.activeWorkspace`; single source of truth.
- `BUG-W7-013` (P2) — disabled-room rationale surfaced via the W7-002 tooltip.

### Deferred

- `P1-IPC-EVENT-RACE-CROSSWINDOW` — single-window product today; broadcast pattern only over-amplifies IPC under multiple BrowserWindows. Functional, not load-blocking.
- `P1-DRIZZLE-DEFAULT-OVERRIDE` — cosmetic clock-skew sub-second; no functional impact.
- Skills zip ingestion — would require a new dep (`adm-zip`/`unzipper`); controller surface and channel allowlist are wired and `ingestZip` throws a clear "drop the unzipped folder" error.
- `react-markdown` for SKILL.md preview — built a 60-line in-house renderer instead.
- Codex `allowed-tools` translation in Skills fan-out — `fm.allowedTools` is preserved verbatim; translation deferred.
- Project-scoped skills — v1 ships user-global skills only.
- Real CDP-attach / shared-Chromium for the Browser Room — v1 ships separate-Chromium mode behind the Playwright MCP supervisor.
- Per-workspace cookie/session isolation in the Browser Room — schema leaves room for `persist:ws-<id>` partitions.
- Hard-blocking lock on `claimDriver` — v1 surfaces the lock visually only.
- O(n²) repulsion in the Memory graph — Barnes-Hut quadtree deferred until workspaces routinely exceed 500 notes.
- Token-overlap variant of `suggest_connections` — current heuristic is co-tag overlap.
- Real-time `memory:changed` IPC from the spawned MCP child back to the GUI — GUI re-fetches on focus today.
- Three-way merge conflict editor and per-line review comments in the Review Room.
- `<Toaster>`-as-ack-channel for command-palette actions (only error toasts wired today).
- Cloud sync, account systems, billing, SSH remote workspaces, ticketing integrations (Linear/Jira/GitHub Issues), voice assistant, mobile clients — all out of scope for v1.
- Bernstein-style verifier loops on top of the swarm dispatcher — see PRODUCT_SPEC C-008.

### Known issues

- `BUG-W7-007` (P3) — PowerShell upgrade banner clutters every fresh shell pane; `POWERSHELL_UPDATECHECK=Off` not yet plumbed.
- `BUG-W7-009` (P3) — Tasks sidebar icon stroke weight inconsistent with siblings.
- `BUG-W7-010` (P3) — Test-only: native folder picker can't be scripted from Playwright; smoke harness substitutes `workspaces.open` and parses the raw envelope.
- `BUG-W7-012` (P3) — Onboarding Skip click occasionally drops mid-fade-in.
- `BUG-W7-014` (P3) — Browser room not reachable in test sweep when no workspace is activated; coupled to `BUG-W7-001` (now verified) but the test harness path remains.
- `BUG-W7-015` (P3) — Parchment "Launch N agents" CTA contrast nit.

[Unreleased]: https://github.com/s1gmamale1/SigmaLink/compare/v0.1.0-alpha...HEAD
[0.1.0-alpha]: https://github.com/s1gmamale1/SigmaLink/releases/tag/v0.1.0-alpha
