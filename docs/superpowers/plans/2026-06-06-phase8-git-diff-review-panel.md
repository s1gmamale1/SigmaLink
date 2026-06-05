# Phase 8 — In-app Git diff / Review panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Browse a workspace repo's changes, history, and branches inside SigmaLink (BSP-G2 + BSP-G4), and auto-tear-down swarm worktrees by policy after a run (BSP-G5).

**Architecture:** Two file-disjoint lanes built in isolated worktrees off `origin/main`, integrated into ONE Phase-8 PR. Reuse what exists — `gitStatus` (ahead/behind + staged/unstaged/untracked already computed), `DiffView.tsx` (unified/split inline diff), `worktreePool.removeAndPrune`. Build only the gap.

**Tech Stack:** Electron main (`core/git/git-ops.ts` exec helpers, MockDb in tests), React 19 renderer (`ResizablePanelGroup`, room loaders), zod RPC schemas, vitest.

---

## Recon outcome — EXISTS vs build (do NOT rebuild)

- **EXISTS:** `gitStatus(cwd)` → `{branch, ahead, behind, staged[], unstaged[], untracked[], clean}`; `gitDiff(cwd)` (= `git diff HEAD`); `DiffView.tsx` (full unified+split parser); `ReviewRoom` (per-swarm-session review — KEEP AS-IS, separate concern); `worktreePool.removeAndPrune`; `session_review.{decision,lastTestExitCode}` schema; `ResizablePanelGroup` pattern (MemoryRoom).
- **MISSING (this plan):** staged/unstaged-specific diff fns; `git log` history API; branch list + switch API; a repo-level **Git room** UI; ahead/behind display; swarm-teardown policy + hook + UI.
- **DEFERRED → WISHLIST:** **pop-out to a separate window** (no `BrowserWindow`/pop-out infra exists anywhere — a from-scratch secondary window + renderer entry; out of scope for a clean first PR); auto-writing C-7 gate pass/fail into `session_review` (BSP-G5 relies on the operator-set `decision` for now).

---

## Lane 1 — BSP-G2 + BSP-G4: repo Git panel (backend + UI, one agent)

Cohesive vertical slice (no cross-lane seam). Do backend (TDD) → channels → UI.

**Files (exclusive):**
- `app/src/main/core/git/git-ops.ts` (new fns) + `git-ops.test.ts`
- `app/src/main/core/rpc/schemas.ts` (new `git.*` zod schemas)
- `app/src/shared/router-shape.ts` + `app/src/shared/types.ts` (channel types + `GitLogEntry`/`GitBranchList` types)
- `app/src/main/rpc-router.ts` (register the new `git.*` channels — mirror existing `git.status`/`git.diff` registration)
- `app/src/renderer/features/git/*` (NEW: `GitRoom.tsx`, `ChangesPanel.tsx`, `HistoryPanel.tsx`, `BranchSelector.tsx`) + tests
- `app/src/renderer/app/state.types.ts` (`RoomId` add `'git'`), `app/src/renderer/app/room-loaders.ts` (register), nav entry (`features/sidebar/Sidebar.tsx` or the room nav) — minimal surgical add
- REUSE `app/src/renderer/features/review/DiffView.tsx` (import; do NOT fork — if it needs a prop tweak, keep it backward-compatible)

### Backend (TDD)
- [ ] `gitDiffStaged(cwd)` = `git diff --cached --no-color` (+stat); `gitDiffUnstaged(cwd)` = `git diff --no-color`. Return the same `GitDiff` shape (`{stat, patches, untrackedFiles, truncated}`) as `gitDiff` for `DiffView` reuse. Truncate large patches like `gitDiff` does.
- [ ] `gitLog(cwd, limit = 100)` → `GitLogEntry[]` where `GitLogEntry = { sha, shortSha, subject, author, relDate, refs }`. Use `git log --pretty=format:'%H%x00%h%x00%s%x00%an%x00%ar%x00%D' -n <limit>` (NUL-delimited, parse safely). Bound `limit`.
- [ ] `listBranches(cwd)` → `{ current: string, branches: { name: string; current: boolean; upstream?: string }[] }` via `git branch --list --format='%(refname:short)%00%(HEAD)%00%(upstream:short)'`.
- [ ] `switchBranch(cwd, branch)` → `{ ok: boolean; error?: string }`. **Safety: refuse with a clear error if the tree is dirty** (check `gitStatus().clean`); only `git switch <branch>` (validated branch name via `sanitizeBranchSegment`-style guard — no arbitrary args). Never force.
- [ ] Tests in `git-ops.test.ts`: mock `execCmd` (the existing test pattern in this file) and assert each fn's command + parse. NEVER spawn real git in unit tests.

