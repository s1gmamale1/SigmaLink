# Lane 7 — Swarm Persistence / Restore Investigation

## 1. DB Schema: How Swarms Persist

Three tables are relevant:

| Table | Key columns | Notes |
|---|---|---|
| `swarms` | `id`, `workspace_id`, `status` (`running`/`paused`/`completed`/`failed`), `preset`, `ended_at` | No FK constraint to `swarm_agents`; a row can exist with zero child agents |
| `swarm_agents` | `swarm_id`, `session_id` (nullable), `status` (`idle`/`busy`/`blocked`/`done`/`error`) | `session_id` is NULL when spawn failed; not deleted when PTY exits — status flips to `done`/`error` instead |
| `agent_sessions` | `id`, `workspace_id`, `status` (`starting`/`running`/`exited`/`error`), `pane_index` (NULL for swarm agents) | PTY-exit handler writes `exited`/`error` + `exited_at`; row is never deleted on exit |

Files: `/Users/aisigma/projects/SigmaLink/app/src/main/core/db/schema.ts:109-168`

## 2. Restore Path

On workspace restore (`use-session-restore.ts:131-147`):

```
rpc.swarms.list(workspaceId)          → listSwarmsForWorkspace()
  → loadSwarm(id) per row             → factory-spawn.ts:428-458
    → SELECT swarm_agents WHERE swarm_id = ?   (no filter on status)
    → agents: agentRows.map(r => { ... })      (includes done/error agents)
```

`loadSwarm` returns a `Swarm` with `agents` reflecting **all** historical `swarm_agents` rows regardless of status. An empty-agents swarm IS possible — it is the exact object `createSwarm` returns in the v1.13.1 "default swarm" path (before any agent is added) AND it can arise from DB after every pane exits because agent rows are never deleted, but a swarm spawned with `preset:'custom', roster:[]` would write 0 `swarm_agents` rows.

Files:
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory-spawn.ts:428-458` — `loadSwarm`
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/app/state-hooks/use-session-restore.ts:131-147`

## 3. Can a Swarm Exist in DB with 0 Agents?

Yes, through two paths:

**Path A — v1.13.1 in-flight window**: `addPane()` (both `AddPaneButton.tsx:112-119` and `CommandRoom.tsx:208-216`) calls `rpc.swarms.create({ preset:'custom', roster:[] })` then immediately calls `rpc.swarms.addAgent`. If the process is killed between those two calls, the DB holds a `swarms` row with `status='running'` and zero `swarm_agents` rows. On next boot `loadSwarm` returns `agents: []`.

**Path B — factory guard**: `factory.ts:105-108` resolves the roster as `defaultRoster('custom')` which returns `[]`, then throws `'Cannot create swarm: empty roster.'`. This means **Path A never actually persists the swarm row** — the `db.insert(swarms)` at `factory.ts:125` would not be reached because the guard at line 107 throws before it. The create RPC rejects entirely.

Wait — re-reading `factory.ts:105-108`:
```ts
const roster =
  input.roster && input.roster.length > 0 ? input.roster : defaultRoster(input.preset);
if (roster.length === 0) {
  throw new Error('Cannot create swarm: empty roster.');
}
```
The `db.insert(swarms)` at line 125 comes **after** this guard. So the v1.13.1 `swarms.create({ preset:'custom', roster:[] })` call **always throws** at main — the `rpc.swarms.create` in the renderer will reject, and `addPane()` / `addEmptyStatePane()` will catch the error and show a toast. No swarm row is written.

Files:
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory.ts:105-108` — roster guard (throws before DB insert)
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory.ts:125` — `db.insert(swarms)` (unreachable when roster is empty)
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/AddPaneButton.tsx:112-119` — v1.13.1 create path
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/CommandRoom.tsx:208-216` — v1.13.1 create path

## 4. Bug: v1.13.1 "Create Default Swarm" Path Always Fails

**This is the primary confirmed bug.**

Both `AddPaneButton.addPane()` and `CommandRoom.addEmptyStatePane()` call:
```ts
rpc.swarms.create({ workspaceId, mission:'Default swarm', preset:'custom', roster:[] })
```

On the main side, `factory.ts:105-108` resolves `defaultRoster('custom')` → `[]`, then throws `'Cannot create swarm: empty roster.'` before inserting any DB row. The RPC rejects.

