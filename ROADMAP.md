# SigmaLink — Roadmap

SigmaLink is an Electron desktop workspace for launching and coordinating live Claude/Codex/Gemini/Kimi/OpenCode agent panes with worktrees, Ruflo memory/orchestration, browser tools, voice, and review workflows. The immediate operational concern is RAM pressure from live multipane agent process trees.

This ROADMAP is the single source of truth for what to build next.

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

## Phase 3 — Command Room interaction reliability

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

## Architecture decisions (ADRs)

### ADR-001 — Prefer shared Ruflo HTTP over per-pane stdio
**Decision.** Ruflo is treated as a per-workspace shared HTTP daemon for normal pane launches, with per-pane stdio MCP retained only as a degraded fallback. **Context.** Per-pane stdio MCP duplicates `npx/node` process trees and can dominate pane RSS. **Consequences.** (+) Lower RAM and faster warm pane launches. (+) Existing pane functionality survives through fallback. (-) Launch now depends on daemon readiness when possible, so the helper must be fail-open and testable.

### ADR-002 — Keep Tauri migration out of the RAM hot path
**Decision.** Do not migrate the backend to Tauri as the first RAM optimization. **Context.** Electron host overhead is real, but the observed 300 MB-1 GB pane costs are mostly child Claude/Codex/MCP trees. **Consequences.** (+) Directly addresses the largest avoidable memory source. (-) Baseline Electron overhead remains until a separate runtime migration phase is justified.

### ADR-003 — Image-to-agent via staged temp file + absolute @path, not clipboard-write
**Decision.** Pane screenshot drop/paste hands an image to the CLI by staging the bytes to `<userData>/staged-images/` and injecting the absolute path into the prompt — never by writing the image to the system clipboard. **Context.** Both Claude Code and Codex read images CLI-side from the OS clipboard on Ctrl+V (the PTY is a text pipe; terminal graphics protocols like OSC 1337 are display-only, not input). But Electron's `clipboard.writeImage` writes `public.png` while Claude Code's reader is `osascript 'the clipboard as «class PNGf»'` (legacy type) — the write silently misses (anthropics/claude-code#30936, open as of 2026-06). Both CLIs DO read an image file path from the prompt. **Consequences.** (+) Works today for both CLIs, no upstream dependency, no clipboard-type gymnastics; staging is validated (ext allowlist, 20 MB cap, server-generated filename). (+) Gated per provider via `IMAGE_CAPABLE_PROVIDERS`. (−) Bypasses the CLIs' native `[Image #N]` paste UX — the image arrives as a path mention. (−) Staged files accumulate in userData until a future janitor sweep (transient inputs; acceptable).

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
