# SigmaLink Dev Workspace — Design

**Date:** 2026-06-11 · **Status:** approved by operator (4 AskUserQuestion decisions) · **Source:** operator request + 4-lane read-only recon (model / UI / panes / lifecycle)

A special **singleton** workspace, **"SigmaLink Dev"**: selectable from the workspace menu, with **no git/worktree machinery at all** — just **N plain shell terminals** (`providerId: 'shell'`) cwd'd at the user's home directory (`os.homedir()`). Creation flow = pick a terminal count, launch. That's it.

## Operator decisions

| Decision | Choice |
|---|---|
| Cardinality | **Singleton** — created on first use; the menu entry reopens the same workspace afterwards |
| App restart | **Respawn fresh shells** — add a `'shell'` case to the resume path (fresh `$SHELL`, never "continue"; shells have no session to hijack) |
| Entry point | **Sidebar `WorkspacesPanel` "+" dropdown** — new "SigmaLink Dev" item |
| Count input | **Numeric stepper 1–12** (existing `CounterControls` [− n +] pattern), default 4 |

## Approach (chosen: A — zero schema change)

Rejected: **B** add a `kind` column (migration churn for one flavor); **C** a separate non-workspace "Dev Terminals" room (breaks "selectable in the workspace menu").

Chosen: reuse what exists — `repoMode: 'plain'` already skips every worktree gate (`launcher.ts` Gate A, `factory-spawn.ts` Gate B both require `repoMode === 'git' && repoRoot`), and the `'shell'` provider (`shared/providers.ts:248`, `command: ''` → `defaultShell()` → `$SHELL -l`) is already a working spawn path. The only new primitives:

1. **Singleton pointer in KV**: `workspace.devWorkspace.id → <workspaceId>` (pattern precedent: `worktreeModeKey`). New `shared/special-workspace.ts` exports the key + a type guard; main + renderer both read it. No schema migration.
2. **`openDevWorkspace(deps)`** in `src/main/core/workspaces/factory.ts`:
   - KV id set and row exists → bump `lastOpenedAt`, return row (reuse).
   - Else insert: `name: 'SigmaLink Dev'`, `rootPath: os.homedir()`, **forced `repoMode: 'plain'`, `repoRoot: null`** (never probe `getRepoRoot(~)` — even if `~` is inside a dotfiles repo, this workspace must never engage worktree machinery), then write the KV pointer.
   - **Skips the standard open side effects**: no MCP autowrite (`.mcp.json`/`.cursor/mcp.json` must NOT be written into `~`), no trust config, no memory seeding/preflight.
3. **New RPC `workspaces.openDev`** — touches the known channel triple (`rpc-channels.ts` + `router-shape.ts` + `rpc-router.ts`; sibling-mirror trap — all three or none).
4. **Launch**: renderer builds a normal `LaunchPlan` — `workspaceId`, `workspaceRoot` from the returned row, `panes: N × { paneIndex: i, providerId: 'shell' }` — and calls the existing `rpc.workspaces.launch`. `cwd` resolves to `rootPath` (= `~`) because `worktreePath` stays null (`worktree-cwd.ts:23`). Grid auto-tiles any N (`pane-grid-shape.ts`); `GridPreset` is a closed union (1|2|4|6|8|10|12|…) so for odd N pass the nearest preset ≥ N while `panes.length = N` — verify launch-side validation tolerates this, else snap the stepper to preset values.

## UI

- `WorkspacesPanel` "+" dropdown gains a **"SigmaLink Dev"** item.
  - Singleton doesn't exist → small popover: `CounterControls` stepper (1–12, default 4) + Launch button → `openDev` → `workspaces.launch` → `ADD_SESSIONS` + `SET_ACTIVE_WORKSPACE_ID` + route to command room.
  - Singleton exists → item reads "Open SigmaLink Dev" and reopens it: `openDev` (bumps `lastOpenedAt`) → `panes.resume` → `panes.listForWorkspace` → `ADD_SESSIONS` (mirrors the boot-restore Path A so dead shells respawn; the plain Sidebar reopen Path B doesn't resume — do not copy it).
- **Visual distinction**: row gets a small `DEV` badge (workspace id === KV pointer); subtitle renders `~` instead of `basename(rootPath)`. No new color machinery — the existing per-workspace color/status ring stays.
- Drag-to-reorder: untouched — the dev workspace rides `openWorkspaces[]` like any other row.

## Shell respawn on restart

`resume-launcher.ts` `buildResumeArgs('shell', …)` currently returns `null` → pane skipped → exited ghost after restart. Add a `'shell'` case returning a **fresh-spawn** descriptor (empty args, never resume/continue — invariant: id-or-fresh, and shells have no id), and thread it past the `null`-skip gate. Plain mode already bypasses worktree mechanics. **Sibling trap:** there are two mirrored pane read-paths (boot `use-session-restore` Path A with resume; `Sidebar.tsx` reopen Path B without) — grep both when touching this.

## Security & side-effect containment

- **FS sandbox widening is inherent**: `rpc-router.ts` `fsAllowedRoots` must include `~` for PTY spawn-path assertions to pass — that's the feature (terminals at `~`). Accept and document.
- **Assistant (Jorvis) read-roots**: `assistant/tools.ts:236` builds read-allowed roots from every workspace `rootPath` — do **not** let the dev workspace widen Jorvis's read scope to all of `~`. Exclude the dev workspace id there if cheaply separable; if not, document the acceptance explicitly in the PR.
- **Memory supervisor / per-pane MCP wiring** (`launcher.ts:269` `memRoot = rootPath`): skip for the dev workspace — nothing should create `~/.sigmalink-memory/` or write MCP config under `~`. Shell panes don't consume MCP anyway.
- Lifecycle sweeps are safe by construction: forced `plain` + null `repoRoot` means the boot janitor, worktree reaper, orphan cleanup, and auto-checkpoint all skip this workspace (each guards on `repoMode === 'git'`/`worktreePath`).

## Testing

- **Main (vitest, MockDb — better-sqlite3 is Electron-ABI, never `new Database()`):** `openDevWorkspace` singleton reuse vs first-create; forced `plain`/null `repoRoot`; KV pointer written; side effects skipped (no MCP autowrite call). `buildResumeArgs('shell')` returns fresh-spawn (and never a continue/resume mode).
- **Renderer (jsdom):** "+" menu shows the item; stepper clamps 1–12; launch builds N shell panes; existing-singleton path calls resume+list, not a second create; DEV badge renders only on the pointer-matched row.
- **e2e:** deferred to CI e2e-matrix (never run locally against the operator's live app).

## Out of scope (YAGNI)

Multiple dev workspaces; custom cwd selection; agent panes in the dev workspace (the `+Pane` button will technically work — fine, but not designed for); deleting/resetting the singleton (close works like any workspace; the KV pointer self-heals by recreating on next use if the row is gone).
