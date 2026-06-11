# SigmaLink — Roadmap

SigmaLink is an Electron desktop workspace for launching and coordinating live Claude/Codex/Gemini/Kimi/OpenCode agent panes with worktrees, Ruflo memory/orchestration, browser tools, voice, and review workflows. The immediate operational concern is RAM pressure from live multipane agent process trees.

This ROADMAP is the single source of truth for what to build next.

> **Release status (2026-06-12):** the **2026-06-10 audit is complete — Phases 3–12 all SHIPPED** (3–10 in `v2.1.0` `340613c`; 11 win32 in `v2.2.0` `41f6e53`; 12 dead-code in #149 `a3b5837`; `v2.3.0` tagged `04d8e24`). The shipped phase sections below are retained for reference. Post-v2.3.0, untagged on main: **Phase 13 — Pane close lifecycle ✅ Part A SHIPPED** (PR #161 `a0e9bee`, 2026-06-12; hotlist #13/#14 fixed; Part B Recents remains; plan + ADR-007 below) · **Phase 14 — SigmaLink Dev workspace ✅ SHIPPED** (PR #158 `9cda070`, 2026-06-11; plan + ADR-008 below) · Phase 15 win32 DB lifecycle (#154) · Jorvis terminal-access hotfix (#157) · pane-rendering arc (#159/#160). All ride the next tag.

---

## How to read this

- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort** is S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Confirmed bugs are fixed before new feature phases.

---

## Confirmed bugs to fix first (hotlist)

Status: the RAM hotlist below was implemented in `feat/pane-ram-optimization`.

| # | Sev | Bug | Where (file:line) | Effort |
|---|-----|-----|-------------------|--------|
| 1 | High | App-wide shutdown can miss MCP descendants because explicit pane close is tree-aware but `killAll()` is not guaranteed to stop the full process tree. | `app/src/main/core/pty/registry.ts:406` | S |
| 2 | High | Pane launch can fall back to per-pane Ruflo stdio MCP when the shared HTTP daemon is not already running, duplicating `npx/node` MCP children across panes. | `app/src/main/core/workspaces/launcher.ts:317`, `app/src/main/core/swarms/factory-spawn.ts:87` | M |
| 3 | High | Jorvis `launch_pane` spawns panes that never render — the bare tool emits no `assistant:dispatch-echo` (its `dispatchPane`/`dispatchBulk` twins do). → **Phase 3** | `app/src/main/core/assistant/tools.ts:283-300`, `use-jorvis-dispatch-echo.ts:35` | S |
| 4 | Med | Screenshot drop/paste never reaches the agent as an image (drop path-mentions all files with no MIME check; xterm swallows image clipboards). → **Phase 3** | `app/src/renderer/features/command-room/PaneShell.tsx:256-321`, xterm `Clipboard.ts:43-49` | M |
| 5 | Med | No Copy/Paste on pane right-click (Radix trigger intercepts `contextmenu`; no clipboard wiring). → **Phase 3** | `app/src/renderer/features/command-room/PaneShell.tsx:442-582`, `terminal-cache.ts:175-196` | S |
| 6 | Med | `+ Pane` dead after restart — janitor-`failed` swarm with no resume escape hatch when the #134 heal misses. → **Phase 3** | `app/src/renderer/features/command-room/AddPaneButton.tsx:74-76`, `resume-launcher.ts:526` | S |
| 7 | Crit | Bootstrap SQL resurrects the UNIQUE `workspaces_root_idx` that migration 0034 dropped — multi-ws-same-dir re-breaks every boot; boot **crashes** once duplicate `root_path` rows exist. → **Phase 4** | `app/src/main/core/db/client.ts:28` | S |
| 8 | Crit | SF-13 prune fence violates keep⊇use AND is workspace-scoped against the repo-scoped worktree dir — deletes resume-eligible worktrees + sibling workspaces' LIVE worktrees. → **Phase 4** | `app/src/main/core/workspaces/cleanup.ts:79-90` | M |
| 9 | High | Stale 3 s graceful-exit forget-timer kills a freshly re-created/resumed pane (no record-identity guard; enables double-spawn zombies). → **Phase 5** | `app/src/main/core/pty/registry.ts:326,342` | S |
| 10 | High | `panes.brief` writes a CLAUDE.md to a renderer-supplied path with no containment (prompt-injection write primitive). → **Phase 6** | `app/src/main/rpc-router.ts:1295` | S |
| 11 | High | Scratch-shell tabs orphan PTYs + leak xterm/WebGL cache entries (per-mount state the cache GC can't see). → **Phase 7** | `app/src/renderer/features/command-room/PaneShell.tsx:145-186` | M |
| 12 | Crit (win32) | `cmdQuoteArg` cmd.exe escaping corrupts npm `.cmd`-shim argv (carets literal inside quotes; odd `\"` toggles quote state = injection); class invisible to CI (vitest never ran on Windows). → **Phase 11** | `app/src/main/core/util/windows-spawn.ts:88-96` | M |
| 13 | High | Manually-closed panes **resurrect on app restart** — `panes.listForWorkspace` rehydrates every `pane_index IS NOT NULL` row with NO status filter, and manual × writes nothing to the DB; a lost-race `running` row is even resumed live by the janitor→`listEligibleRows` path. → **Phase 13 — ✅ FIXED PR #161 `a0e9bee`** | `app/src/main/rpc-router.ts:1236`, `app/src/renderer/features/command-room/CommandRoom.tsx:257-262`, `app/src/main/core/pty/resume-launcher.ts:346` | M |
| 14 | Med | Closing a pane raises a spurious **"Pane exited (code 143/0)" warn toast** — `pushPtyExitNotification` fires on every PTY exit with no deliberate-close suppression; the `close_pane` tool hits the same path (sibling). → **Phase 13 — ✅ FIXED PR #161 `a0e9bee`** | `app/src/main/core/notifications/sources/pty-exit.ts:47-74` | S |
| 15 | High | `workspaces.rename`/`openNew` **hard-rejected at the preload bridge** — registered + typed but absent from the `CHANNELS` allowlist (`isAllowedChannel` is exact-match), so sidebar inline rename silently never persists (optimistic dispatch masks it until restart); the v1.5.3-B defensive test passes because its own hand-list omits them too (quad-drift). → **Phase 14 (drive-by Task 4) — ✅ FIXED PR #158 `bf708c7`** | `app/src/shared/rpc-channels.ts:78-83` vs `app/src/shared/router-shape.ts:323,327`; `app/src/renderer/features/sidebar/Sidebar.tsx:294`; `app/src/shared/rpc-channels.test.ts:108-113` | S |
| 16 | Crit (win32) | App **crashes on reopen** ("database is locked" main-process dialog) + WAL grows unboundedly — orphaned per-CLI `mcp-memory-server.cjs` writers survive quit (`taskkill /T` can't reach reparented grandchildren) and hold `sigmalink.db`; `journal_mode=WAL` ran before `busy_timeout`; `bootstrapAndMigrate` uncaught at boot. → **Phase 15** | `app/src/main/core/db/client.ts:225`, `app/src/main/core/memory/mcp-server.ts:191`, `app/src/main/core/process/process-tree.ts:175`, `app/src/main/rpc-router.ts:285` | M |
| 17 | High | Jorvis tool-catalogue triple-drift: `close_pane`/`add_agent`/`monitor_pane` in `tools.ts` (and `close_pane` in the system prompt) but absent from the MCP `tools/list` — under `--strict-mcp-config` the model cannot call them; failures occur CLI-side, invisible to traces. → **Hotfix: Jorvis terminal access** | `app/src/main/core/assistant/mcp-host-server.ts:81-258` vs `tools.ts:287` | S |
| 18 | High | Jorvis has NO terminal-read tool — `registry.snapshot()` ring buffer (256 KiB/session) exists but is unexposed; "can't access terminals". → **Hotfix: Jorvis terminal access** | `app/src/main/core/pty/registry.ts:593`, `app/src/main/core/assistant/tools.ts` | S |
| 19 | Med | `prompt_agent` silent no-op on dead sessions: `registry.write()` is `?.`-guarded and the handler returns `ok:true` unconditionally — Jorvis "successfully" prompts roster ghosts. → **Hotfix: Jorvis terminal access** | `app/src/main/core/pty/registry.ts:447-449`, `app/src/main/core/assistant/tools.ts:385-388` | S |

---

## Phase 1 — Reduce live pane RAM

**Goal.** Ordinary multi-agent workspaces use one shared Ruflo HTTP MCP daemon per workspace, expose process-tree diagnostics, and cleanly stop child process trees without losing current pane functionality.

**Deliverables.**
- `app/src/main/core/workspaces/ruflo-mcp-policy.ts` — shared helper that resolves Ruflo MCP transport before pane spawn.
- Updated workspace and swarm pane launch paths that prefer HTTP Ruflo and only fall back to stdio when the daemon cannot be started.
- Updated PTY registry shutdown path that stops full process trees consistently.
- Expanded `pty.processStats` payload with descendant process details for future UI diagnostics.
- Unit tests for Ruflo transport selection and tree-aware shutdown behavior.

**Why now.** Live evidence showed 300-445 MB Claude/Ruflo panes and Codex panes with duplicated `@claude-flow/cli mcp start` children. Switching common Ruflo access from per-pane stdio to shared HTTP attacks the largest avoidable cost while preserving all panes, tools, worktrees, bypass modes, and resume support.

**Scope.**
- Add a Ruflo MCP launch policy helper near `app/src/main/core/workspaces/ruflo-worktree-mcp.ts:63` that checks `profileAllowsMcp`, reads `ruflo.autowriteMcp` / `ruflo.autoTrustMcp`, starts `rufloHttpDaemonSupervisor.spawn(workspaceId, workspaceRoot)` when needed, and returns the transport written into the pane cwd.
- Replace duplicated Ruflo autowrite logic in `app/src/main/core/workspaces/launcher.ts:293` and `app/src/main/core/swarms/factory-spawn.ts:64` with the helper.
- Keep stdio fallback as an explicit degraded path so a missing daemon does not break existing pane functionality.
- Extend `app/src/main/core/process/process-tree.ts:1` and `app/src/main/rpc-router.ts:1008` so process stats include child process command/RSS details, not just aggregate RSS.
- Update `app/src/main/core/pty/registry.ts:406` so bulk shutdown uses the same tree-aware stop path as explicit pane close.
- Add focused unit tests next to the changed modules.

**Findings + recommendation.** Claude and Codex panes are full independent CLI runtimes, so Tauri migration would only reduce host overhead. The high-value path is to remove duplicated local MCP server process trees first, then add lazy resume/idle suspend later. Recommendation: prefer shared HTTP Ruflo, instrument process trees, and make cleanup tree-aware before touching broader pane UX.

**Risks.** HTTP daemon startup can fail or be slower than stdio; mitigate by falling back to current stdio config and surfacing transport in logs/diagnostics. Changing launch helpers can affect workspace and swarm panes differently; mitigate with tests for both call sites. Process-tree diagnostics can expose noisy command strings; keep data local and use it only in app diagnostics.

**Definition of done.** Launching workspace and swarm panes still starts Claude/Codex normally, Ruflo MCP is written as HTTP when the daemon is available, stdio remains available when the daemon is unavailable, `pty.killAll()` stops descendant MCP children, and focused tests pass.

## Phase 2 — RAM Brake launch guard

**Goal.** Prevent surprise high-memory Claude resumes by previewing session risk, offering safe launch modes, and making root CLI versus MCP child RSS visible.

**Delivered.**
- Claude session JSONL risk analyzer with low/medium/high/critical classification.
- `mcpLaunchMode` support for strict core/no-MCP Claude launches.
- `ramBrake.sessionRisk` RPC with Zod validation and renderer types.
- Workspace launch prompt for high-risk Claude resumes with `Start fresh / no MCP`, `Resume anyway`, and `Cancel`.
- Pane RSS badge tooltip showing total RSS, root CLI RSS, MCP RSS, process count, and top child command.

**Definition of done.** Ordinary Claude launches use strict Ruflo-core MCP by default, high-risk Claude resume launches are held before spawn, the safe option starts fresh with no inherited MCP, explicit heavy tool profiles remain available, and focused tests plus production build pass.

---

## Phase 3 — Command Room interaction reliability ✅ SHIPPED (PR #137 `b7fac3a`, 2026-06-10)

> Shipped all 4 fixes + a `close_pane` Jorvis tool. Built subagent-driven (implementer → spec review → Opus code-quality review per task); the two-stage review caught 4 issues a green gate missed (xterm-6 `copyOnSelect` no-op → `onSelectionChange`; missing `panes.stageImage` zod schema; failed-resume optimistic-state divergence; `close_pane` missing from `DANGEROUS_REMOTE`). Owed follow-ups (wishlist): extract `usePaneImageStaging` (PaneShell 732 lines), staged-image janitor sweep, verify `add_agent`/`create_swarm` panes render live.

**Goal.** Every core pane interaction does what the operator expects: Jorvis-launched panes appear in the grid, terminal text can be copied/pasted, a dropped or pasted screenshot actually reaches the agent as a readable image, and `+ Pane` works first-click after an app restart.

**Deliverables.**
- `assistant:dispatch-echo` emission from the `launch_pane` tool (`emit` threaded into `ToolContext`).
- Right-click **Copy/Paste** menu items + `copyOnSelect:true` + `getCached()` terminal-cache accessor.
- `panes.stageImage` RPC + `app/src/main/core/workspaces/stage-image.ts` (validated temp-file staging) + image-aware drop branch + capture-phase paste interceptor in `PaneShell`.
- `IMAGE_CAPABLE_PROVIDERS` capability set in `app/src/shared/providers.ts`.
- `swarms.resume` RPC + auto-resume inside `addPane()`; relaxed `+ Pane` gate (`completed` stays gated).
- Spec: `app/docs/superpowers/specs/2026-06-10-command-room-interaction-reliability-design.md` · Plan: `app/docs/superpowers/plans/2026-06-10-command-room-interaction-reliability.md`.

**Why now.** Hotlist bugs #3–#6: all four are operator-reported daily-friction failures of core flows (Jorvis orchestration silently no-ops in the UI; screenshots — the most common multimodal input — never reach the agent; copy/paste is table-stakes terminal UX; a restart bricks `+ Pane`). All four are root-caused with `file:line` evidence, so the remaining work is small and low-risk.

**Scope.** (ordered; full TDD detail in the plan doc)
1. `launch_pane` echo — `tools.ts:283-300` handler + `ToolContext` + ctx construction `controller.ts:218-235` (payload mirrors `dispatchPane:464-477`; `workspaceId` from `ctx.defaultWorkspaceId`).
2. Copy/Paste — `terminal-cache.ts` (`getCached` near `:439`, `copyOnSelect` in `buildTerminalOptions:175-196`) + two `ContextMenuItem`s atop `PaneShell.tsx:534`.
3. Screenshot staging — `providers.ts` capability set; `stage-image.ts` helper + `panes.stageImage` channel triple (`rpc-channels.ts` + `router-shape.ts` + `rpc-router.ts:1292+`); image branch in `handleDrop` (`PaneShell.tsx:303-321`); capture-phase `paste` listener mirroring the Cmd+T pattern (`:192-217`).
4. `+ Pane` auto-resume — `swarms.resume` in `core/swarms/controller.ts` (after `kill:184-186`) + channel triple; gate relax + auto-resume call in `AddPaneButton.tsx:74-76`/`:222-227`.

**Findings + recommendation.** 3-agent /systematic-debugging sweep (2026-06-10) + CLI-protocol research: both Claude Code and Codex ingest images CLI-side from the system clipboard via Ctrl+V (the PTY is a text pipe — xterm cannot forward image bytes), but Electron's `clipboard.writeImage` writes `public.png` while Claude Code reads only legacy `«class PNGf»` (anthropics/claude-code#30936, open) — so the clipboard route silently fails for Claude. Both CLIs accept an image **file path** in the prompt → stage-to-temp-file + absolute `@path` is the only mechanism that works today for both (ADR-003). PR #134's `unfailZombieSwarms` shrank the `+ Pane` bug to the 0-spawn / stale-renderer edge → escape hatch chosen over boot-path rework (regression-prone area).

**Risks.** `PaneShell.tsx` nears the 500-line cap (B+C both touch it) → extract `usePaneImageStaging.ts` if crossed. New RPC channels touch the rpc-channels/router-shape/rpc-router **sibling triple** — plan has an explicit sweep step. `copyOnSelect` changes clipboard behavior on every selection — operator opted in; revert is a one-line flag. Echo `workspaceId` uses the conversation's workspace; a `launch_pane` aimed at a different workspaceRoot would refetch the wrong list (accepted: matches `requireWs` semantics; multi-workspace tool calls are out of scope).

**Definition of done.** Operator can: ① ask Jorvis to launch 2 panes and see them appear in the grid without refresh; ② select pane text → right-click → Copy, and Paste clipboard text into a pane; ③ drop AND paste a screenshot onto a claude/codex pane and the CLI reads the staged image from the injected absolute `@path` (shell panes keep path-mentions); ④ force-quit, reopen, click `+ Pane` once and get a pane. Full local gate (tsc, vitest, eslint, build) + CI e2e-matrix green.

---

## Phase 4 — Main-process data-integrity criticals ✅ SHIPPED (PR #136 `81619e3` + PR #138 `e1d0968`, 2026-06-10)

**Goal.** A boot can never crash or silently re-break multi-workspace-same-dir, and no sweep can delete a worktree that resume — or a sibling workspace — still needs.

**Deliverables.**
- `BOOTSTRAP_SQL` index fix (drop unique twin, non-unique lookup) + fake-index boot→0034→boot test incl. poisoned-install self-heal.
- Shared keep-predicate (`isWorktreeKeepEligible`/`collectKeptWorktreePaths`) exported from `worktree-cleanup.ts`, consumed by `cleanup.ts` — plus an explicit **keep⊇use invariant test** with a source tripwire on `resume-launcher.ts`.
- `removeWorkspace` stops live PTYs + deletes `agent_sessions` rows; `removeWorkspaceAndGc` reordered kill→delete→prune; `.log.tmp` GC.
- Plans: `app/docs/superpowers/plans/2026-06-10-db-bootstrap-index-and-workspace-remove.md` · `…/2026-06-10-worktree-reaper-fence.md`.

**Why now.** Both are CRIT: hotlist #7 hard-crashes boot once duplicate root-path workspaces exist (and silently re-breaks the shipped Phase-7 multi-ws feature on every restart); #8 is active data loss (rm-rf of live/resumable worktrees across workspaces in the shared `repoHash` dir).

**Scope.** `client.ts:28` → `DROP INDEX IF EXISTS` + non-unique; `cleanup.ts:79-90` fence goes global + broad (running/starting/exited(-1)/7d); `factory.ts:359-377`; `scrollback-store.ts:92`. Full TDD detail in the two plan docs.

**Findings + recommendation.** Plan-time recon: drizzle `schema.ts:33` is already non-unique — only `BOOTSTRAP_SQL` is stale, 0034 needs no change; the boot sibling `worktree-cleanup.ts:54-72` already holds the correct broad fence → extract one shared predicate so the twins can't drift again (**ADR-004**).

**Risks.** Wider fence keeps more disk (bounded by the 7-day window). `removeWorkspaceAndGc` reorder touches the live-kill path — MockDb tests + fail-open stop mitigate.

**Definition of done.** Boot→0034→boot test green incl. self-heal; keep⊇use matrix + tripwire tests green; removing a workspace leaves no headless PTYs and no permanently-unreapable worktrees; full gate (`tsc -b`/eslint/vitest/`product:check`) + CI.

## Phase 5 — PTY lifecycle & resume correctness ✅ SHIPPED (PR #139 `c26695c`, 2026-06-10)

**Goal.** A resumed/respawned pane can never be killed by a stale timer, crash classification is uniform at all three exit sites, respawn-fresh can't roll a pane back to its pre-crash conversation, and a CLI-exit sentinel can't be missed on a chunk split.

**Deliverables.**
- Record-identity guard on the 3 s forget-timer + duplicate-id `create()` policy + `registry-lifecycle.test.ts` (fake timers).
- `isPtyCrash` in `attachExitPersistence` + `pty:error` broadcast (3rd mirrored classifier site aligned).
- Respawn ghost-heal mirror (null stale `external_session_id`; claude pre-assign + stamp-back; codex stays safe-fresh per the #128 rationale).
- Anchor-safe `sliceSentinelCarry` (≤64-char tail-from-last-newline; forwarded data never rewritten).
- Plan: `app/docs/superpowers/plans/2026-06-10-pty-lifecycle-resume-fixes.md`.

**Why now.** Hotlist #9 kills freshly-resumed panes ~3 s in under restart races — direct daily-driver pain; the other three live in the same files and share test scaffolding.

**Scope.** `registry.ts:326,342,311` · `resume-launcher.ts:270-291,397-446` · `sentinel.ts:58-76`. Per plan.

**Findings + recommendation.** The 3-way exit-classifier mirror had drifted at exactly one site; shell-first (default mode) makes the sentinel carry mandatory, with `ProtocolLineBuffer` as the proven in-repo sibling pattern.

**Risks.** Duplicate-id policy could break a legit re-create flow — fake-timer tests cover resume/respawn/concurrent paths. Prereq note: Phase 4's reaper plan adds a tripwire on `resume-launcher.ts` — land Phase 4 first.

**Definition of done.** Re-create-within-grace test green; a respawned claude pane keeps its NEW conversation across reopen; 2- and 3-chunk sentinel splits detected with zero false positives; full gate + CI.

## Phase 6 — RPC boundary & sink hardening ✅ SHIPPED (PR #140 `c8df2e2`, 2026-06-10)

**Goal.** Every renderer-supplied path is contained, every launch path threads the notification/error sinks, and model args are allowlisted at both spawn sites.

**Deliverables.**
- `briefPane()` in `scope-block.ts` behind `assertAllowedPath`; `fsExists()` oracle-closed; M1 `listModelsFor` allowlist in `factory-spawn.ts`.
- `notifications` + `broadcastPtyError` threaded through `ToolContext`/controller deps into **all four** un-sinked `executeLaunchPlan` sites + `sigmabenchSwarmFactoryDeps`.
- `makeScrollbackExitSink` — always wired, KV gate re-read per exit (runtime toggle-ON works).
- Plan: `app/docs/superpowers/plans/2026-06-10-rpc-boundary-hardening.md`.

**Why now.** Hotlist #10 is a CVE-class write primitive reachable from the renderer; the sink gaps silence disk-guard CRITICAL bells exactly on the Jorvis-orchestrated launches Phase 3 makes more prominent.

**Scope.** `rpc-router.ts:1295,1612,585` · `factory-spawn.ts:136` · `tools.ts` + `design/controller.ts:328` + `assistant/controller.ts:598`. Per plan.

**Findings + recommendation.** Plan recon found two extra un-sinked `executeLaunchPlan` sites beyond the audit's pair, and corrected the M1-twin path to `core/workspaces/launcher.ts:126-135` — the sibling-sweep step in the plan is mandatory.

**Risks.** Containment could reject a legitimate out-of-roots brief — both renderer callers verified in-roots; fail closed with a clear error. rpc-router is also touched by Phases 5/8 — serialize merges.

**Definition of done.** Out-of-roots brief/exists rejected in tests; a disk-guard notification fires on an assistant-launched pane in test; scrollback toggle-ON persists at the next exit; full gate + CI.

## Phase 7 — Terminal-cache & scratch-tab lifecycle ✅ SHIPPED (PR #141 `a387e1b`, 2026-06-10)

**Goal.** No orphaned scratch PTYs or leaked xterm/WebGL cache entries; a visible pane never loses its renderer; prompt cards survive remounts.

**Deliverables.**
- Module-scope `scratch-tabs.ts` store keyed by parent session + single `closeScratchTab` teardown; cache GC reaps scratch of vanished parents (**ADR-005**).
- LRU eviction skips host-attached entries; `WebglAddon` moves to attach/detach so GPU contexts ≈ visible panes (PR #133 fit/drag invariants preserved).
- Module-scope `prompt-watcher.ts` (ProtocolLineBuffer per session); cache-hit `ctx` refresh; snapshot double-write fix (main-side coalescer flush + renderer overlap trim).
- Plan: `app/docs/superpowers/plans/2026-06-10-terminal-cache-scratch-lifecycle.md`.

**Why now.** Hotlist #11: every scratch tab ever opened currently leaks a PTY + cache entry; WebGL contexts beyond Chromium's ~16 cap silently downgrade *visible* panes to the slow DOM renderer.

**Scope.** `PaneShell.tsx:145-186` · `terminal-cache.ts:54,198,224,264,345` · `use-terminal-cache-gc.ts:33` · `use-prompt-card.ts:63`. Per plan.

**Findings + recommendation.** Hoist-to-module-scope chosen over unmount-as-close — a room switch must not kill the user's shell; the snapshot double-write was verified real on the main side (registry ring + ≤12 ms coalescer vs unflushed read).

**Risks.** Same files as Phase 3's copy/paste + screenshot work → rebase after it lands. WebGL attach churn — `onContextLoss` fallback retained; real context counts are an operator/CI-e2e check.

**Definition of done.** Scratch tab survives a room switch and dies on pane close with its cache entry destroyed (tests); LRU never evicts an attached entry; prompt card appears for a line received while unmounted; full gate + CI.

## Phase 8 — Perf: main-loop hot paths ✅ SHIPPED (PR #142 `ec42de4`, 2026-06-10)

**Goal.** Zero main-loop blocking from stats polling, zero polling while the window is hidden, and pane-header git status costs one process and two fields.

**Deliverables.**
- `ps-snapshot.ts` — one async `ps` per 2.5 s TTL window behind a per-platform `ProcessLister` seam (pre-fitted to Phase 11's win32 backend).
- Generic refcounted `shared-poll.ts` (visibility pause, overlap guard, phase stagger); `usePaneLiveStats`/`useSwarmLiveStats` rebased onto it.
- `git.statusSummary` RPC (4→1 git procs/poll, count-only payload) across all 4 mirrored sites; cached boot PATH (`shell-path.ts`, window creation ungated); 250 ms event coalesce in `runRefreshOnEvent`.
- Plan: `app/docs/superpowers/plans/2026-06-10-perf-hot-paths.md`.

**Why now.** ~280 ms of main-loop blockage per 3 s window at 12 panes = typing/stream hitches at exactly the multi-pane load SigmaLink exists for.

**Scope.** `process-tree.ts:47` · `usePaneLiveStats.ts:179` · `useSwarmLiveStats.ts:101` · `git-ops.ts:64` · `electron/main.ts:740` · `parsers.ts:39`. Per plan.

**Findings + recommendation.** `gitStatus` actually spawns **4** procs per poll (audit undercounted); this phase subsumes Phase 10's minimal poller overlap guard. Complements Phase 1's process-tree diagnostics (same module, different layer).

**Risks.** PATH-cache staleness (async refresh, ≤3.5 s cap gates only the first PTY spawn); count parity with the old payload (MM double-count parity test).

**Definition of done.** No `execFileSync` on the stats path; 0 RPCs while `document.hidden`; summary parity tests green; full gate + operator `npm run test:perf` jank delta.

## Phase 9 — Perf: render & bundle ✅ SHIPPED (PR #143 `67b8f1b`, 2026-06-10 · vendor-react 636→193 kB)

**Goal.** Boot parses ~450 KB less JS and long transcripts/mailboxes re-render only what changed.

**Deliverables.**
- Inline-SVG `GitActivityStrip` + `recharts` uninstalled + exact `react|react-dom|scheduler` vendor matcher (baseline recorded: vendor-react 636.08 kB).
- `memo(MailboxBubble)`/`memo(ChatRow)` + `useMemo` tool-blob prettyPrint; selectorization: `JorvisRoom`, **`use-jorvis-conversations`** (sibling catch — without it the JorvisRoom fix is a no-op), `EditorTab`, `RufloReadinessPill`, onboarding trio.
- `SWARM_MESSAGES_CAP = 500` drop-head in `APPEND_SWARM_MESSAGE`.
- Plan: `app/docs/superpowers/plans/2026-06-10-perf-render-and-bundle.md`.

**Why now.** Cheap (S–M) and user-feelable on every boot and every long Jorvis/swarm conversation.

**Scope.** `vite.config.ts:29` · `GitActivityStrip.tsx` · `MailboxBubble.tsx:87` · `ChatTranscript.tsx:148,283` · `state.reducer.ts:528`. Per plan.

**Findings + recommendation.** Inline SVG over `React.lazy` — deletes the dependency instead of deferring it, no Suspense flash in a 16 px strip. `runGroups` memoization refuted (already shipped) — only the cap lands.

**Risks.** `memo(ChatRow)` vs the Phase-6/PR-#133 stream-sentinel→committed key handoff — pinned by a control test. ChatTranscript is concurrent-session-active — pre-flight re-verify per task.

**Definition of done.** vendor-react chunk ≈ react+react-dom only (~180–200 kB); render-count probes green; full gate + CI.

## Phase 10 — Renderer state & Jorvis correctness ✅ SHIPPED (PR #144 `54e08ad` jorvis + PR #145 `74fdfc4` state, 2026-06-10)

**Goal.** Room persistence can't be hijacked by global rooms, and Jorvis events/conversations render correctly under every race the audit reproduced.

**Deliverables.**
- Exported `GLOBAL_ROOMS`/`isGlobalRoom` single source of truth + anti-drift tests enumerating **all four** guard sites.
- Copy-on-add `PaneEventStore`; hydrate request-tokens; jump-to-message frame-retry (+ ref'd conversationId so it can't self-cancel) + timer cleanup; updater-side-effect fixes (`toggleRail`, `setMessages`); Composer `{value,nonce}` clear; snapshot flush-on-unload; Splitter/PaneDivider unmount cleanup (divider fires `onResizeEnd` exactly once → the PR #133 refit-suppression flag can never wedge); Launcher/Sidebar swarm-hydration alignment.
- Plans: `app/docs/superpowers/plans/2026-06-10-renderer-state-room-fixes.md` · `…/2026-06-10-jorvis-renderer-fixes.md`.

**Why now.** A MED-correctness cluster of all-S fixes with outsized annoyance payoff (boot-into-Settings, invisible pane-event cards, wrong conversation painted after a fast switch).

**Scope.** `state.reducer.ts:276` · `use-session-restore.ts:267,307-319` · `use-jorvis-pane-events.ts:27` · `use-jorvis-conversations.ts:92-125` · `Splitter.tsx:47` · `PaneDivider.tsx:49-68` · `Launcher.tsx:397` vs `Sidebar.tsx:188`. Per plans.

**Findings + recommendation.** The `useSyncExternalStore` mutate-in-place bug is masked by `clear()` allocating a new array — the new test asserts a re-render from `add()` alone; the poller overlap guard here is written minimal so Phase 8 subsumes it.

**Risks.** `PaneShell.tsx:261`/PaneDivider edits are adjacent to Phases 3 and 7 — the flashDrop one-liner is skip-if-rewritten; StrictMode double-fire tests pin the updater fixes.

**Definition of done.** Anti-drift matrix green at all 4 sites for every `GLOBAL_ROOMS` member; out-of-order hydrate test green; StrictMode double-invoke tests green; full gate + CI.

## Phase 11 — Windows runtime readiness ✅ SHIPPED (PR #148 `eb97a3a`, 2026-06-11 · Windows-CI verified) *(feeds the W-4 device dogfood)*

> **SHIPPED (2026-06-11):** both win32 plans (spawn-correctness + platform-services) integrated and merged via PR #148, with the `workspaces.open` regression FIXED and verified green on the windows-latest smoke (the dogfood test that hung at 180s now passes). The fix: `resolveLaunch()` no longer falls through to a `npx -y @claude-flow/cli@latest` **auto-download during the awaited open** (tier-4 removed → returns null when ruflo isn't installed → fast stdio fallback, the pre-regression behavior); `seedWorkspaceMemory` gated on `commandOnPath('ruflo')`; the platform branch's `taskkill /T /F` tree-kill reaps timed-out spawns. ruflo-installed (PATH/userData) behavior unchanged. Superseded #146 (closed). **Device-gated tail remains for W-4** (real ConPTY feel, hardlink resume without Dev Mode, kill/reap EBUSY, MAX_PATH, voice natives, and the H-6 shell-first lift which is pre-written but left unlifted) — these need a real Windows box; code is in place.

**Goal.** Every CLI/daemon spawn works on stock Windows, process trees are killable and measurable, the resume bridge needs no privileges, and the whole `.cmd` class is CI-visible.

**Deliverables.**
- Cross-spawn `cmdEscapeArg`/`cmdEscapeCommandPath` (+`doubleEscape` for npm-shim `%*` re-parse) with table-driven pure tests; `spawnExecutable` routing at all six raw sites (incl. the `launchChild:604` twin and `verify.ts:229` probes the audit missed); verbatim `openShell`; win32 `SHELL`-ignore via `defaultShell()`.
- **windows-latest vitest CI leg** + stub-`.cmd` argv round-trip integration test (**ADR-006**).
- `process-list-win32.ts` (CIM enumeration + `taskkill /PID /T /F`) as the Phase-8 `ProcessLister` backend; `rm-retry.ts` EBUSY backoff; symlink→hardlink/junction→copy resume ladder; win32 PTT default `Ctrl+Shift+Space` + persistent `hotkeyRegistered` status; cursor win32 PowerShell installer + `installCommandFor()` (kills the linux-fallback-on-win32 at main AND renderer mirrors); `isInsideAnyRoot`; `core.longpaths` at all three worktree-add sites; H-6 shell-first lift pre-written but device-gated.
- Plans: `app/docs/superpowers/plans/2026-06-10-win32-spawn-correctness.md` · `…/2026-06-10-win32-platform-services.md`.

**Why now.** Windows is a shipped release target whose core job — launching `claude.cmd` — is broken in committed state, and green CI is structurally blind to it (no CLIs on runners; vitest never ran on the Windows leg).

**Scope.** `spawn-cross-platform.ts` · `windows-spawn.ts:88-96` · `http-daemon-supervisor.ts:306,325,376,604` · `seed-workspace-memory.ts:59` · `rpc-router.ts:915,1033,891,1031` · `process-tree.ts:42` · `cleanup.ts:139` · `claude-resume-sigma.ts:166` · `git-ops.ts:493` · `providers.ts:206` · `global-capture.ts:199`. Per plans (15 spawn call sites classified).

**Findings + recommendation.** PR #134 already shipped the verbatim plumbing — the residual confirmed bug is `cmdQuoteArg`'s escaping (carets literal inside quotes; odd `\"` toggles quote state = injection risk; `%VAR%` expands through quotes). Per-platform `installCommand` schema already exists — the bugs were value/resolution-level.

**Risks.** cmd.exe escaping is notoriously subtle — table-driven pure tests run on macOS too; everything device-only is an explicit 9-item checklist handed to W-4, and the H-6 lift stays gated on it.

**Definition of done.** Stub-`.cmd` argv round-trip green on windows-latest; all 15 spawn sites classified and routed; resume bridge succeeds without Developer Mode in the win32 CI test where mockable; device checklist published for W-4.

## Phase 12 — Dead-code sweep ✅ SHIPPED (PR #149 `a3b5837`, 2026-06-11)

> Landed the concurrent session's already-implemented `fix/dead-code-removal` work (PR #147 closed/reassigned): cherry-picked 8 commits, re-verified every deletion still-dead at HEAD, hand-edited `package.json` deps. `+36/−571`, 24 files; removed `monaco-editor` + `@radix-ui/react-separator` + 5 zero-importer modules + the dead voice-stats twin. The PaneShell `inSplitGroup` removal (this plan's Task 4) shipped via the Phase-3 follow-ups PR #150 to keep a single PaneShell owner. Full gate + CI green; lead dynamic-reference hunt (CSS-in-JS / lazy-import) clean.

**Goal.** ~470 dead LOC and two unused dependencies removed with zero behavior change.

**Deliverables.**
- `monaco-editor` + `@radix-ui/react-separator` dropped; `events.ts`, `sheet.tsx`, `separator.tsx`, `use-mobile.ts`, `skeleton.tsx` deleted (incl. the reflection-import test block + orphaned `sheetSideMotion`).
- Dead `data-grid-density` selector + `inSplitGroup` prop + `.memory-tri-grid` CSS + 4 stale GridLayout comments removed; `voice-stats.ts` repointed via a new voice-core `SessionStat` re-export then deleted; `HlcPacked`/`ProjectId` removed (the other 10 types verified live in-file and kept).
- Plan: `app/docs/superpowers/plans/2026-06-10-dead-code-removal.md` (isolated worktree, per-item re-verify `rg` gates).

**Why now.** Cheap hygiene that shrinks install weight and search surface — safe only because every deletion re-verifies liveness at execution time.

**Scope.** Per plan, Tasks 0–11, each deletion gated by verify-rg → delete → `tsc -b` + targeted vitest → commit.

**Findings + recommendation.** Plan-time verification downgraded `types.ts` from 12 removals to 2 and found a hidden reflection-import of `sheet.tsx` — proving the per-item re-verify protocol is load-bearing. `npm run product:check` is mandatory in the gate (tsc never compiles `electron/main.ts`; a past "dead" deletion broke prod through a green tsc).

**Risks.** "Dead" misjudgment — per-item verify + post-delete gates; the `src/main/core/voice/` tree is LIVE (only `voice-stats.ts` moves).

**Definition of done.** All deletions land with the full gate green incl. `product:check`; `pnpm-workspace.yaml` untouched (or reverted) after dep removals; zero runtime diffs.

## Phase 13 — Pane close lifecycle (deliberate-close soft-delete) ✅ Part A SHIPPED (PR #161 `a0e9bee`, 2026-06-12 · CI 4/4 green · rides next release) — Part B (Recents) remains

> **Part A executed subagent-driven 2026-06-11/12** (plan authored by a parallel session): 3 impl units + per-unit spec/Opus-quality reviews + final whole-branch integration review. Review-loop catches folded in: migration `hasColumn` cross-process guard · `lastResumePlan` twin CTE filter · launcher resume-jump max-slot preset fix (`inferResumeGridPreset`) · `closed_at` into sync `COLUMN_ALLOWLIST` (drift test caught — a missed allowlist would have resurrected closed panes on synced peers). Deferred: Part B Tasks 12–13 (Recently-closed list + reopen) → follow-on PR; `handleRelaunch` close-write + silent `panes.close` failure toast → wishlist. Two operator-reported bugs (hotlist #13/#14), 3-agent root-cause sweep + Opus verification against live code. Full TDD plan: `app/docs/superpowers/plans/2026-06-11-pane-close-lifecycle.md`. Operator design choices (AskUserQuestion 2026-06-11): `closed_at` soft-delete column + Recents-recoverable.

**Goal.** Deliberately closing a pane (× button, context-menu, or the Jorvis `close_pane` tool) keeps it closed across restarts and never raises a "Pane exited" toast; an accidental close is reopenable from a Recents list.

**Deliverables.**
- Migration `0037_agent_sessions_closed_at.ts` (+ test) — nullable `closed_at` epoch-ms soft-delete column + recents index; `agentSessions.closedAt` in `schema.ts`.
- `src/main/core/pty/mark-pane-closed.ts` — `markPaneClosed(db, sessionId, now)` shared primitive (+ test).
- `panes.close(sessionId)` RPC (mark-then-kill) across the router-shape / rpc-channels / schemas sibling surfaces; `handleRemove` + `close_pane` tool both routed through it.
- Toast suppression in `pushPtyExitNotification` (injectable `resolveSessionMeta`, early-return when `closed_at` set) (+ test).
- `AND closed_at IS NULL` on `listForWorkspace`, `listEligibleRows`, `listRespawnableRows` (+ SQL-shape guards).
- **Part B (follow-on PR):** `panes.listClosed` + `panes.reopen` (`clearClosedMarker` + extracted `respawnSessionById`) + a "Recently closed" UI affordance mirroring the browser-tab recents.

**Why now.** Both are daily-driver friction on the core Command Room flow: a closed pane that re-opens on every restart erodes trust in persistence (the operator's words: "db working good that even manually closed panes are opening up lol"), and a crash-style toast on an intentional action is alarming noise. Cheap (S+M), fully root-caused, and they fix a latent half-bug in `close_pane` too.

**Scope.** (ordered; full TDD detail in the plan)
1. Migration 0037 + drizzle `schema.ts:90` column + index — `migrate.ts:44,96` registration (lexical-order test enforced).
2. `markPaneClosed` primitive (raw-SQL, `MockDb`-testable).
3. `panes.close` RPC at `rpc-router.ts:1064` (uses `getRawDb()`, `Date.now()`); mirror across `src/shared/router-shape.ts` / `src/shared/rpc-channels.ts` / `src/main/core/rpc/schemas.ts` (grep `rename`/`kill`).
4. `handleRemove` `CommandRoom.tsx:257-262` → `rpc.panes.close` (drop the status guard; keep `handleStop` on `pty.kill`).
5. `close_pane` tool `tools.ts:356-373` → mark-then-kill (drop the redundant drizzle status write; tool list/DANGEROUS_REMOTE unchanged so `authorization` `toEqual` stays green).
6. Bug 1 — `pty-exit.ts:47-74` suppression. Bug 2 tile — `rpc-router.ts:1236`. Bug 2 resume — `resume-launcher.ts:346,481`.
7. Reaper keep⊇use check (`db/janitor.ts`; ADR-004 invariant holds trivially — use-set shrank).

**Findings + recommendation.** Both bugs share ONE structural cause: the manual × path is a poor cousin of `close_pane` (kills the PTY, skips the bookkeeping), and `close_pane` is itself only half resume-proof (`status='exited',code=0` blocks the live re-spawn but `listForWorkspace` ignores status, so the dead tile still rehydrates). `status` is racy — the late `onExit` write flips a killed `running` pane to `'error'`/143 — so a **durable** marker is required. Chosen: a single `closed_at` soft-delete (parity with `browser_tabs` mig 0033) that every exclusion keys off, routed through one shared close primitive (kills the sibling-miss). Rejected: reuse `status='exited',code=0` (can't distinguish a deliberate close from an agent finishing cleanly → naturally-finished panes would also vanish); clear `pane_index` (loses the slot; `listEligibleRows` ignores `pane_index` so a lost-race row still resumes). See ADR-007.

**Risks.** New RPC touches the router-shape/rpc-channels/schemas sibling triple — plan has an explicit grep-and-mirror step. Ordering invariant: `markPaneClosed` MUST run before `pty.kill` everywhere or the async exit misses the marker (encoded in Tasks 4+6). `close_pane` body change must not alter the tool list (authorization `toEqual` tripwire). DB-touching code is `MockDb`/SQL-shape tested (better-sqlite3 won't load under vitest). e2e deferred to CI (never local).

**Definition of done.** Operator can: ① click × on a running pane → **no toast**, tile vanishes; ② quit + reopen → the closed pane stays gone while live panes resume, and a naturally-finished (exit 0) pane left on screen still rehydrates; ③ (Part B) reopen an accidentally-closed pane from a "Recently closed" list. Full local gate (`tsc -b`/vitest/eslint/build) + CI e2e-matrix green.

## Phase 14 — SigmaLink Dev workspace (singleton plain-terminal bench at ~) ✅ SHIPPED (PR #158 `9cda070`, 2026-06-11 · CI 4/4 green · rides next release)

> Full TDD plan: `app/docs/superpowers/plans/2026-06-11-sigmalink-dev-workspace.md` · Spec: `app/docs/superpowers/specs/2026-06-11-sigmalink-dev-workspace-design.md`. Operator design choices (AskUserQuestion 2026-06-11): singleton · respawn-fresh-on-restart · sidebar "+" menu entry · numeric stepper 1–12. Subagent-driven execution: 6 units + per-unit spec/Opus-quality reviews + final whole-branch integration review; 4 green-but-broken issues fixed pre-PR (factory-spawn MCP twin gate-by-construction · launch re-entrancy ref-guard · openWorkspace dedup hazard · by-path reopen leak → `openDevWorkspace` delegation choke point). Accepted deviations: static menu label; modal dialog (not popover); agent panes at ~ out of scope. NOTE: shell respawn-on-boot now applies to ALL workspaces (verified safe).

**Goal.** One menu click gives the operator a grid of N plain shell terminals at `~` — no repo, no worktrees, no agent CLIs — that survives restarts by respawning fresh shells.

**Deliverables.**
- `app/src/shared/special-workspace.ts` — singleton KV contract (`workspace.devWorkspace.id`, name "SigmaLink Dev", 12-pane cap) (+ test)
- `openDevWorkspace()` in `app/src/main/core/workspaces/factory.ts` — forced-`plain` row at `os.homedir()` (never probes `getRepoRoot(~)`), ALL open side effects skipped (no `.mcp.json`/trust/memory-seed into `~`), dangling-pointer self-heal (+ `factory.dev.test.ts`)
- `workspaces.openDev` RPC across all FOUR mirror sites (`router-shape.ts` / `rpc-router.ts` / `rpc-channels.ts` CHANNELS / `rpc-channels.test.ts` TYPED_ROUTER_CHANNELS)
- `'shell'` case in `buildResumeArgs` (`app/src/main/core/pty/resume-launcher.ts:80-132`) — boot-resume respawns dead shells fresh (empty args ⇒ `freshFallback`; user-`exit`ed shells stay closed)
- Shell-provider gate around the per-pane MCP wiring block (`app/src/main/core/workspaces/launcher.ts:262-305`) — `writeMcpConfigForAgent`/`ensureRufloMcpForPane` never write into a shell pane's cwd
- Jorvis read-roots exclusion for the dev workspace (`app/src/main/core/assistant/tools.ts:250-262`) — `~` never widens the assistant's read scope
- Renderer: `DevWorkspaceDialog.tsx` (CounterControls stepper 1–12, default 4) + `WorkspacesPanel` menu item / DEV badge / `~` subtitle + `Sidebar` open/launch flow (mirrors boot-restore Path A: resume → hydrate → route)
- Drive-by hotlist fix #15 (`workspaces.rename`/`openNew` into CHANNELS + test list)

**Why now.** Operator-requested (2026-06-11): a frictionless "just give me terminals" daily-driver bench without polluting `~` with workspace side effects. 4-lane recon shows ~90% of the machinery already exists (`repoMode:'plain'` skips both worktree gates; the `'shell'` provider already spawns `$SHELL -l`; the grid auto-tiles any N) — high value, low effort. Hotlist #15 rides along because Task 3 edits the exact same allowlist lines.

**Scope.** Execute the 9-task TDD plan (all line numbers verified on `main` @ `41f6e53`): shared contract → `openDevWorkspace` factory → RPC quad → allowlist drive-by → shell resume case → MCP-wiring gate → Jorvis exclusion → renderer (menu/dialog/badge/flow) → full local gate (tsc/lint/vitest/build; e2e via CI only).

**Findings + recommendation.** Recon (2 Sonnet + 2 Haiku read-only Explore lanes) + lead verification: plain workspaces already skip launcher Gate A (`launcher.ts:225`) and factory-spawn Gate B (`factory-spawn.ts:285`); resume eligibility (`running` ∪ `exited(-1)`) means only `buildResumeArgs`'s `null` return blocks shell respawn (the boot janitor marks app-quit survivors `exited(-1)`); the dangerous side effects are open-time autowrite/seed (skipped by the new factory) and per-pane MCP writes into cwd (gated on non-shell). Chosen approach: **zero schema change** — KV pointer, no `kind` column (ADR-008); rejected a `kind` migration (churn for one flavor) and a non-workspace "Dev Terminals room" (breaks "selectable in the workspace menu").

**Risks.** FS sandbox necessarily widens to `~` for PTY/fs RPCs (inherent to the feature) — mitigated by the Jorvis read-roots exclusion + zero config written into `~`. Resume-path edits have a sibling-miss history — the plan deliberately mirrors boot-restore Path A only and keeps `default: null` for unknown providers. `GridPreset` is a closed union: odd N passes nearest-preset-≥N while `panes.length = N` (`executeLaunchPlan` iterates `plan.panes`, never validates against `preset` — verified `launcher.ts:170-230`; executor re-verifies at Task 8). Phase 13 lands a `closed_at` filter on the same read-paths — if it merges first, rebase Task 5/8 trivially (additive `AND`).

**Definition of done.** An operator can: click "+ → SigmaLink Dev", pick 5, get 5 live shells at `~`; quit + relaunch → the dev workspace's shells respawn fresh; `~/.mcp.json` and `~/.sigmamemory/` are NOT created; renaming a NORMAL workspace persists across restart (hotlist #15); full local gate green + PR CI e2e-matrix green.

---

## Phase 15 — win32 DB lifecycle: reopen crash + WAL bloat *(operator-reported on the W-4 device, 2026-06-11; Phase 13/14 numbers reserved by the concurrent session's in-flight work)*

**Goal.** SigmaLink on Windows reopens cleanly after a close — no "database is locked" main-process crash dialog, workspace state resumes, and `sigmalink.db-wal` stops growing across runs.

**Root cause (operator-confirmed: ① crash dialog mentions database locked/busy, ② orphan node processes linger after close, ③ `-wal` is tens of MB).** Every agent CLI spawns its own `mcp-memory-server.cjs` — a persistent better-sqlite3 **writer** on `sigmalink.db` via full `initializeDatabase()` (`mcp-server.ts:191`). On win32 quit, `taskkill /T` only walks **surviving** ppid links; the `.cmd`-shim chain exits early and reparents those grandchildren → they outlive the app holding the db/`-shm`. Reopen: `journal_mode=WAL` (a lock-acquiring statement) ran **before** `busy_timeout` → instant `SQLITE_BUSY` → uncaught through `bootstrapAndMigrate`/`registerRouter` → crash dialog. Quit: `wal_checkpoint(TRUNCATE)` always failed against orphan readers → unbounded WAL. macOS unaffected (working `ps` tree-kill + advisory locks).

**Deliverables.**
- `busy_timeout` FIRST in `openAndCheck` (+ source-text tripwire test).
- `core/process/orphan-sweep.ts` — boot-time win32 orphan sweep by CIM `CommandLine` marker (`mcp-memory-server.cjs`), reparenting-proof, fail-open; runs before the DB open.
- `core/db/boot-open.ts` — `openDatabaseWithBootRetry` (bounded busy-retry; non-busy errors rethrow immediately) + boot-time `wal_checkpoint(TRUNCATE)` reclaiming historic WAL bloat.
- Quit ordering: capture PTY root pids → `killAll()` → bounded `waitForPidsExit` (≤2.5 s) **before** `closeDatabase()` so handles release and the quit checkpoint can TRUNCATE.
- Plan: `app/docs/superpowers/plans/2026-06-11-win32-db-lifecycle.md`. All helpers dependency-injected; unit tests execute for real on the windows-latest vitest CI leg (ADR-006).

**Definition of done.** Tests green on windows-latest CI; operator device check: close → no lingering node processes (or boot sweep clears them) → reopen → no dialog, workspaces resume → `-wal` shrinks. **Deferred (wishlist):** memory-server redesign (full bootstrap+migrate per CLI spawn = N concurrent DDL writers by design); WAL-size telemetry.

---

## Hotfix — Jorvis terminal access ✅ SHIPPED (PR #157 `5ac6e3a`, 2026-06-11 · main CI green; rides the NEXT release — NOT in v2.3.0, which tagged before the merge)

**Goal.** Jorvis can read any pane's terminal screen and every advertised tool is actually callable, with dead-session interactions failing loudly instead of silently.

**Deliverables.**
- `app/src/main/core/assistant/tool-catalogue.ts` — single-source MCP `tools/list` (pure data, host-bundle-safe) + `tool-catalogue.test.ts` three-surface parity contract (tools.ts ids ↔ catalogue ↔ system-prompt blurb).
- New `read_pane` tool (`{sessionId, maxBytes?}` → ANSI-stripped scrollback tail via `registry.snapshot()`, aidefence-scanned) + `pane-screen.ts` pure extractor.
- `prompt_agent` liveness guard (`registry.isLive()`/`has()`); throws on ghosts so traces record `ok:false`.
- Spec `app/docs/superpowers/specs/2026-06-11-jorvis-terminal-access-design.md` · plan `app/docs/superpowers/plans/2026-06-11-jorvis-terminal-access.md`.

**Why now.** Operator-reported outage class: in prod v2.2.0 Jorvis "can't access terminals, can't interact" — hotlist #17–19; the drift class (PR #137 sibling-miss) will recur without the contract test.

**Scope.** Hotlist rows #17–19; 4-task TDD plan (catalogue+parity → read_pane → liveness guard → sibling sweep/gate/PR).

**Findings + recommendation.** Verified in code + live DB: `--strict-mcp-config` makes the host catalogue the ONLY callable surface (`runClaudeCliTurn.args.ts:82`); zero `ok:false` traces ever recorded because failures happen CLI-side; `broadcast_to_swarm`/`roll_call` ride the mailbox (not `pty.write`) so the liveness fix correctly targets `prompt_agent` only. Chose shared-data catalogue + parity tests over runtime forwarding (socket boot race) and over hand-sync (already drifted once).

**Risks.** Host esbuild bundle must stay heavy-import-free — catalogue is pure data (test: bundle builds). Existing tests enumerating tool counts/names need updating, not weakening. read_pane ingests other agents' untrusted output — gated through `scanIngested` (H-19), capped 64 KiB, NOT in `DANGEROUS_REMOTE` (read-only).

**Definition of done.** Jorvis (prod build) can `read_pane` a live builder's screen and gets a loud error prompting a ghost; `tool-catalogue.test.ts` fails on any future surface drift; full gate + CI green; PR merged. STATUS: merged `5ac6e3a`; the prod-build check lands with the next release.

---

## Architecture decisions (ADRs)

### ADR-001 — Prefer shared Ruflo HTTP over per-pane stdio
**Decision.** Ruflo is treated as a per-workspace shared HTTP daemon for normal pane launches, with per-pane stdio MCP retained only as a degraded fallback. **Context.** Per-pane stdio MCP duplicates `npx/node` process trees and can dominate pane RSS. **Consequences.** (+) Lower RAM and faster warm pane launches. (+) Existing pane functionality survives through fallback. (-) Launch now depends on daemon readiness when possible, so the helper must be fail-open and testable.

### ADR-002 — Keep Tauri migration out of the RAM hot path
**Decision.** Do not migrate the backend to Tauri as the first RAM optimization. **Context.** Electron host overhead is real, but the observed 300 MB-1 GB pane costs are mostly child Claude/Codex/MCP trees. **Consequences.** (+) Directly addresses the largest avoidable memory source. (-) Baseline Electron overhead remains until a separate runtime migration phase is justified.

### ADR-003 — Image-to-agent via staged temp file + absolute @path, not clipboard-write
**Decision.** Pane screenshot drop/paste hands an image to the CLI by staging the bytes to `<userData>/staged-images/` and injecting the absolute path into the prompt — never by writing the image to the system clipboard. **Context.** Both Claude Code and Codex read images CLI-side from the OS clipboard on Ctrl+V (the PTY is a text pipe; terminal graphics protocols like OSC 1337 are display-only, not input). But Electron's `clipboard.writeImage` writes `public.png` while Claude Code's reader is `osascript 'the clipboard as «class PNGf»'` (legacy type) — the write silently misses (anthropics/claude-code#30936, open as of 2026-06). Both CLIs DO read an image file path from the prompt. **Consequences.** (+) Works today for both CLIs, no upstream dependency, no clipboard-type gymnastics; staging is validated (ext allowlist, 20 MB cap, server-generated filename). (+) Gated per provider via `IMAGE_CAPABLE_PROVIDERS`. (−) Bypasses the CLIs' native `[Image #N]` paste UX — the image arrives as a path mention. (−) Staged files accumulate in userData until a future janitor sweep (transient inputs; acceptable).

### ADR-004 — One shared worktree keep-predicate; keep⊇use is a CI-enforced invariant
**Decision.** Every worktree GC/prune path consumes a single exported keep-predicate (`worktree-cleanup.ts`), and a dedicated test asserts the keep-set is a superset of every resume/respawn use-predicate, with a source tripwire pinning `resume-launcher.ts`'s eligibility rules. **Context.** The fence drifted twice (the `93fbca6` pane-resume regression, then the SF-13 cleanup twin) because two files re-encoded eligibility independently; the second drift also crossed workspace boundaries in the shared `repoHash` dir. **Consequences.** (+) Predicate drift becomes a CI failure instead of a data-loss incident. (+) Sweeps spare sibling workspaces by construction. (−) The reaper keeps more disk (bounded by the 7-day window).

### ADR-005 — Scratch-tab state is module-scope with one teardown choke point
**Decision.** Scratch terminal tabs live in a module-scope store keyed by parent session (the terminal-cache pattern), torn down only via `closeScratchTab` — on pane close or GC of vanished parents — never implicitly by component unmount. **Context.** Per-mount `useState` reset on every room/workspace switch, orphaning PTYs and xterm/WebGL cache entries the GC couldn't see; unmount-as-close was rejected because a room switch must not kill the user's shell. **Consequences.** (+) Scratch shells survive navigation and leaks become structurally impossible (the GC enumerates them). (−) One more module-scope store to reason about (same family as terminal-cache/PaneSplash).

### ADR-006 — win32 spawn = verbatim command line + cross-spawn escaping, proven by a CI stub-shim
**Decision.** Windows spawns hand cmd.exe a single hand-built verbatim command line (`windowsVerbatimArguments` / node-pty string `commandLine`) escaped with cross-spawn's caret-escape-everything algorithm, and CI gains a windows-latest vitest leg whose stub `.cmd` shim round-trips argv. **Context.** PR #134 shipped the verbatim plumbing, but `cmdQuoteArg` still corrupts `^ % !` and odd quotes (quote-state toggle = injection risk); vitest had never executed on the Windows CI leg, so the entire class stayed invisible behind green e2e. **Consequences.** (+) The primary provider (`claude.cmd`) becomes launchable on stock Windows and regressions fail CI. (−) A slightly slower CI matrix and a cmd.exe escaping table to maintain.

### ADR-007 — `closed_at` is the durable deliberate-close axis; one shared close primitive
**Decision.** A deliberately-closed pane is marked by a nullable `agent_sessions.closed_at` soft-delete column (parity with `browser_tabs`, mig 0033), written by ONE shared primitive (`markPaneClosed`) BEFORE the PTY kill, and consumed by every lifecycle decision: the exit-notification source suppresses the toast when it is set, and both boot read-paths (`listForWorkspace` grid rehydrate + `listEligibleRows`/`listRespawnableRows` resume) exclude `closed_at IS NOT NULL`. The × button, context-menu close, and the `close_pane` tool all route through the same primitive. **Context.** Manual close and `close_pane` had diverged into three close paths; manual close wrote nothing the boot read-paths excluded (resurrection) and raised a crash-style toast (no intentional-close marker). `status` is unusable as the marker because the launcher's late `onExit` write overwrites a killed `running` pane's status to `'error'`/143, and a clean `exited/0` is indistinguishable from an agent finishing on its own. **Consequences.** (+) Both bugs fixed by one durable marker; `close_pane`'s latent half-resurrection is fixed too; future close-sites can't drift (single choke point). (+) Closed rows are retained for a Recents/reopen affordance and reaped on the normal window (keep⊇use, ADR-004, holds trivially — the use-set shrank). (−) A new column + migration, and a mark-before-kill ordering invariant that every close site must honor.

### ADR-008 — Special workspaces are KV-marked, not schema-typed
**Decision.** The "SigmaLink Dev" singleton is identified by a KV pointer (`workspace.devWorkspace.id`) plus forced `repoMode:'plain'`/`repoRoot:null` — NOT by a new `kind`/`type` column on `workspaces`. **Context.** Only one special flavor exists; `repoMode:'plain'` already short-circuits every worktree/git/janitor path (both spawn gates, boot janitor, orphan cleanup, auto-checkpoint), and the shared-KV-contract pattern is established (`shared/worktree-mode.ts`). A migration would buy nothing today. **Consequences.** (+) Zero migration risk; reuses both existing spawn gates unchanged; a deleted row self-heals (recreate + repoint). (−) Specialness is invisible in the `workspaces` table itself (must join KV to see it); a second special flavor later would justify revisiting a `kind` column.

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| Shared Ruflo HTTP launch policy | Phase 1 | M | High | Expected to remove duplicated Ruflo stdio child processes in normal panes. |
| Tree-aware bulk shutdown | Phase 1 | S | High | Prevents lingering MCP descendants after app/workspace shutdown. |
| Process-tree diagnostics payload | Phase 1 | S | Medium | Makes future 1 GB pane investigations concrete. |
| Lazy resume / idle suspend | Wishlist | L | High | Deferred until Phase 1 proves transport and cleanup behavior. |
| Tauri migration | Wishlist | XL | Medium | Reduces host overhead, not the primary child-process RAM cost. |
| `launch_pane` dispatch-echo | Phase 3 | S | High | Jorvis orchestration currently silently no-ops in the UI. |
| Pane Copy/Paste + copy-on-select | Phase 3 | S | High | Table-stakes terminal UX; selection currently uncopyable. |
| Screenshot staging (drop+paste → @path) | Phase 3 | M | High | Unblocks the most common multimodal input for claude/codex panes (ADR-003). |
| `swarms.resume` + Pane auto-resume | Phase 3 | S | Medium | Escape hatch for the post-restart `failed`-swarm lock (#134 edge). |
| Bootstrap index + workspace-remove lifecycle | Phase 4 | S+M | High | Boot-crash + headless-PTY orphan class; ADR-004. |
| Worktree reaper fence (keep⊇use, cross-ws) | Phase 4 | M | High | Active data-loss class; shared predicate ends the twin drift. |
| PTY lifecycle & resume correctness | Phase 5 | M | High | Stale-timer pane kills; uniform crash classification; sentinel carry. |
| RPC boundary & sink hardening | Phase 6 | M | High | Closes a renderer-reachable write primitive; un-silences disk-guard bells. |
| Terminal-cache & scratch-tab lifecycle | Phase 7 | M | High | PTY/WebGL leak; after Phase 3 (shared files); ADR-005. |
| Perf: main-loop hot paths | Phase 8 | M | High | Kills typing/stream hitches at multi-pane load; 4→1 git procs. |
| Perf: render & bundle | Phase 9 | S–M | Medium | −450 KB boot JS; smooth long transcripts/mailboxes. |
| Renderer state & Jorvis correctness | Phase 10 | M | Medium | Boot-room hijack + invisible pane events + hydrate races. |
| Windows runtime readiness | Phase 11 | L | High | Unbricks the shipped win32 target; ADR-006; feeds W-4. |
| Dead-code sweep | Phase 12 | S–M | Low | ~470 LOC + 2 deps; verify-first protocol is load-bearing. |
| Pane close: `closed_at` marker + no-resurrect + no toast | Phase 13 | S+M | High | Fixes hotlist #13/#14; one durable marker, one shared close primitive; ADR-007. |
| Recently-closed panes (listClosed + reopen + UI) | Phase 13 (Part B) | M | Medium | Recoverable accidental close; mirrors browser-tab recents. |
| SigmaLink Dev workspace (singleton + shell resume + containment + renderer) | Phase 14 | M | High | 9-task TDD plan; ~90% existing machinery; ADR-008. |
| CHANNELS allowlist fix (`rename`/`openNew`) | Phase 14 (Task 4) | S | High | Silent data-loss class (hotlist #15); rides the same edit. |
