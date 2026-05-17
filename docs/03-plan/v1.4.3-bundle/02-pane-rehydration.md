# 02 — Pane Rehydration on Workspace Open (P1)

**Severity**: P1 — workspace pane state appears to vanish on app restart
**Effort**: M (~half-day)
**Cluster**: B (pane-lifecycle — bundled with #03 and #04 in ONE PR)
**Suggested delegate**: Sonnet (Claude Code)
**Depends on**: #03 (must land in same PR — dead-row migration must run before rehydration)
**Blocks**: #05 (EmptyState defensive UX builds on this)

## Context

User report (verbatim): "Workspace NOT SAVING exact pane states - Once I create and initialize my workspace in the directory and close the app, then reopen, the actual workspace itself on the left panel Workspaces is getting saved but the actual states and count of previously created panes are not getting saved. I have to re-create them again which leads to creating another worktrees and creating a mess."

**Root cause** (confirmed via investigation, explore-workspace-persistence agent):

This is **NOT a v1.4.2 regression**. It's a **pre-existing missing wire** in the renderer. The DB inspection confirmed:

- Panes ARE persisted correctly in `agent_sessions` table — DB has 24+ rows for one workspace, each with `workspaceId`, `providerId`, `cwd`, `worktreePath`, `paneIndex` (added migration 0012), `externalSessionId`, `status`, `exitCode`.
- The launcher writes them correctly at `app/src/main/core/workspaces/launcher.ts:246-268`.
- But: the renderer's `state.sessions` slice has **only ONE action that adds sessions** — `ADD_SESSIONS` — fired from THREE CREATE sites:
  - `app/src/renderer/features/workspace-launcher/Launcher.tsx:294` (initial launch)
  - `app/src/renderer/features/command-room/CommandRoom.tsx:227` (+ Pane)
  - `app/src/renderer/features/swarm-room/SwarmRoom.tsx:137` (swarm add)
- **ZERO code** in `Sidebar.openPersistedWorkspace`, `Launcher.chooseExisting`, or `useSessionRestore` fetches existing `agent_sessions` rows into the renderer.
- The boot path calls `rpc.panes.resume(wsId)` which re-spawns PTYs in main and returns `{resumed, failed, skipped}` — only sessionIds, NO AgentSession rows.
- There is no `panes.listForWorkspace` RPC at all.

**Result**: `state.sessionsByWorkspace[wsId]` is `undefined` on workspace reopen → CommandRoom renders EmptyState → user re-launches → fresh paneIndex 0-5 rows → fresh worktrees → "mess accumulates."

v1.4.2's xterm-cache GC (#03) made this visually obvious for the first time by disposing the cached terminal instances on reopen, removing any visual hint that panes once existed.

## File:line targets

### NEW RPC `panes.listForWorkspace`

`app/src/main/rpc-router.ts` — near the existing `lastResumePlan` handler (~line 641). The query reuses the per-pane `MAX(started_at)` SQL shape from `lastResumePlan`:

```ts
'panes.listForWorkspace': async (workspaceId: string): Promise<AgentSession[]> => {
  const rows = db.prepare(`
    SELECT s.*
    FROM agent_sessions s
    INNER JOIN (
      SELECT workspace_id, pane_index, MAX(started_at) as latest
      FROM agent_sessions
      WHERE workspace_id = ? AND pane_index IS NOT NULL
      GROUP BY workspace_id, pane_index
    ) m ON s.workspace_id = m.workspace_id
       AND s.pane_index = m.pane_index
       AND s.started_at = m.latest
    ORDER BY s.pane_index ASC
  `).all(workspaceId) as AgentSessionRow[];
  return rows.map(rowToAgentSession);
},
```

**Critical**: the `MAX(started_at)` join is mandatory. Without it, multiple historical rows for the same paneIndex (a real issue today) produce duplicate renderer sessions.

### Schema update — `app/src/shared/router-shape.ts`

Add the new RPC signature:

```ts
panes: {
  // ... existing ...
  listForWorkspace: (workspaceId: string) => Promise<AgentSession[]>,
}
```

### Dispatch ADD_SESSIONS from 3 sites

**Site 1**: `app/src/renderer/features/sidebar/Sidebar.tsx:54-66` — `openPersistedWorkspace`

```ts
async function openPersistedWorkspace(workspaceId: string) {
  dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId });
  // ... existing room dispatch ...
  // NEW:
  const sessions = await rpc.panes.listForWorkspace(workspaceId);
  if (sessions.length > 0) {
    dispatch({ type: 'ADD_SESSIONS', sessions });
  }
}
```

**Site 2**: `app/src/renderer/features/workspace-launcher/Launcher.tsx:180-215` — `chooseExisting` (when user picks an existing workspace from the launcher)

Same pattern as Site 1.

**Site 3**: `app/src/renderer/lib/use-session-restore.ts:115-194` — after each `panes.resume` promise resolves

```ts
const restored = await rpc.panes.resume(workspaceId);
// NEW: hydrate sessions slice before terminal-cache GC fires
const sessions = await rpc.panes.listForWorkspace(workspaceId);
if (sessions.length > 0) {
  dispatch({ type: 'ADD_SESSIONS', sessions });
}
// ... existing resumed/failed/skipped handling ...
```

**Critical ordering**: ADD_SESSIONS MUST dispatch before any rendering that consumes `state.sessionsByWorkspace`. The cache GC at `use-terminal-cache-gc.ts:33-51` disposes cached terminals when no session matches — if rehydration races, terminals get disposed and re-mounted unnecessarily. Wrap the dispatch + render in a single React state batch if needed.

## Tests

### Vitest

- `app/src/main/rpc-router.test.ts` (or wherever RPC tests live) — assert `panes.listForWorkspace`:
  - Returns empty array for fresh workspace
  - Returns one row per unique paneIndex even when DB has duplicates (MAX(started_at) wins)
  - Filters by workspaceId correctly
  - Excludes rows with `paneIndex IS NULL`
  - Ordered by `pane_index ASC`

- `app/src/renderer/lib/use-session-restore.test.ts` — extend with:
  - ADD_SESSIONS fires after restore promise resolves
  - ADD_SESSIONS fires with the correct session payload
  - No double-dispatch on retry

### E2E

Extend `tests/e2e/multi-workspace.spec.ts` (or new `tests/e2e/pane-rehydration.spec.ts`):

1. Create workspace, launch 4 panes
2. Quit app (graceful)
3. Reopen app
4. Click workspace tile in sidebar
5. Assert: CommandRoom renders 4 panes (not EmptyState)
6. Assert: Each pane shows provider name, cwd, and PTY output continuity

## Gate

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.3-02-04-pane-lifecycle/app
pnpm exec tsc -b --pretty false           # clean
pnpm exec vitest run                       # 417 baseline + ~8-10 new = ~427
pnpm exec eslint .                         # 0 errors
pnpm run build                              # clean
node scripts/build-electron.cjs             # clean
```

**Manual smoke (REQUIRED — P1):**

The full restart-and-reopen cycle:
1. Fresh workspace, launch 4 panes (Claude, Codex, Gemini, Kimi).
2. Wait for each pane to settle (boot self-check green).
3. Cmd+Q (quit completely, not just close window).
4. Re-launch app.
5. Click workspace tile in left sidebar.
6. **Expected**: CommandRoom renders 4 panes with correct provider per slot. No EmptyState. No new worktree dirs in `<userData>/SigmaLink/worktrees/<repoHash>/`.
7. **Bonus**: Send a turn in each pane; verify all 4 respond (resume worked).

## Risks

- **R-02-1** Race between ADD_SESSIONS dispatch and terminal-cache GC. Mitigation: dispatch BEFORE the cache GC mount-effect runs, or wrap in `React.startTransition`. Test coverage in `use-terminal-cache-gc.test.ts`.
- **R-02-2** The `MAX(started_at)` SQL might pick a stale row if a fresh spawn was retried multiple times. Each spawn gets a new row, latest wins. Acceptable.
- **R-02-3** If `panes.listForWorkspace` is called BEFORE migration 0016 (#03) runs, it returns rows with `status='running'` that are actually dead. Mitigation: migration runs at boot before any RPC handler is registered — ordering is enforced.

## Closes ship-claims

- The "pane state doesn't persist" complaint that's been latent since the per-workspace room recall logic shipped in v1.3.3.
- The underlying issue (no rehydration RPC) has been present since v1.0.0.

## Doc source

This brief replaces the earlier v1.4.2 `06-worktree-location-ux-option-d.md` Bug B section (which incorrectly attributed the problem to v1.4.2 changes).
