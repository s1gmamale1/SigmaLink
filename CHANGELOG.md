# Changelog

All notable changes to SigmaLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once tagged releases begin.

## [Unreleased]

## [1.1.0-rc2] - 2026-05-10

Release-candidate iteration on top of rc1. Adds Phase 4 Step 5 (Skills marketplace live install) which landed on `main` after rc1 was tagged.

### Added

* **Skills marketplace live install from GitHub URL** (Phase 4 Step 5) — Marketplace tab Install button now downloads a GitHub tarball (streamed to temp file, no in-memory load), shells out to `tar -xzf`, walks for SKILL.md (root / subPath / `skills/` heuristic), and runs the result through the existing `manager.ingestFolder` pipeline (sha256 hash + atomic temp+rename + per-provider fanout to Claude/Codex/Gemini). Supports `owner/repo` shorthand, full GitHub URL, and SSH URL formats. Default branch resolved via GitHub API when ref omitted. Streamed progress events drive a per-card progress bar.
* **Marketplace catalog expanded 8 → 20 entries** — 6 entries point at the real public `anthropics/skills` repo; 14 are curated SigmaLink/community placeholders with `install: { ownerRepo, ref?, subPath? }` blocks. Older entries without an install block fall back to `repoUrl → owner/repo` parsing.
* 21/21 marketplace unit tests covering URL parsing, SKILL.md location heuristics, tarball-wrapper detection, and end-to-end installFromUrl flow (success, ref override, invalid URL, missing SKILL.md, invalid frontmatter, UPDATE_REQUIRED hint, download failure cleanup, progress sequence, metadata failure).

### Changed

* `app.tier` schema corrected to `enum(['basic','pro','ultra'])` to match the actual `Tier` union (was `['free','pro','ultra']` in plan).
* Vite main bundle 322 → 326 KB (+4 KB for the new MarketplaceTab UI surface). Still well under the 700 KB target.

### Carried forward from rc1

All Track A (IPC + provider hardening) + Track B (SigmaVoice) + Track C (Ruflo) work from rc1 is in this candidate unchanged.

## [1.1.0-rc1] - 2026-05-10

Phase 4 release candidate. Three feature tracks landed in one autonomous overnight run on top of v1.0.1: Agent IPC reliability, SigmaVoice native macOS module, and Ruflo MCP supervisor with three user-facing features. **rc1** because the new native voice module + lazy-download Ruflo path warrant real-world validation before the final v1.1.0 tag.

### Added

* **SigmaVoice native macOS** (Track B) — replaces renderer-only Web Speech API with on-device `SFSpeechRecognizer` via Objective-C++ NAPI module (`app/native/voice-mac/`). ABI-stable Node-API binary per arch (darwin-x64 + darwin-arm64); end users no longer need Xcode after CI ships prebuilds. Continuous mode with `requiresOnDeviceRecognition=YES` (server-side capped at ~60 s). New `dispatcher.ts` regex intent classifier routes finalized transcripts into broadcast / rollCall / app.navigate / assistant.send. macOS minimum bumped 10.12 → 10.15 (Speech.framework requirement). 17/17 dispatcher tests pass.

* **Ruflo MCP embed** (Track C) — three new user-facing features powered by an Option B lazy-download supervisor. **Semantic Memory Search** in Memory room runs `ruflo.embeddings.search` in parallel with token search; "Semantic" chip on Ruflo-sourced rows. **Bridge Assistant pattern surfacing** debounces composer input 800 ms → `ruflo.patterns.search`; ribbon at ≥0.7 confidence with Apply / dismiss. **Autopilot Command Palette** prefetches `ruflo.autopilot.predict` on cmdk open with 30 s cache. New Settings → Ruflo tab with download button (350 MB) + health row + telemetry opt-in. 14/14 proxy unit tests pass.

* **Provider launcher façade** — new `providers/launcher.ts` `resolveAndSpawn()` consolidates the three direct call sites; honors `comingSoon` + `fallbackProviderId` (BridgeCode → Claude with `provider_effective` populated), walks `[command, ...altCommands]` on ENOENT, appends `provider.autoApproveFlag` when `autoApprove=true`, re-checks `kv['providers.showLegacy']` main-side. 9/9 unit tests pass.

