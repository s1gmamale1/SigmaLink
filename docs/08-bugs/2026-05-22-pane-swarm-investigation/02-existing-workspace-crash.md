# Bug: Existing (pre-v1.13) Workspace Crashes on Restore — Root Cause

**Date**: 2026-05-22
**Track**: Lane 2 — existing-workspace restore path

---

## Root Cause

The crash is a **double-throw**: the migration completes cleanly, but the restore
path then calls `rpc.swarms.create({ preset: 'custom', roster: [] })` which
immediately throws `"Cannot create swarm: empty roster."` inside `createSwarm`
at `factory.ts:108`.

### Sequence

1. **Migration 0022 runs cleanly.**
   An old DB (pre-v1.12.1) carrying `sigma_pane_events` and
   `sigma_monitor_conversation_id` is renamed by migration 0022 to
   `jorvis_pane_events` / `jorvis_monitor_conversation_id`.  The migration is
   idempotent and throws only on an actual SQLite error.  No crash here.

2. **Session-restore drain fires** (`use-session-restore.ts:72–228`).
   Once `state.ready === true` the drain effect calls `rpc.panes.resume(wsId)`
   for every restored workspace, then `rpc.panes.listForWorkspace(wsId)` and
   `rpc.swarms.list(wsId)`.  An old workspace has no swarm rows — the swarm
   wizard was introduced in v1.13 — so `swarms.list` returns `[]` and
   `state.swarms` stays empty.  `state.activeSwarm` is therefore `null`.

3. **User clicks "+ Pane" (or the empty-state CTA fires automatically).**
   Both `AddPaneButton.addPane()` (`AddPaneButton.tsx:108–119`) and
   `addEmptyStatePane()` (`CommandRoom.tsx:201–217`) take the `!activeSwarm`
   branch and call:
   ```ts
   rpc.swarms.create({
     workspaceId: activeWorkspace.id,
     mission: 'Default swarm',
     preset: 'custom',
     roster: [],
   });
   ```

4. **`createSwarm` throws.** (`factory.ts:105–108`)
   ```ts
   const roster =
     input.roster && input.roster.length > 0
       ? input.roster
       : defaultRoster(input.preset);   // defaultRoster('custom') → []
   if (roster.length === 0) {
     throw new Error('Cannot create swarm: empty roster.');  // ← THROW
   }
   ```
   `defaultRoster('custom')` explicitly returns `[]` (`types.ts:280`).
   `input.roster` is `[]`.  Both paths yield an empty array, so the guard
   always fires when `preset = 'custom'` and `roster = []`.

### Exact throw location

`/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory.ts:108`

```ts
throw new Error('Cannot create swarm: empty roster.');
```

---

## Why the 'sigma' room key does NOT crash

`normalizeRoomId` in `parsers.ts:89–91` maps `'sigma'` → `'jorvis'` before
`isRoomId` is called, so a workspace that had `room: 'sigma'` in its persisted
snapshot restores cleanly to the `jorvis` room.  No assert/crash on that path.

## Why DB migration does NOT crash

Migration 0022 is fully idempotent: every rename operation is guarded by
`tableExists` / `columnExists` / `indexExists` checks.  A fresh install (table
never existed) is a silent no-op; a previously-migrated DB is also a no-op.
The migration runner (`migrate.ts:83–98`) only executes rows not yet in
`schema_migrations`, so 0022 runs at most once per DB.

---

## Repro (mental walkthrough)

1. Open SigmaLink v1.12.x; create a workspace; do not run the swarm wizard.
   `swarms` table has zero rows for that workspace.
2. Upgrade to v1.13.x.  On next boot: migrations 0021–0022 run.
3. App loads; session-restore drain fires; `swarms.list(wsId)` → `[]`.
4. CommandRoom renders with `sessions.length === 0` AND `activeSwarm === null`.
   `swarmsLoading` flips false after the list RPC resolves.
   `canAddPane = true` because `hasNoSwarms === true` (line 250).
   The "Add first pane" CTA is shown.
5. User clicks it → `addEmptyStatePane()` → `rpc.swarms.create({ preset: 'custom', roster: [] })`.
6. **Throws**: `"Cannot create swarm: empty roster."`
   The error is caught by the try/catch in `addEmptyStatePane` and surfaced as
   `toast.error('Could not add pane', { description: "Cannot create swarm: empty roster." })`.
   The pane is never created; the workspace appears permanently broken.

---

## Proposed Fix

In both `addPane` (AddPaneButton.tsx) and `addEmptyStatePane` (CommandRoom.tsx),
when creating the default swarm for an old workspace, use `preset: 'squad'`
instead of `preset: 'custom'` — OR pass a minimal single-agent roster:

**Option A — use a named preset** (simplest, 1-line change per call site):
```ts
const newSwarm = await rpc.swarms.create({
  workspaceId: activeWorkspace.id,
  mission: 'Default swarm',
  preset: 'squad',   // was: 'custom' — 'custom' + [] always throws
  roster: [],        // defaultRoster('squad') fills in the 5-agent split
});
```

**Option B — pass a single-builder roster** (lightest swarm, closest to intent):
```ts
const newSwarm = await rpc.swarms.create({
  workspaceId: activeWorkspace.id,
  mission: 'Default swarm',
  preset: 'custom',
  roster: [{ role: 'builder', roleIndex: 1, providerId }],
});
```

**Option C — fix in `createSwarm` itself**: allow `preset: 'custom'` with
`roster: []` to create an empty swarm row (no agents spawned at creation time),
then let the `addAgent` call that follows populate it.  This matches the
semantic intent of the v1.13.1 code comment ("create a minimal default swarm
before adding the agent; `swarms.create` with an empty roster simply provisions
the swarm row").  The guard at `factory.ts:107–109` would be removed or weakened
to `if (input.preset !== 'custom' && roster.length === 0)`.

Option C is the cleanest architectural fix: the code comment at
`AddPaneButton.tsx:105–107` already documents the intent of provisioning an
empty row, but `factory.ts` has not been updated to allow it.

**Affected files**:
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory.ts` line 107–109
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/AddPaneButton.tsx` line 112–117
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/CommandRoom.tsx` line 209–213

---

## 5-Line Summary

1. **Migration 0022 is not the crash**: it migrates cleanly; the Sigma→Jorvis
   rename (`sigma_pane_events` → `jorvis_pane_events`, column rename on
   `agent_sessions`) is idempotent and always succeeds.
2. **The room-key rename is handled**: `normalizeRoomId('sigma')` → `'jorvis'`
   in `parsers.ts:90` prevents any assert on the restore drain.
3. **The crash point is `factory.ts:108`**: `createSwarm` always throws
   `"Cannot create swarm: empty roster."` when called with `preset:'custom'`
   and `roster:[]` — exactly the arguments both v1.13.1 call sites pass.
4. **Root cause is a contract mismatch**: `AddPaneButton.tsx:105–107` and the
   comment at `CommandRoom.tsx:200` state intent to "provision the swarm row"
   with no agents, but `factory.ts` never implemented that contract and still
   requires at least one roster entry for any preset.
5. **Fix**: either pass `preset:'squad'` (let `defaultRoster` fill the roster),
   pass a single-agent roster explicitly, or relax the `factory.ts` guard to
   permit `custom` + empty roster and defer agent materialisation to the
   subsequent `addAgent` call.
