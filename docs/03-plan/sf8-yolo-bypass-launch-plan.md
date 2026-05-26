# SF-8 — Yolo/Bypass launch mode for plain panes — Implementation Plan

> **For agentic workers:** 2 worktree-isolated lanes + lead seam. Every lane `isolation:"worktree"` on the Agent CALL. **Gate in MAIN; e2e = FULL `tests/e2e/` dir.** pnpm. Agents NEVER push/tag/bump/release. Steps use `- [ ]` checkboxes.

**Goal:** Operators can launch plain workspace panes in "Yolo / Bypass" mode — each provider gets its own bypass flag (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo` / `--force`) at spawn. A per-launch toggle in the workspace launcher + the `+Pane` flow, a per-workspace default, persisted on the session so it survives resume. OFF by default; clear danger warning.

**Architecture:** The flag mechanism ALREADY exists — `providers/launcher.ts:209` appends `provider.autoApproveFlag` when `opts.autoApprove`, and swarm agents already use it. SF-8 just extends `autoApprove` from swarm-agents to **plain panes**: thread it through `LaunchPlan` → `executeLaunchPlan` → `resolveAndSpawn`, persist it on `agent_sessions`, and expose a toggle. **No new flag logic.**

**Tech Stack:** Electron 30 main (better-sqlite3 migration, drizzle) · React/Radix (toggle) · vitest + Playwright. **No new npm deps.**

## Verified facts
| Area | Reality (file:line) |
|---|---|
| Flag append | `providers/launcher.ts:209` `if (opts.autoApprove && provider.autoApproveFlag) out.push(provider.autoApproveFlag)` — inside `buildArgs`, called by `resolveAndSpawn`. |
| Launch path | `rpc.workspaces.launch(plan)` → `executeLaunchPlan(plan, deps)` (`workspaces/launcher.ts:125`) → per-pane `resolveAndSpawn({...},{...extraArgs, isResume, ...})` at `:350`. |
| Yolo-capable providers | `providers.ts` `autoApproveFlag`: claude `--dangerously-skip-permissions` · codex `--dangerously-bypass-approvals-and-sandbox` · gemini `--yolo` · cursor `--force`. **kimi/opencode/shell have NONE → toggle is a graceful no-op.** |
| Types | `shared/types.ts:87` `LaunchPlan { panes: PaneAssignment[] }`; `shared/types.ts:22` `AgentSession`; launch RPC pane validation `router-shape.ts:155`. |
| Session schema | `agent_sessions` (`schema.ts:34`) has NO `auto_approve` column. Latest migration `0023`; next = **`0024`**. Runner is sequential (`m.up(db)`); a single `ALTER TABLE … ADD COLUMN` needs no transaction (NOT the H-7 nested-txn case). |
| Resume | `executeLaunchPlan` sets `extraArgs` from `buildResumeArgs` (resume) or `buildExtraArgs` (fresh), then one `resolveAndSpawn` at `:350`. `buildArgs` appends `autoApproveFlag` from `opts.autoApprove` regardless of resume → passing `autoApprove` to that opts covers both. |

## Cross-lane contract (LEAD applies the seam BEFORE dispatch)
- **`shared/types.ts`**: add `autoApprove?: boolean` to `PaneAssignment` and to `AgentSession`. (Optional, backward-compatible.)
- **`shared/router-shape.ts:155`**: add `autoApprove?: boolean` to the launch RPC's pane shape so the validated input carries it.
- These compile cleanly with no other change (optional fields) → committed as the seam so both lanes branch from a type-bearing main.

---

## Lane A — main: migration + persist + launch threading (M) · **Sonnet**
Owns: NEW `app/src/main/core/db/migrations/0024_agent_sessions_auto_approve.ts` (+ `.test.ts`) · MOD `app/src/main/core/db/schema.ts` · MOD `app/src/main/core/workspaces/launcher.ts` · MOD `app/src/main/core/providers/__tests__/launcher.spec.ts` if needed. Does NOT touch types.ts/router-shape (lead seam) or renderer.

### Task A1: migration 0024 — `auto_approve` column
**Files:** Create `0024_agent_sessions_auto_approve.ts` + `0024_agent_sessions_auto_approve.test.ts`
- [ ] **Step 1:** Read `0023_benchmark_runs.ts` to copy the exact migration module shape (`{ name, up(db) }`) and the DDL-running call style (whichever DDL method 0023 uses on its `db` handle).
- [ ] **Step 2 — failing test** (MockDb DDL assertion — **NEVER `new Database()`**, per the better-sqlite3/Electron-ABI rule): assert `up(mockDb)` issues the DDL `ALTER TABLE agent_sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0` (capture the SQL string on the fake `db` handle's DDL method). Mirror `0023`'s test structure verbatim.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement — define the DDL string and run it via the same `db` DDL method 0023 uses:
```
const DDL = `ALTER TABLE agent_sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;`;
// run DDL via the migration db handle, matching 0023's API exactly.
```
If migrations are registered in an index/array, append `0024` there.
- [ ] **Step 5:** Run → PASS. **Step 6:** Add the drizzle column to `schema.ts` agent_sessions: `autoApprove: integer('auto_approve').notNull().default(0),`. **Step 7:** `npx tsc -b` clean. **Step 8:** Commit `feat(db): agent_sessions.auto_approve column — migration 0024 (SF-8)`.

### Task A2: thread autoApprove through executeLaunchPlan (fresh launch)
**Files:** Modify `app/src/main/core/workspaces/launcher.ts`
- [ ] **Step 1 — failing test** (extend the launcher test or `providers/__tests__/launcher.spec.ts`): a LaunchPlan pane with `autoApprove:true` + provider claude → `resolveAndSpawn` receives `autoApprove:true` and the spawned argv includes `--dangerously-skip-permissions`; `autoApprove:false/undefined` → flag absent. (Mock the pty registry; assert `argsUsed`.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3 — implement:** in the `resolveAndSpawn({...},{...})` opts at `launcher.ts:350`, add `autoApprove: pane.autoApprove ?? false,`. Persist it on the created `agent_sessions` row (the insert that records the session — set `autoApprove: pane.autoApprove ? 1 : 0`). Include it on the returned `AgentSession` object(s).
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(launcher): thread pane.autoApprove → resolveAndSpawn + persist on session (SF-8)`.

### Task A3: re-apply on resume
**Files:** Modify `app/src/main/core/workspaces/launcher.ts`
- [ ] **Step 1:** Find where a resume LaunchPlan/pane is constructed from a persisted session (the resume path that populates `pane` for an existing session). Ensure `pane.autoApprove` is sourced from the persisted `agent_sessions.auto_approve` (read the row; map `auto_approve === 1`). If the resume pane is built by the renderer, ensure `panes.listForWorkspace` / the resume RPC returns `autoApprove` so the renderer re-submits it (the `AgentSession` type already carries it — lead seam).
- [ ] **Step 2 — failing test:** resuming a session whose `auto_approve=1` → `resolveAndSpawn` opts `autoApprove:true` → flag present in resume argv.
- [ ] **Step 3:** Implement (read persisted value; pass into the same opts). **Step 4:** Run → PASS. **Step 5:** Commit `feat(launcher): persist Yolo across resume (SF-8)`.

## Lane B — renderer: toggle + per-workspace default (S) · **Sonnet**
Owns: MOD `app/src/renderer/features/workspace-launcher/Launcher.tsx` (+ test) · MOD `app/src/renderer/features/command-room/AddPaneButton.tsx` (+ test). Renderer-only; does NOT touch launcher.ts/schema/migrations/types.ts.

### Task B1: per-workspace Yolo default helper
- [ ] **Step 1:** kv key `pane.autoApprove.default.<workspaceId>`. Add a tiny read/write via the existing `rpc.kv.get/set` (read how other settings use `rpc.kv` in the renderer; mirror it). Default = OFF when unset.

### Task B2: Launcher.tsx per-launch toggle
**Files:** Modify `Launcher.tsx` (+ `Launcher.test.tsx`)
- [ ] **Step 1:** Read `Launcher.tsx` fully (esp. the submit at `:322` `panes: paneProviders.map((providerId, paneIndex) => ({ ... }))`).
- [ ] **Step 2 — failing test** (jsdom): a `data-testid="yolo-toggle"` renders with a danger/warning style + sublabel; defaults from the per-ws kv; when ON, the `rpc.workspaces.launch` payload has every pane with `autoApprove:true`; when OFF, `autoApprove:false`. Toggling persists the per-ws default kv.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4 — implement:** add a single toggle (reuse the FE-3/FE-4 Switch/Checkbox component) near the launch button, label **"⚠️ Yolo / Bypass mode"**, sublabel "Starts agents with their bypass flag — disables the agent's own approval prompts. Use only in trusted workspaces." State `yolo` initialised from the per-ws default; on submit, set `autoApprove: yolo` on each pane object; on toggle, write the per-ws kv. a11y: `aria-label` + the warning conveyed in text (FE-4 standard).
- [ ] **Step 5:** Run → PASS. `npx tsc -b` + eslint clean. **Step 6:** Commit `feat(launcher-ui): Yolo/Bypass per-launch toggle + per-workspace default (SF-8)`.

### Task B3: AddPaneButton.tsx toggle
**Files:** Modify `AddPaneButton.tsx` (+ test)
- [ ] **Step 1:** Read it; find where it builds the pane it adds + calls launch.
- [ ] **Step 2 — failing test:** the `+Pane` flow exposes the same Yolo toggle (defaulted from the per-ws kv); when ON, the added pane's launch payload has `autoApprove:true`.
- [ ] **Step 3:** Implement (mirror B2's toggle for the single pane). **Step 4:** Run → PASS. **Step 5:** Commit `feat(command-room): Yolo toggle in +Pane add flow (SF-8)`.

---

## Gate (in MAIN, after lead seam + both lanes merged)
`npx tsc -b` · `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run product:check` · **`npx playwright test tests/e2e/` (FULL dir)**. Confirm: a fresh-profile launch defaults Yolo OFF (no bypass flag in argv); toggling ON appends the right per-provider flag; kimi/opencode/shell panes ignore it (no-op). Optionally extend an e2e to assert the toggle renders + defaults off.

## Execution dispatch
LEAD first commits the type seam (`types.ts` + `router-shape.ts`). Then 2 lanes, ONE message, `run_in_background`, `isolation:"worktree"`, branched from the seam commit — **A=Sonnet** (main/migration), **B=Sonnet** (renderer). At merge: path-scoped `git checkout <branch> -- <lane files>`; `diff -q` any unexpected M in main (the w3-tg leak lesson, [[feedback_agent_worktree_isolation]]); new files via `add -A`. A quick warning-UX review (no full security lane — SF-8 only exposes existing provider flags, adds no trust surface). Full gate in main → ship on operator go.

## Self-review
- **Coverage:** migration+persist (A1) · fresh-launch threading (A2) · resume persistence (A3) · launcher toggle + per-ws default (B2) · +Pane toggle (B3) · per-ws kv (B1). Matches the approved design's 3 components + the per-launch/persist/per-ws-default decisions.
- **No cross-lane overlap:** A=`db/*` + `workspaces/launcher.ts`; B=`workspace-launcher/Launcher.tsx` + `command-room/AddPaneButton.tsx`; seam=`types.ts`+`router-shape.ts` (lead). `AgentSession.autoApprove` (seam) is the only shared symbol — defined once, read by both.
- **Type consistency:** `autoApprove?: boolean` on `PaneAssignment`+`AgentSession` (seam) used in A2/A3/B2/B3; column `auto_approve` (A1) maps to it.
- **Secure-by-default:** OFF by default (per-ws default off, toggle off), explicit opt-in behind a danger warning, only the provider's own documented flag appended, no custom escalation.
- **YAGNI:** no per-pane granularity, no global default, no change to the swarm-agent path.

## Out of scope
Per-pane granularity · global (cross-workspace) default · changing the swarm-agent `autoApprove` path · SF-7 (separate plan, separate release).