* **Migration 0010 — `agent_sessions.provider_effective`** column. Idempotent ALTER TABLE inside BEGIN/COMMIT/ROLLBACK. Populated by the launcher façade on every spawn so the renderer can render "BridgeCode (using claude)" chrome.

* **Group-recipient grammar** — `expandRecipient(swarmId, recipient)` resolves `*`/`@all`/`@coordinators`/`@builders`/`@scouts`/`@reviewers` end-to-end (mailbox row + JSONL mirror + PTY fan-out). Skill-toggle producer + SideChat sends to roles now actually reach all the role's PTYs.

### Fixed

* **macOS DMG PATH-truncation** (BUG-V1.1-03-PROV) — `electron/main.ts` `bootstrapShellPath()` now spawns `${SHELL} -ilc 'printf %s "$PATH"'` once at boot on darwin and prepends shell-resolved entries to `process.env.PATH`. Providers like `claude` / `codex` / `gemini` that live under `/opt/homebrew/bin` etc. now resolve when SigmaLink is launched from Finder/dock.

* **Cross-swarm directive leak** (BUG-V1.1-02-IPC) — `setPaneEcho` closure now scopes the DB lookup by `swarmId AND agentKey`. Operator → coordinator-1 directives no longer route into a different swarm's coordinator-1 PTY when both swarms have agents with the same name.

* **Cross-pane focus auto-sync** (BUG-V1.1-04-IPC) — Bridge dispatch echoes now perform workspace-switch + room-hop + active-session jump automatically; CommandRoom listens at room level and derives `activeIndex` from `state.activeSessionId`. Toast retained as confirmation.

* **Dead-PTY writes silenced** (BUG-V1.1-12-IPC) — `controller.writeToPtys` emits a `kind:'error_report'` mailbox row when a write target is dead.

* **Playwright Node 26 race** (BUG-V1.1-DF-01-PW) — defensive: `smoke.spec.ts` hoists `test.setTimeout(240_000)` into the test body, `dogfood.spec.ts` wraps in `test.describe('dogfood-v1', …)`. Proper fix (bump @playwright/test to ≥1.60) deferred to v1.2.

### Removed

* Dead `'droid'` and `'copilot'` from `ProviderId` union — never had registry entries; renderer stub references continue to work as plain strings.

### Build

* `tsc -b` clean. `vite build` 322 KB main + 6 vendor chunks (was 311 KB pre-Phase-4-tracks-B+C; +12 KB; well under 700 KB target). `electron:compile` clean. Lint **42 errors / 10 warnings** (was 54/10 baseline; tracks contributed 0 new errors — net DECREASE).
* `mac.hardenedRuntime: true` + `entitlements: build/entitlements.mac.plist` (3 entitlements: allow-jit, allow-unsigned-executable-memory, device.audio-input). `mac.extendInfo` adds NSMicrophoneUsageDescription + NSSpeechRecognitionUsageDescription. Hardened runtime is inert without a Developer ID signing identity (we still ship unsigned), but turning it on lets future notarisation work without an electron-builder churn round.

### Deferred to v1.2

* Wake-word "Hey Sigma" (Porcupine licensing forbids bundled key; needs BYO-AccessKey UX or enterprise license).
* Native voice CI workflow + cross-arch prebuilds (`app/native/voice-mac/prebuilds/`).
* Ruflo HTTP Range / resumable downloads.
* Ruflo native deps (@ruvector/sona-*, onnxruntime-node) — installer fetches top-level tarball only in v1.1.
* Roll-call main-process aggregation + timeout (BUG-V1.1-05-IPC).
* `console-controller.stop-all` + `factory.killSwarm` consolidation (BUG-V1.1-07-IPC).
* @playwright/test ≥1.60 bump to remove the Node-26 loader race.
* Bridge Assistant `roll_call` / `broadcast` tools dual-delivery (BUG-V1.1-06-IPC).
* Five P3 IPC follow-ups + 1 P3 PROV follow-up.

## [1.0.1] - 2026-05-10

Hotfix release. Tag + push gated on explicit user authorization. Body: `docs/release-notes-1.0.1.txt`.

### Fixed