Result: When a workspace has **no swarms**, clicking "+ Pane" or "Add first pane" always shows a toast error — the feature is completely broken for the zero-swarms case that v1.13.1 was meant to enable.

The corresponding test (`AddPaneButton.test.tsx:14`) mocks `rpc.swarms.create` to resolve successfully, so it passes — it does not catch this server-side rejection.

## 5. `activeSwarm.status !== 'running'` + `agents.length` Checks

**`AddPaneButton.getAddPaneDisabledReason` (lines 58-64):**
```ts
if (activeSwarm.status !== 'running') {
  return 'Swarm is paused — resume it to add panes';
}
if (activeSwarm.agents.length >= 20) {
  return `Maximum 20 panes per swarm (current: ${activeSwarm.agents.length})`;
}
```

- A restored swarm with `status='paused'` (schema allows it; no main code writes it yet) would disable the button with "Swarm is paused".
- A restored swarm with `status='running'` and `agents:[]` passes both guards — `getAddPaneDisabledReason` returns `null` (button enabled). This is safe because the button then calls `rpc.swarms.addAgent` directly, which guards against `swarmRow.status !== 'running'` server-side (`factory-add-agent.ts:37-38`).

## 6. `canAddPane = hasRunningSwarm || hasNoSwarms` (CommandRoom lines 249-254)

```ts
const hasRunningSwarm = workspaceSwarms.some((s) => s.status === 'running');
const hasNoSwarms = workspaceSwarms.length === 0;
const canAddPane = !swarmsLoading && providers.length > 0 && (hasRunningSwarm || hasNoSwarms);
```

A restored swarm with `status='completed'` or `status='failed'` (both written by `killSwarm` / `console-controller`) would produce `hasRunningSwarm=false` + `hasNoSwarms=false` → `canAddPane=false`. This correctly hides the "Add first pane" CTA and shows the "Go to Workspaces" button, which is the intended behavior documented in the v1.13.1 comment at line 246.

A restored swarm with `status='running'` and zero agents does NOT affect `canAddPane` — `hasRunningSwarm=true`, button shown. This is fine because `addPane()` will find `activeSwarm` non-null and call `addAgent` directly (skipping the broken `swarms.create` path).

**The only broken scenario is `activeSwarm === null` + workspace exists + not loading**, which happens when there are genuinely zero swarms for a workspace. This is exactly the state the v1.13.1 code tries to handle, and the `swarms.create` call it makes always rejects.

## 7. Proposed Fix

In `factory.ts:createSwarm`, allow `preset='custom'` with an empty roster by skipping the guard when `preset === 'custom'`:

```ts
// File: /Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory.ts:107-109
// Current:
if (roster.length === 0) {
  throw new Error('Cannot create swarm: empty roster.');
}

// Fix:
if (roster.length === 0 && input.preset !== 'custom') {
  throw new Error('Cannot create swarm: empty roster.');
}
```

This allows a `custom`-preset swarm to be created with zero agents, acting as a container that agents are added to individually via `addAgentToSwarm`. All other presets retain the existing guard. The `createSwarm` function's agent-materialization loops (`factory.ts:156-188`) are both `for...of` over empty arrays and are no-ops when the roster is empty, so no further changes are needed in the spawn path.

The SYSTEM mailbox message at `factory.ts:193-200` will still fire (with `agentCount: 0`), which is acceptable.

---

## Summary (5 lines)

1. `swarms` + `swarm_agents` are never deleted; all agents (including exited ones) reload on restore, so `loadSwarm` always returns `agents` matching the full historical roster.
2. A swarm with 0 `swarm_agents` rows can only exist if created via the v1.13.1 "default swarm" path, but that path **always throws** because `factory.ts:107` rejects `preset:'custom', roster:[]` before inserting the swarm row.
3. The v1.13.1 zero-swarms "+ Pane" feature is therefore **completely broken** — both `AddPaneButton` and `CommandRoom` call `swarms.create({ preset:'custom', roster:[] })` which the main process always rejects.
4. A restored swarm with `status!='running'` correctly disables both the `AddPaneButton` (tooltip/pill) and the `canAddPane` empty-state CTA via separate, consistent guards.
5. Fix: change the `factory.ts:107` guard to `roster.length === 0 && input.preset !== 'custom'` so custom swarms can be created empty and populated incrementally via `addAgentToSwarm`.