### RPC channels
- [ ] Add to `router-shape.ts` `git` group: `git.diffStaged(cwd)`, `git.diffUnstaged(cwd)`, `git.log(cwd, limit?)`, `git.listBranches(cwd)`, `git.switchBranch(cwd, branch)`. Add `GitLogEntry`/`GitBranchList` to `shared/types.ts`.
- [ ] Add zod input schemas in `core/rpc/schemas.ts` for each (mirror the existing `git.status`/`git.diff` entries; `cwd: z.string()`, `limit: z.number().int().positive().max(500).optional()`, `branch: z.string().min(1).max(200)`).
- [ ] Register handlers in `rpc-router.ts` wiring to the git-ops fns (mirror the `git.status`/`git.diff` registration block exactly).

### UI — new "Git" room
- [ ] `GitRoom.tsx`: `ResizablePanelGroup` (mirror `MemoryRoom.tsx` layout + KV size persistence). Left panel: a segmented switch **Changes | History | Branches** + the list for the active section. Right panel: `DiffView` (reused) showing the selected file's diff.
  - **Changes:** three labeled groups — Staged / Unstaged / Untracked — from `git.status` (use the shared `useGitStatusPoll`/`rpc.git.status`). Clicking a staged file → `git.diffStaged` patch for that file in `DiffView`; unstaged → `git.diffUnstaged`. (Filter the combined patch to the clicked file, or show the whole staged/unstaged patch — keep simple: show the staged or unstaged patch body in DiffView.)
  - **History:** `git.log` list (subject · author · relDate · refs); selecting a commit shows `git show`-style diff IF easy, else just the metadata (commit-diff can be a follow-up — don't over-build).
  - **Branches:** `git.listBranches` list with the current marked; clicking a non-current branch → confirm → `git.switchBranch` (disabled when the tree is dirty, with a tooltip "commit or stash first").
  - **Header:** an **ahead/behind pill** (`↑{ahead} ↓{behind}`) + current branch, read from `git.status` (BSP-G4 — data already exists).
  - **cwd source:** the active workspace repo root (or the focused pane's worktree). Use the active workspace's `repoRoot` (mirror how `OrchestratorPanel`/`use-git-status-poll` get cwd).
- [ ] Nav: add `'git'` to `RoomId` (`state.types.ts`), register a loader in `room-loaders.ts` (lazy, like the others), and add ONE nav affordance (a Sidebar room button or a command-palette entry) to open it. Keep the App.tsx room switch addition minimal.
- [ ] Tests: `GitRoom` renders the three sections from mocked rpc; branch-switch disabled when dirty; ahead/behind pill renders.

**Gate (worktree, from `app/`):** `npx tsc -b` clean · `npx vitest run src/main/core/git/ src/renderer/features/git/` green · `npx eslint` touched files clean.

---

## Lane 2 — BSP-G5: post-swarm auto-teardown policy

**Files (exclusive):**
- `app/src/shared/swarm-teardown-policy.ts` (NEW: type + KV key) + test
- `app/src/main/core/swarms/swarm-teardown.ts` (NEW: the safe teardown helper) + test
- `app/src/main/core/swarms/factory-spawn.ts` (hook in the existing `onExit` callback ~line 445-464)
- `app/src/renderer/features/settings/MaintenanceTab.tsx` (policy selector UI)

### Policy contract
- [ ] `swarm-teardown-policy.ts`: `export type SwarmTeardownPolicy = 'keep-all' | 'keep-passing' | 'destroy-failing';` + `export function swarmTeardownPolicyKey(workspaceId: string): string { return \`workspace.swarmTeardownPolicy.${workspaceId}\`; }` + a `readSwarmTeardownPolicy(rawDb, workspaceId)` (mirror `readWorktreeMode`, **default `'keep-all'`** — fail-safe). Test the key + default-on-garbage.

### Safe teardown helper (TDD)
- [ ] `swarm-teardown.ts` `applyTeardownPolicy({ swarmId, workspaceId, db, worktreePool, repoRoot })`:
  1. Read policy; if `'keep-all'` → no-op return.
  2. Query the swarm's sessions (`swarm_agents` → `agent_sessions`).
  3. For each session, decide destroy ONLY IF **all** safety fences pass:
     - `agent_sessions.status NOT IN ('starting','running')` (live-session fence — re-check, there's a race after onExit).
     - NOT `exit_code = -1` (crash-recovery resume-eligible — keep⊇use invariant; destroying these = black panes).
     - NOT within the 7-day uncommitted-work window (mirror `worktree-cleanup`'s `exited_at > now-7d` guard) UNLESS explicitly failed.
     - policy match: `destroy-failing` → only `session_review.decision = 'failed'`; `keep-passing` → destroy `decision = 'failed'` AND keep everything without an explicit `passed` (i.e. unknown is KEPT — never destroy unknown). **Unknown/passed-unmerged are always kept.**
  4. `worktreePool.removeAndPrune(repoRoot, worktreePath)` per eligible session; log `[swarm-teardown] removed session=… policy=…` (match the `[worktree-cleanup]` breadcrumb style).
- [ ] Tests (MockDb + a fake worktreePool): keep-all no-ops; destroy-failing removes only `decision='failed'` and NEVER a `running`/`exit_code=-1`/<7d-unknown session; keep-passing keeps unknown.

### Hook
- [ ] In `factory-spawn.ts` `onExit` (after the `swarm_agents.status` update ~line 461): query `SELECT COUNT(*) FROM swarm_agents WHERE swarm_id=? AND status NOT IN ('done','error')`; when 0 (all agents terminal) AND policy ≠ keep-all → `void applyTeardownPolicy(...)` (best-effort, never throw into onExit). Resolve `repoRoot` from the workspace row.

### UI
- [ ] `MaintenanceTab.tsx`: a per-workspace "Swarm worktree cleanup" selector (keep-all / keep-passing / destroy-failing) near the existing checkpoint toggle, read/write `rpc.kv` at `swarmTeardownPolicyKey(wsId)`, with a warning that destroy modes remove failed-session worktrees after a swarm finishes. Test the read/write.

**Gate (worktree, from `app/`):** `npx tsc -b` clean · `npx vitest run src/main/core/swarms/ src/shared/ src/renderer/features/settings/` green · `npx eslint` touched files clean.

---

## Integration (lead) → single PR
- [ ] Both lanes off `origin/main`; file-disjoint (Lane 1 = git-ops/rpc/shared/renderer-git/nav; Lane 2 = swarms/shared-teardown/settings). Cherry-pick both into a `feat/phase8-git-review-panel` branch off `origin/main` + add this plan doc.
- [ ] Re-gate in the integration worktree: `npx tsc -b` (stricter than lane worktrees) · `npx vitest run` (affected) · `npx eslint` · `npm run build`. Fix any seam issues.
- [ ] Opus review (new feature + destructive teardown) → fold caveats.
- [ ] Push → open PR → auto-merge (rebase) once green. (e2e deferred to CI per the no-local-e2e rule.)

## Definition of done
A Git room shows staged/unstaged/untracked + inline diff + commit history + branch list/switch + an ahead/behind pill; a swarm finishing applies the configured teardown policy (default keep-all = no change) destroying ONLY policy-eligible, safety-fence-passing worktrees; `tsc -b` · vitest · lint · build green; PR merged. Pop-out + auto-gate-result deferred to WISHLIST.
