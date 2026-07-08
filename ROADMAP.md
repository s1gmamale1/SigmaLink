# SigmaLink — Roadmap

SigmaLink is an Electron desktop workspace for launching and coordinating live Claude/Codex/Gemini/Kimi/OpenCode agent panes with worktrees, Ruflo memory/orchestration, browser tools, voice, and review workflows. The immediate operational concern is RAM pressure from live multipane agent process trees.

This ROADMAP is the single source of truth for what to build next.

> **Release status (2026-07-07).** Phases 1–18 have all SHIPPED (permanent record in CHANGELOG + master memory + Ruflo); Phase 17 (theme families) shipped in **v2.9.1** (`fa96ef2`, 2026-07-05, #212–#221, all platforms green). Released through **v2.9.1**. The doc is the ephemeral *next-up* whiteboard, not an archive. **Current arc: the Jorvis Persistent Operator (Phases 19–22)** — spec `app/docs/superpowers/specs/2026-07-07-jorvis-persistent-operator-design.md`, grounded by the 2026-07-07 five-lane recon (findings in [WISHLIST.md](WISHLIST.md)).

---

## How to read this

- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort** is S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Confirmed bugs are fixed before new feature phases.
- Shipped phases are archived in CHANGELOG and removed here; unscoped ideas + out-of-scope review findings live in [WISHLIST.md](WISHLIST.md).

---

## Open / next work

The Jorvis Persistent Operator arc (Phases 19–22, sequenced below, do in order) + one older scoped leftover (Phase 13 Part B).

## Phase 19 — Jorvis P0: reliability foundation

> ✅ **SHIPPED in PR #222 `2805d37` (2026-07-07)** — subagent-driven build (sonnet implementers + reviewers, opus whole-branch + sigma-check gates); round-1 gate caught a real non-atomic-turn-guard race (fixed + race-test-pinned same round), round-2 GREEN, CI 6/6. Unreleased — rides the next tag. Owed operator smokes (real `claude` binary): kill CLI mid-turn → error row + Retry · double-send → one child · fresh session keeps transcript · telegram `/new`. Low/edge findings parked in [WISHLIST.md](WISHLIST.md).

**Goal.** Jorvis is trustworthy day-to-day: no silent turn deaths, no mystery breakage after a CLI update, a fresh session is one action away.

**Deliverables.**
- Main-side per-conversation concurrent-turn guard (defined `busy` result; never a second `claude` child).
- Error rows in the transcript for every failure path (spawn fail / CLI exit / tool timeout / resume exhausted) + retry affordance; interrupted-turn banner extended to CLI-death.
- Envelope tolerance + recorded-fixture contract tests across claude CLI versions + a `claude --version` boot probe surfaced in diagnostics.
- "New session" action (app) + `/new` (Telegram): clears `claudeSessionId`, keeps transcript.
- Ride-along wishlist fixes: wire-or-delete orphan `assistant:security`; `resumeHint` schema stub; `refResolve` through path-guard; stale "13 tools"/test-title comments; kill the stale `docs/03-plan/WISHLIST.md` twin.

**Why now.** Operator verdict: Jorvis is unused because inconsistent — everything else in this arc is dark until turns are reliable. Lane zero.

**Scope.** Turn guard at `app/src/main/core/assistant/controller.ts:178,422` (`activeTurns` + `send()`); error paths in `runClaudeCliTurn.ts:266-282,379-393` + `runClaudeCliTurn.trajectory.ts:220-233`; envelope parsing `cli-envelope.ts:72-80`; fresh-session on `conversations.ts:85-103` (`setClaudeSessionId(null)`); orphan event at `controller.ts:189` vs `shared/rpc-channels.ts` EVENTS; `refResolve` at `controller.ts:780-839` through `core/security/path-guard.ts:91-116`; schema stub in `core/rpc/schemas.ts:952-955`.

**Findings + recommendation.** 2026-07-07 recon confirmed all targets with file:line receipts; every fix is a bounded change to an existing hardened path — no new architecture. Do this as one PR.

**Risks.** Envelope-tolerance behavior change could mask real protocol errors — mitigate: log+surface unknown subtypes in diagnostics, never swallow. Turn guard must not break the Telegram/external origins that legitimately send while the app chat idles — guard is per-conversation, not global.

**Definition of done.** Two rapid sends → one child + a defined busy result (test); every induced failure (kill the CLI mid-turn, break the binary path, time out a tool) produces a visible transcript error row; fixture tests pass against ≥2 recorded CLI envelope versions; `/new` + app "New session" verified live; full local gate (tsc -b / vitest / `eslint .` / build) + CI green.

## Phase 20 — Jorvis P1: mission core (kanban + supervisor loop)

> 🟡 **P1a (data layer) SHIPPED in PR #224 `bf103f4` (2026-07-08)** — mission tables (mig 0039) · pure state machine · DAO (guarded moveTask + rollup) · 5 board tools (+ external authz: mutations escalate, read free) · `missions.*` RPC + `missions:changed` · read-only Missions room · VALID_ROOMS compile-time exhaustiveness class-kill. Opus gates: whole-branch READY (axes 93-97) + sigma-check GREEN (~93.8), CI 6/6. Plan `app/docs/superpowers/plans/2026-07-08-jorvis-p1a-mission-board.md`. **P1b (the autonomy — `dispatch_task` pane launches, supervisor loop, wake scheduler, stub-CLI e2e) remains; the DoD below is P1b's.** Owed operator smoke: create a mission via jorvis chat → cards populate the Missions room live.

**Goal.** The operator hands Jorvis a natural-language goal; Jorvis decomposes it onto a kanban board, dispatches worktree-isolated panes, and drives them to done/blocked without per-step human involvement.

**Deliverables.**
- Migrations: `missions`, `mission_tasks` (indexed `(mission_id,status)` + `(assignee_session_id)`), `mission_events` (append-only timeline).
- `core/missions/state.ts` — pure lifecycle state machine + rollups, fully unit-tested.
- `core/missions/dao.ts` — board reads/writes.
- Mission tools in `tools.ts`/`tool-catalogue.ts`: `mission_board`, `dispatch_task`, `complete_task`, `block_task`, `update_task` (catalogue-parity extended).
- `core/operator/supervisor.ts` — decompose wake → deterministic watch (existing pane-event/notification sinks) → review wake (advance / done / blocked) → mission report.
- `core/operator/scheduler.ts` — wake queue, global brain lock, per-day budget + quiet hours (KV).
- Missions room (renderer): kanban columns, mission list, per-task detail (linked pane, worktree, timeline, report).
- Stub-CLI e2e: fake `claude` binary drives a full mission through the board, zero tokens.

**Why now.** The headline capability — "/goal but better, self-aware, human commanding a fleet." Requires Phase 19 (a supervisor on an unreliable turn engine is noise).

**Scope.** Watch hooks ride `rpc-router.ts:957-963` (`onPaneEvent`) + the notification sinks; dispatch wraps `launch_pane` (`tools.ts:427-485`) with worktree isolation + task↔pane linking; review turns use `read_pane` (`tools.ts:552-588`); board manipulated only through the new audited tools; origin `'autonomous'` threaded through `invokeAssistantTool` (`controller.ts:219-420`).

**Findings + recommendation.** SigmaLink already has the substrate: pane events, `monitor_pane`, `prompt_agent`/`read_pane`, swarms, notification sinks — the new work is the board (pure data), the loop (deterministic), and the wake scheduler. The brain stays behind `assistant.send`; no new model-spawning path. Absorb-or-bridge the existing `create_task` TasksManager decided at plan time.

**Risks.** Runaway wake loops (a flapping pane re-enqueueing forever) — mitigate: per-task attempt cap + budget hard-stop + dedupe on enqueue. Review-verdict quality — bounded review (spec vs receipts), escalate on uncertainty rather than loop. New tables = sync-engine mirror-site discipline (`core/sync/engine.ts:66-77` + `dirty-tracker.ts:13,44`).

**Definition of done.** Stub-CLI e2e runs a 3-task mission to `done` with zero human input; a deliberately-failing task lands `blocked` with an escalation notification; board UI reflects every transition live; wake budget hard-cap test passes; full local gate + CI green.

## Phase 21 — Jorvis P2: persistent identity (memory · charter · self-evolution)

**Goal.** Jorvis remembers across sessions and projects, operates under the Sigma-Profile charter, and grows competence via postmortems + playbooks — with prompt amendments only behind operator approval.

**Deliverables.**
- Global operator scope: workspace-less operator conversation + portfolio-injecting system prompt v2.
- Sigma-Profile `jorvis` render target (cross-repo: `Sigma-Profile/core/targets.json`) bundled + loaded as the base persona (KV-overridable), replacing the inline persona in `system-prompt.ts:147-161`.
- `jorvis_memory` table (kind fact|playbook|preference|postmortem, FTS-indexed) + `core/operator/memory.ts` + tools `remember`/`recall`/`update_memory`/`forget`.
- `core/operator/context.ts` — wake-time assembly: board slice + top-K memories + portfolio under a token budget.
- Postmortem-on-completion learning loop; Ruflo stays the fail-soft semantic layer (sqlite is ground truth).
- `propose_amendment` tool + `jorvis_amendments` proposals + approve/deny (app + Telegram) → approved text appends after the charter.

**Why now.** This is the "persistent, self-evolving" half of the vision; needs Phase 20's mission loop to have something to learn from.

**Scope.** Conversation scope against `conversations` schema (`db/schema.ts:523-539`); prompt assembly in `system-prompt.ts` + `runClaudeCliTurn.args.ts:53-68`; memory tools join the catalogue (parity tests); charter loader with bundled-fallback.

**Findings + recommendation.** Sigma-Profile already renders a Hermes operator target from one canonical charter — adding `jorvis` is the designed-for path (no copy-paste drift). Cross-session continuity = durable memory + board state reconstructed at wake, per the locked runtime decision.

**Risks.** Context-budget creep (memories + portfolio + board slice can bloat every wake) — hard token budget in the assembler, tested. Charter render drift — pin the render, verify with Sigma-Profile's `--check` drift gate. Amendment injection is a prompt-surface change — approval gate + audit row per amendment.

**Definition of done.** App restart → Jorvis recalls a fact + a playbook from before; a repeated mission demonstrably consults the prior postmortem; persona verifiably = the Sigma-Profile render; an amendment takes effect only after approval and is auditable; full local gate + CI green.

## Phase 22 — Jorvis P3: channels (Telegram cockpit + external mission plane)

**Goal.** The operator runs multi-project missions entirely from Telegram (with proactive reports pushed to them), and external Hermes/OpenClaw agents submit natural-language orders that Jorvis executes and reports on — absorbing SigmaControl.

**Deliverables.**
- Telegram v2 commands: `/mission`, `/status`, `/tasks`, `/new`, `/approve|/deny`, `/panes`, `/workspaces` (+ existing `/lock|/unlock`).
- Proactive pushes through the existing scrub pipeline: mission done/blocked, escalations, amendment proposals, scheduled daily brief.
- External mission plane on the control MCP: `submit_task` → missionId, `check_task` → status+timeline, `get_report` → final report; raw perception tools unchanged (two-plane).
- Sigma-Control bridge bump (cross-repo: protocol + tool set in lockstep).

**Why now.** Channels are thin adapters over Phases 20–21's mission/memory core — building them earlier would mean building them twice.

**Scope.** Telegram in `core/remote/bridge.ts:379-443` (command routing before the assistant fallthrough) + outbound via `safety.ts:230-260`; external tools in `core/control/` + catalogue (discovery-filter untouched, `control-mcp-host.ts:178-196`); autonomous-origin escalations reuse `pending-escalations.ts` → Telegram confirm.

**Findings + recommendation.** The R-1 bridge's safety pipeline (allowlist, lock, rate-limit, scrub, audit) is solid per recon — v2 adds commands + pushes, not a rewrite. Two-plane keeps existing Sigma-Control clients working.

**Risks.** Telegram push volume (mission chatter → spam) — digest/throttle policy + severity gating. External mission abuse — kill-switch freezes wakes+dispatches; missions carry `client_label`; dangerous ops inside missions still escalate. Cross-repo bridge bump can drift — version-negotiate (`SIGMA_CONTROL_PROTOCOL` finally validated).

**Definition of done.** A real multi-project mission is submitted, monitored, approved-at-an-escalation, and reported — phone only; an external MCP client (subagent-as-client smoke) submits an order and polls the final report; perception tools verified model-free; full local gate + CI green.

## Phase 13 (Part B) — Recently-closed panes (reopen)

**Goal.** An accidentally-closed pane is recoverable — the operator reopens it from a "Recently closed" list and it returns live (resumed if eligible, else relaunched fresh).

**Deliverables.**
- `panes.listClosed` RPC — soft-deleted (`closed_at IS NOT NULL`) rows from the `listRecents` surface (mig 0033), mirrored across the router-shape / rpc-channels CHANNELS / `rpc-channels.test.ts` TYPED_ROUTER_CHANNELS / `core/rpc/schemas.ts` sibling surfaces.
- `panes.reopen` RPC — `clearClosedMarker(sessionId)` (inverse of `markPaneClosed`) + an extracted `respawnSessionById`.
- A "Recently closed" UI affordance in the Command Room, mirroring the browser-tab recents component.

**Why now.** Part A (PR #161, ADR-007) made deliberate close durable — no resurrection on restart, no spurious "Pane exited" toast — but an *accidental* × is currently unrecoverable: the soft-deleted row exists with no reopen path. Cheap follow-on that closes the lifecycle.

**Scope.** `panes.listClosed`/`panes.reopen` at the `rpc-router.ts` panes block (grep the `panes.close` mirror sites added in Part A); `clearClosedMarker` next to `markPaneClosed` (`src/main/core/pty/mark-pane-closed.ts`); extract `respawnSessionById` from the existing resume path; a recents dropdown/list mirroring the browser-tab recents.

**Findings + recommendation.** Part A already added the `closed_at` column + the `listRecents` surface (mig 0033) and routes all three close paths through `markPaneClosed`; reopen is the inverse (clear marker + resume/relaunch). DB-touching code is MockDb/SQL-shape tested (better-sqlite3 won't load under vitest).

**Risks.** New RPCs touch the router-shape / rpc-channels / schemas sibling surfaces — grep-and-mirror (the allowlist-drift class; add a membership test). Reaper GCs closed rows on the normal window — re-verify keep⊇use (ADR-004) holds with the narrower resume predicate (the use-set shrank → holds trivially). e2e deferred to CI.

**Definition of done.** Operator closes a pane by mistake, opens "Recently closed", clicks it, and the pane returns live; reaped rows age out of the list on the normal window; full local gate (`tsc -b`/vitest/eslint/build) + CI e2e-matrix green.

_(Unscoped future enhancements, deferrals, and out-of-scope review findings — including the 2026-06-17 pre-release findings for #179/#180 — are parked in [WISHLIST.md](WISHLIST.md).)_

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

### ADR-009 — Multi-window = full SPA per window + main-side ownership registry; detach is a MOVE, never a mirror
**Decision.** Secondary windows load the SAME renderer bundle scoped via a preload-injected `workspaceScope`; a main-process WindowRegistry is the sole source of truth for workspaceId→windowId ownership; a workspace's xterm instances exist in exactly ONE window, and session-scoped PTY events are routed only to that window. Renderer echoes of the open-workspace list come ONLY from the main window; the global list is the union of that echo and registry-detached workspaces. **Context.** Two xterms attached to one PTY fight over SIGWINCH/cols and double-echo input, so mirroring is structurally unsafe. A thin secondary renderer root would duplicate App.tsx provider wiring (the sibling-drift class that has bitten repeatedly); N un-scoped windows give no detach semantics while still needing every ownership guard. The move path is cheap because `pty.snapshot` + the pty-data-bus first-attach already rebuild a terminal against a RUNNING PTY (`terminal-cache.ts:337-413`), and the BSP-B2 browser detach proved secondary-window lifecycle in-repo (`browser/manager.ts:395`). **Consequences.** (+) One renderer codebase, process isolation gives each window its own terminal cache for free, and pty:data routing CUTS total IPC versus broadcast (supersedes PERF-11). (+) Re-dock-on-close keeps PTYs alive (ADR-007-consistent). (−) Every direct `mainWindow.webContents.send` becomes a routing decision (audited class); per-window renderer processes cost RSS; ring-buffer-bounded scrollback on move until the DOM-presenter engine serializes buffers.

### ADR-010 — Linux support contract: AppImage+deb x64 only, manual update, user-owned CLI installs
**Decision.** Ship Linux as Ubuntu 22.04/24.04 x64 via AppImage + deb only; auto-update is a manual download + reveal-in-folder (no in-place apply); provider CLI installs are rewritten to a user-owned npm prefix (`$HOME/.npm-global`) / pipx-first python (never sudo). **Context.** Linux was BACKLOG WONTFIX; electron-updater cannot safely re-apply an AppImage/deb in place; global npm/pip installs otherwise need root or pollute system dirs; Wayland has no reliable paste-injection. **Consequences.** (+) A real, CI-gated Linux target with predictable install/update UX and no sudo for CLIs. (+) mac/win paths untouched (third branch per seam, independently unit-tested). (−) No snap/flatpak/rpm/arm64, no auto-apply updates, Wayland gets clipboard-fallback only — all explicit non-goals.

### ADR-011 — SigmaLink hosts the operator brain (Jorvis); external agents submit missions, not thoughts
**Decision.** Reverse the 2026-06-18 "SigmaLink hosts no agent brain" stance: Jorvis becomes a persistent, event-driven operator brain hosted by SigmaLink — a deterministic always-on nervous system (`core/operator/`) that wakes the model only on significant events, over a global (workspace-less) conversation with durable DB memory. External agents interact **two-plane**: raw perception tools stay deterministic/model-free; judgment work goes through the mission plane (`submit_task`/`check_task`/`get_report`). The dropped Hermes-supervisor (hosting an *external* brain process) stays dropped. **Context.** The 2026-06-18 reversal ("just expose tools, like Unity/Blender MCP") was about not hosting *someone else's* runtime; the 2026-07-07 operator decision is that SigmaLink's *own* assistant grows into the resident operator ("human commanding a fleet") — the two are compatible: Hermes/OpenClaw remain plain MCP clients, but now they can hand the resident brain natural-language orders. An always-on hot model process and PTY-as-API long-lived sessions were rejected (cost, fragility per the interactive-parity findings); persistence lives in the DB (missions board + memory), context is reassembled at wake. **Consequences.** (+) Autonomous multi-pane development with zero new model-spawning paths (everything rides `assistant.send` + the audited tool layer). (+) Cross-session/cross-project continuity without a hot process. (+) Existing Sigma-Control clients keep working (two-plane). (−) A new `autonomous` origin + wake scheduler + budget become security-critical surfaces. (−) The brain's quality depends on wake-time context assembly — a new tunable to get right.

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| Jorvis P0 reliability foundation | Phase 19 | M | High | Lane zero — everything else in the arc is dark until turns are trustworthy. One PR. |
| Jorvis P1 mission core (kanban + supervisor loop) | Phase 20 | XL | High | The headline: autonomous fleet-driving dev. Requires Phase 19. Stub-CLI e2e keeps it token-free in CI. |
| Jorvis P2 persistent identity (memory · charter · self-evolution) | Phase 21 | L | High | Cross-session/cross-project continuity + Sigma-Profile charter + approval-gated amendments. Requires Phase 20. |
| Jorvis P3 channels (Telegram cockpit + external mission plane) | Phase 22 | L | High | Phone-first operation + absorbs SigmaControl (two-plane). Requires Phases 20–21. Cross-repo bridge bump. |
| Recently-closed panes (listClosed + reopen + UI) | Phase 13 (Part B) | M | Medium | Recoverable accidental close; mirrors browser-tab recents; reuses Part A's `closed_at` + `listRecents` surface (ADR-007). |