- **DMG `Cannot find module 'bindings'`** at first launch — `electron-builder.yml` now adds `bindings`, `file-uri-to-path`, `prebuild-install`, `better-sqlite3/**`, and `node-pty/**` to `asarUnpack` so the native-module resolver finds the unpacked siblings. The v1.0.0 break came from the `--config.npmRebuild=false` build-flag workaround dropping transitive deps from the asar; the YAML-side fix means future rebuilds don't need that flag.
- **Boot self-check missed `bindings` resolution failures** — `app/electron/main.ts` `checkNativeModules()` now opens `new Database(':memory:')` and spawns a 1×1 `node-pty.spawn()` (then immediately kills) so the inner `require('bindings')` actually executes during the smoke test; the diagnostic page now appears at boot rather than the renderer white-screening on first DB write.
- **macOS traffic-light overlap on Sidebar** — title-bar buttons (close/min/zoom) overlapped the `SigmaLink` wordmark + Σ monogram on top-left of the sidebar. Added a 28-px draggable spacer at the top of the sidebar on macOS so the buttons sit in their own region (`Sidebar.tsx`); spacer hidden on Win/Linux.
- **CLI agent pane text misalignment on first render** — `Terminal.tsx` no longer relies on a `requestAnimationFrame`-deferred initial `fit.fit()` (the rAF could fire before GridLayout's flex-shrink stabilized, leaving cells one column off). The `ResizeObserver` now gates `fit()` on non-zero contentRect dimensions and runs the first fit synchronously when the container measures non-zero; subsequent resizes debounce 25 ms (was 50 ms).
- **BUG-DF-02** — `app.tier` and `design.shutdown` RPC channels now have zod schemas; the boot-time soft-launch warning `2 channel(s) have no zod schema entry` no longer fires.
- **BUG-DF-01** — Browser room data-room flicker on tab focus.

### Build

- `app/electron-builder.yml` `asarUnpack` block extended; no longer requires `--config.npmRebuild=false` at build time.
- `app/scripts/build-electron.cjs` adds `lazy-val` to esbuild externals to fix a pre-existing `electron:compile` break that surfaced when rebuilding a clean tree.
- `app/package.json` version `1.0.0` → `1.0.1`.

## [1.0.0] - 2026-05-10

V3 parity release. Tag + push gated on explicit user authorization. Body: `docs/release-notes-1.0.0.txt`. Acceptance: `docs/06-test/ACCEPTANCE_REPORT_V1.md`.

### Added

Wave 10 — boot self-check + Diagnostics:

- Boot self-check detects `better-sqlite3` ABI mismatches; `NativeRebuildModal` prompts `npm rebuild`; Re-probe banner re-runs provider PATH probes; Settings → Diagnostics tab. Closes critique R3 + risk A12.

Wave 11.5 — scope freeze:

- `docs/03-plan/V3_PARITY_BACKLOG.md` (45 tickets, W12-15); surgical PRODUCT_SPEC re-baseline (C-016, §2.2/2.3/3.10/3.12/3.13/3.14, §4 V3 9-provider matrix).

Wave 12 — V3 quick-wins + infrastructure (6 parallel agents):

- Workspace launcher: 3-card picker (BridgeSpace / Swarm / Canvas-ALPHA, `⌘T`/`⌘S`/`⌘K`) + Start → Layout → Agents stepper + tile grid 1/2/4/6/8/10/12 + recents autocomplete + preset row + sidebar status dot + agent-count pill + breadcrumb `Workspace <N> / <user>`.
- Provider matrix reset: BridgeCode stub (silent Claude fallback via `agent_sessions.providerEffective`); Kimi → OpenCode model option (`ModelOption` type, per-pane status strip `<model> <effort> <speed> · <cwd>`); Aider + Continue behind `kv['providers.showLegacy']`; wizard quick-fills (Enable all / One of each / Split evenly).
- Battalion 20 preset (3/11/3/3 [INFERRED]); cap 50→20; >20-agent swarms read-only with `legacy: true`.
- Role colour CSS tokens (`--role-coordinator/-builder/-scout/-reviewer`) across all themes; `bg-role-<n>` utilities.
- Swarm wizard 5-step shell (Roster → Mission → Directory → Context → Name); CLI-agent-for-all global provider strip; per-row Auto-approve + provider override + model + count -/+ + colour stripe.
- Operator Console TopBar (TERMINALS / CHAT / ACTIVITY tabs + STOP ALL + group filters fed by `swarm:counters`).
- 17 new RPC channels + 5 events; `assistant.*` / `design.*` / `voice:state` / new `swarm:*` allowlist groups.
- 9 mailbox envelope kinds: `escalation` (promoted), `review_request`, `quiet_tick`, `error_report`, `task_brief`, `board_post`, `bridge_dispatch`, `design_dispatch`, `skill_toggle`. Recipient grammar `@all`/`@coordinators`/`@builders`/`@scouts`/`@reviewers`. Per-kind zod soft-launch schemas.
- `swarm_messages.resolvedAt` (counters); `directive.echo='pane'` (operator → PTY).
- Drizzle Kit journal; new tables `boards`, `swarm_skills`, `canvases`; new columns `swarm_agents.coordinatorId`, `swarm_agents.autoApprove`.
- `safeStorage`-backed credentials (closes A5).

Wave 13 — V3 parity sweep + Bridge Assistant (5 parallel agents):

- Right-rail dock with Browser / Editor / Bridge tabs + resizable splitter; width in `kv['rightRail.width']`. Browser recents + click-link-in-pane routing.
- Per-pane chrome variants + provider splash + footer hints; multi-pane CSS-grid 1/2/4/6/8/10/12 with per-pane drag-resize + `Cmd+Alt+<N>`.
- Constellation graph (drag/zoom; multi-hub via `coordinatorId`); ActivityFeed sidebar; structured `task_brief` render (URGENT chip + indented headings + live links).
- Per-agent boards (`boards` table + atomic markdown under `<userData>/swarms/<swarmId>/boards/...`); `board_post` envelope DB + disk in one tx.
- Operator → agent DM echo into PTY when `directive.echo === 'pane'`. Mission `@<workspaceSlug>` autocomplete. Swarm Skills 12-tile grid persists to `swarm_skills` and fires `skill_toggle`.
- **Bridge Assistant fully built**: chat panel + 4-state orb (STANDBY / LISTENING / RECEIVING / THINKING) + char-by-char streaming.
- `assistant.*` RPC: `listen`, `state` (event), `dispatch-pane`, `dispatch-bulk`, `ref-resolve`, `turn-cancel`, `tool-trace` (event).
- 10 canonical tools: `launch_pane`, `prompt_agent`, `read_files`, `open_url`, `create_task`, `create_swarm`, `create_memory`, `search_memories`, `broadcast_to_swarm`, `roll_call`. Tool tracer + cross-workspace Jump-to-pane toast + completion ding (`app/public/sounds/ding.wav`).

Wave 14 — Bridge Canvas + Editor + auto-update (3 parallel agents):

- Bridge Canvas element-picker overlay; `design:start-pick / pick-result` carry `{ selector, outerHTML, computedStyles, screenshotPng }`.
- DesignDock with captured selector + collapsible outerHTML + screenshot thumbnail + "Paste source" pill.
- Per-prompt provider chips (Claude / Codex / Gemini / OpenCode) Shift-add / Alt-remove; persists per-canvas in `canvases.lastProviders`.
- Drag-and-drop asset staging into `<userData>/canvases/<canvasId>/staging/<ulid>.<ext>`.
- Live-DOM HMR poke: `design:patch-applied` on agent file writes; `location.reload()` fallback or no-op WebSocket nudge.
- BridgeCanvas card ALPHA chip until `kv['canvas.gaSign']='1'`.
- Editor right-rail tab: Monaco lazy-loaded as 14.57 KB chunk (separate from 990 KB main); CodeMirror fallback; file tree + click-path focus + `fs.readDir`/`readFile`/`writeFile` RPC.
- Auto-update via `electron-updater@6.8.3`; opt-in behind `kv['updates.optIn']='1'`; Settings → Updates tab with Check button + last-check timestamp.
- Re-probe agents button (Settings → Providers); `NativeRebuildModal` on `better-sqlite3` ABI mismatch.

Wave 15 — voice + CI matrix + plan capabilities (4 parallel agents):

- BridgeVoice intake: title-bar pill + global `voice:state { active, source: 'mission'|'assistant'|'palette' }`. Web Speech API stub; native bindings deferred to v1.1.
- Voice into swarm mission textarea, Bridge orb tap, Command Palette (`Cmd+Shift+K`).
- `.github/workflows/e2e-matrix.yml` runs the smoke on `windows-latest` / `macos-14` / `ubuntu-latest` under Node 20; per-OS artefacts; required PR check.
- Plan-gating matrix at `app/src/main/core/plan/capabilities.ts` + `canDo(cap)`; default tier `'ultra'` (free, local-only); QA override via `kv['plan.tier']`.
- Skills marketplace stub: read-only listing from `docs/marketplace/skills.json`.

### Changed

- Roster preset rename Legion → Battalion. Preset list = Squad 5 (1/2/1/1) · Team 10 (2/5/2/1) · Platoon 15 (2/7/3/3) · Battalion 20 (3/11/3/3 [INFERRED]) · Custom 1..20. `swarms.preset` CHECK constraint accepts `'battalion'`; existing `'legion'` rows survive but new swarms reject `legion`. Supersedes original PRODUCT_SPEC C-006.
- Provider matrix 11 → 9 default. BridgeCode added; Kimi demoted to OpenCode model option; Aider + Continue hidden behind legacy toggle; Custom row renamed to "Custom Command". Supersedes original PRODUCT_SPEC C-004.
- `[Unreleased]` section reset to empty after this release cuts.
- README status table flips Phase 9 to In progress (Waves 12–16) → Shipped pending W15 CI matrix completion.

### Fixed

W12 P3 sweep — 5 P3 bugs from W7 closed:

- `BUG-W7-007` (P3) — PowerShell upgrade banner suppressed: `-NoLogo` + `POWERSHELL_UPDATECHECK=Off` for the PowerShell family in `local-pty.ts`.
- `BUG-W7-009` (P3) — Tasks sidebar icon weight: `ListChecks` → `LayoutGrid` to match `Folder`/`Globe`/`Settings` stroke profile.
- `BUG-W7-010` (P3) — Test-only folder picker: `workspacesCtl.pickFolder` bypasses `dialog.showOpenDialog` when `process.env.SIGMA_TEST` is set, reading `kv['tests.fakePickerPath']`.
- `BUG-W7-012` (P3) — Onboarding Skip flake: `complete()` dispatches `SET_ONBOARDED` synchronously; kv write fires in background; Skip button forces `pointerEvents: 'auto'`.
- `BUG-W7-014` (P3) — Browser room test-coupling: `RoomSwitch` mirrors `state.room` to `document.body.dataset.room`; smoke embeds rendered room in filename.

### Deferred

- Dogfood cycle (V3-W15-006) — needs real human GUI session; queued for v1.1.
- Native voice bindings (macOS Speech / Windows SAPI / Linux PocketSphinx); Web Speech API stub ships in v1.0.0.
- macOS notarisation + Windows code-signing certificate (R10 Partial).
- Three-way merge editor + per-line review comments in Review Room.
- Manual reverify BUG-W7-003 + BUG-W7-006 (both hold `fixed` pending fresh-kv GUI cycle).
- Real CDP-attach / shared-Chromium Browser; per-workspace cookie isolation; hard-blocking `claimDriver` lock.
- Barnes-Hut quadtree for Memory graph >500 notes; token-overlap `suggest_connections`; real-time `memory:changed` IPC.
- Cloud sync, accounts, billing, SSH remote workspaces, ticketing integrations, mobile clients — out of scope for v1.
- Bernstein-style verifier loops (PRODUCT_SPEC C-008); multi-window concurrency (A11); telemetry (A16).

### Known issues

- Local Playwright `_electron` smoke gated on Node 26 + npm 11 install bug; W15 CI matrix on Node 20 is canonical.
- Lint at 80 errors / 3 warnings, nearly all in `_legacy/` archive code.
- BUG-W7-015 (P3) — Parchment "Launch N agents" CTA contrast nit (open).
- BUG-W7-000 (P0) — Electron node_modules install bug; bypassed by Node 20 CI matrix; tracked for v1.1.

Tagged and released: 2026-05-10.

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

[Unreleased]: https://github.com/s1gmamale1/SigmaLink/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/s1gmamale1/SigmaLink/compare/v0.1.0-alpha...v1.0.0
[0.1.0-alpha]: https://github.com/s1gmamale1/SigmaLink/releases/tag/v0.1.0-alpha
