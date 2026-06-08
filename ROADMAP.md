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

## Architecture decisions (ADRs)

### ADR-001 — Prefer shared Ruflo HTTP over per-pane stdio
**Decision.** Ruflo is treated as a per-workspace shared HTTP daemon for normal pane launches, with per-pane stdio MCP retained only as a degraded fallback. **Context.** Per-pane stdio MCP duplicates `npx/node` process trees and can dominate pane RSS. **Consequences.** (+) Lower RAM and faster warm pane launches. (+) Existing pane functionality survives through fallback. (-) Launch now depends on daemon readiness when possible, so the helper must be fail-open and testable.

### ADR-002 — Keep Tauri migration out of the RAM hot path
**Decision.** Do not migrate the backend to Tauri as the first RAM optimization. **Context.** Electron host overhead is real, but the observed 300 MB-1 GB pane costs are mostly child Claude/Codex/MCP trees. **Consequences.** (+) Directly addresses the largest avoidable memory source. (-) Baseline Electron overhead remains until a separate runtime migration phase is justified.

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| Shared Ruflo HTTP launch policy | Phase 1 | M | High | Expected to remove duplicated Ruflo stdio child processes in normal panes. |
| Tree-aware bulk shutdown | Phase 1 | S | High | Prevents lingering MCP descendants after app/workspace shutdown. |
| Process-tree diagnostics payload | Phase 1 | S | Medium | Makes future 1 GB pane investigations concrete. |
| Lazy resume / idle suspend | Wishlist | L | High | Deferred until Phase 1 proves transport and cleanup behavior. |
| Tauri migration | Wishlist | XL | Medium | Reduces host overhead, not the primary child-process RAM cost. |
