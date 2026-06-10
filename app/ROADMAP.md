# SigmaLink — Roadmap

SigmaLink is an Electron + React multi-agent terminal workbench (workspaces → worktree-per-pane agent grids, Jorvis assistant, SigmaSwarm orchestration). Current built state: **v2.2.0 shipped 2026-06-11** (the entire 2026-06-10 audit, Phases 3–11, is in `main`); this roadmap is the post-v2.2.0 whiteboard. Detailed source of truth for the current phase: `docs/superpowers/plans/2026-06-11-sigmalink-dev-workspace.md` + its spec `docs/superpowers/specs/2026-06-11-sigmalink-dev-workspace-design.md`.

This ROADMAP is the single source of truth for what to build next.

---

## How to read this

- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort** is S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Confirmed bugs (if any) are fixed before new feature phases.

---

## Confirmed bugs to fix first (hotlist)

| # | Sev | Bug | Where (file:line) | Effort |
|---|-----|-----|-------------------|--------|
| 1 | high | `workspaces.rename`/`openNew` hard-rejected at preload bridge — sidebar inline rename silently doesn't persist (allowlist quad-drift; defensive test's own hand-list omits them) | `rpc-channels.ts:78-83` vs `router-shape.ts:323,327`, `Sidebar.tsx:294`, `rpc-channels.test.ts:108-113` | S — **folded into Phase 13 as drive-by Task 4** |

---

## Phase 13 — SigmaLink Dev workspace (singleton plain-terminal bench at ~)

**Goal.** One menu click gives the operator a grid of N plain shell terminals at `~` — no repo, no worktrees, no agent CLIs — that survives restarts by respawning fresh shells.

**Deliverables.**
- `src/shared/special-workspace.ts` — singleton KV contract (`workspace.devWorkspace.id`, name, 12-pane cap)
- `openDevWorkspace()` in `src/main/core/workspaces/factory.ts` — forced-`plain` row at `os.homedir()`, ALL open side effects skipped, dangling-pointer self-heal
- `workspaces.openDev` RPC across all four mirror sites (`router-shape.ts` / `rpc-router.ts` / `rpc-channels.ts` / `rpc-channels.test.ts`)
- `'shell'` case in `buildResumeArgs` (`resume-launcher.ts:80-132`) — boot-resume respawns dead shells fresh
- Shell-provider gate around the per-pane MCP wiring block (`workspaces/launcher.ts:262-305`) — nothing writes `.mcp.json` into a pane cwd
- Jorvis read-roots exclusion for the dev workspace (`assistant/tools.ts:250-262`)
- Renderer: `DevWorkspaceDialog.tsx` (stepper 1–12, default 4) + `WorkspacesPanel` menu item/DEV badge + `Sidebar` open/launch flow
- Drive-by hotlist fix #1 (CHANNELS allowlist for `rename`/`openNew`)

**Why now.** Operator-requested (2026-06-11): a frictionless "just give me terminals" bench for daily dev work, without polluting `~` with workspace side effects. Recon shows ~90% of the machinery already exists (`repoMode:'plain'`, the `'shell'` provider, auto-tiling grid) — high value, low effort. The hotlist rename bug rides along because Task 3 edits the exact same allowlist lines.

**Scope.** Execute the 9-task TDD plan at `docs/superpowers/plans/2026-06-11-sigmalink-dev-workspace.md` (all line numbers verified on `main` @ `41f6e53`): shared contract → factory → RPC quad → allowlist drive-by → shell resume → MCP-wiring gate → Jorvis exclusion → renderer (menu/dialog/badge/flow) → full local gate (tsc/lint/vitest/build; e2e via CI only).

**Findings + recommendation.** 4-lane recon (2 Sonnet + 2 Haiku Explore agents) + lead verification: `plain` workspaces already skip both worktree gates (`launcher.ts:225`, `factory-spawn.ts:285`); `providerId:'shell'` already spawns `$SHELL -l`; resume eligibility (`running` ∪ `exited(-1)`) means only the `buildResumeArgs` null-return blocks shell respawn; the dangerous side effects are the open-time autowrite/seed (skipped by the new factory) and the per-pane `writeMcpConfigForAgent`/`ensureRufloMcpForPane` writes into cwd (gated on non-shell). Chosen approach **A — zero schema change** (KV pointer, no `kind` column; ADR-008 below).

**Risks.**
- FS sandbox necessarily widens to `~` for PTY/fs RPCs (inherent to the feature) — mitigated by excluding the dev workspace from Jorvis read-roots and writing zero config into `~`.
- Resume-path edits have a history of sibling-miss regressions — plan deliberately mirrors boot-restore Path A only, and Task 5 keeps `default: null` for unknown providers.
- `GridPreset` is a closed union; odd N uses nearest-preset-≥N while `panes.length = N` — `executeLaunchPlan` iterates `plan.panes` and never validates against `preset` (verified `launcher.ts:170-230`), but the executor re-verifies at Task 8.

**Definition of done.** An operator can: click "+ → SigmaLink Dev", pick 5, get 5 live shells at `~`; quit and relaunch the app and the dev workspace's shells respawn fresh; `~/.mcp.json` and `~/.sigmamemory/` are NOT created; renaming a *normal* workspace persists across restart (hotlist #1); full gate green (tsc, eslint, vitest, build) + PR CI e2e-matrix green.

---

## Architecture decisions (ADRs)

### ADR-008 — Special workspaces are KV-marked, not schema-typed
**Decision.** The "SigmaLink Dev" singleton is identified by a KV pointer (`workspace.devWorkspace.id`) plus forced `repoMode:'plain'`/`repoRoot:null`, NOT by a new `kind`/`type` column on `workspaces`.
**Context.** Only one special flavor exists; `repoMode:'plain'` already short-circuits every worktree/git/janitor path (both spawn gates, boot janitor, orphan cleanup, auto-checkpoint). A migration would buy nothing today and the KV-contract pattern is established (ADR-007 `worktreeModeKey`).
**Consequences.** (+) zero migration risk; reuses both existing spawn gates unchanged; self-heals a deleted row by re-creating + repointing. (−) "specialness" is invisible in the `workspaces` table itself (must join KV to see it); a second special flavor later would justify revisiting a `kind` column.

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| SigmaLink Dev workspace (incl. shell resume + containment + renderer) | 13 | M | High | 9-task TDD plan, ~90% existing machinery |
| CHANNELS allowlist fix (`rename`/`openNew`) | 13 (Task 4) | S | High | silent data-loss class; rides the same edit |
