# Changelog

All notable changes to SigmaLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once tagged releases begin.

## [Unreleased]

### Added

- Phase 1 foundation: Electron + Vite + React 19 + Tailwind 3 + shadcn UI shell with the Workspace launcher and Command Room rooms wired up.
- Provider registry of eleven CLI agents (Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Droid, Copilot, Aider, Continue, custom shell) with a PATH probe and install hints.
- Real PTY-backed terminal panes via `node-pty` and `@xterm/xterm`, with a ring-buffered history flushed to SQLite for cross-restart replay.
- Per-pane Git worktree pool under the Electron user-data directory, with branch namespace `sigmalink/<role>/<task>-<8char>`.
- SQLite persistence with Drizzle ORM and `better-sqlite3`; first migration covers `workspaces`, `projects`, `tasks`, `conversations`, `messages`, `terminals`, `skills`, and `memories`.
- Build pipeline: esbuild for `electron/main.ts` + `electron/preload.ts`, Vite for the renderer, `electron-builder` for packaging (Windows NSIS + portable, macOS DMG + zip).
- Surface documentation: top-level README, LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, ATTRIBUTIONS, CHANGELOG, GitHub issue and PR templates, `docs/README.md` index.

### Changed

- Replaced the legacy MVP `app/README.md` with the current Phase-1 reality, including scripts table and dev workflow.
- Marked `REBUILD_PLAN.md` as historical reference; `docs/03-plan/PRODUCT_SPEC.md`, `BUILD_BLUEPRINT.md`, and `UI_SPEC.md` are now the canonical specs.

### Fixed

Phase 1.5 captures the foundation patch list. The P0 / P1 entries below are scheduled to land before any new feature work; see [`docs/01-investigation/02-bug-sweep.md`](docs/01-investigation/02-bug-sweep.md) for full repro detail.

- `P0-PTY-WIN-CMD` — Windows agent spawns failing with `Cannot create process, error code: 2` when the resolved command is a `.cmd` shim. A shared `resolveForCurrentOS` helper will route shims through `cmd.exe /d /s /c`.
- `P1-PROBE-EXEC-WIN` — provider `--version` probe inherits the same Windows shim defect; the new helper covers both call sites.
- `P1-PROBE-CMD-NOT-USED` — the resolved `.cmd` path is currently discarded and the bare command name is re-spawned.
- `P1-WORKTREE-LEAK` — failed launches leak worktree directories and DB rows; cleanup hooks will run on PTY birth failure.
- `P1-PTY-FAILURE-NOT-DETECTED` — PTY birth failures silently produce dead panes; the launcher will surface explicit error states.
- `P1-DB-EXIT-DUPLICATE-LISTENER` — exit handler attached twice per session, causing duplicate DB rows.
- `P1-PTY-REGISTRY-LEAK` — sessions are never removed from the in-memory registry after exit.
- `P1-NO-CLOSE-PANE` — there is currently no UI affordance to remove a pane from the grid.
- `P1-IPC-EVENT-RACE-CROSSWINDOW` — PTY events broadcast to all renderer windows; subscribe race is not airtight.
- `P1-INITIAL-PROMPT-DOUBLE` — initial prompt could be sent twice if the renderer reconnects mid-launch.
- `P1-DRIZZLE-DEFAULT-OVERRIDE` — SQL default `created_at` overwritten by an explicit `null` from the application layer.
- `P1-WORKTREE-PATH-COLLISION` — branch suffix widened from 5 to 8 chars to remove the silent collision risk.
- `P1-RUN-SHELL-TOKENISER` — `runShellLine` fix for nested single quotes inside double quotes.
- `P1-RUN-SHELL-EXEC-WIN` — `runShellLine` fails on Windows for `.cmd` tools; shared spawn helper covers it.
- `P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST` — preload `invoke` will move from generic to per-channel allowlist.
- `P1-DB-NEVER-CLOSED` — SQLite handle and WAL flushed on app quit.

### Deferred

- Cloud sync, account systems, and billing are out of scope for v1.
- SSH remote workspaces ship without UI; the provider abstraction keeps the seam.
- Ticketing integrations (Linear, Jira, GitHub Issues) are out of scope for v1.
- Voice assistant and mobile clients are out of scope.
- Bernstein-style verifier loops on top of the swarm dispatcher are deferred behind operator-supervised orchestration; see [`docs/03-plan/PRODUCT_SPEC.md`](docs/03-plan/PRODUCT_SPEC.md) decision C-008.

[Unreleased]: https://github.com/s1gmamale1/SigmaLink/commits/main
