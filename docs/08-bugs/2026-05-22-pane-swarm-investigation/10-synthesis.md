# Lane 10 — End-to-End Synthesis: Pane/Swarm Bugs

**Date:** 2026-05-22
**Scope:** Read-only investigation. No code was changed.

---

## 1. Root-Cause Map

### Flow A — "+" Pane button fails with "Could not add pane" toast

**Hop trace:**

1. **User clicks "+ Pane"** in `CommandRoom.tsx` toolbar — `AddPaneButton` is rendered with `activeSwarm=null` (workspace open, no swarm exists yet or swarmsLoading=false now).
2. `AddPaneButton.addPane()` → `src/renderer/features/command-room/AddPaneButton.tsx:112`
   — because `activeSwarm` is `null`, takes the v1.13.1 branch: calls `rpc.swarms.create({ workspaceId, mission: 'Default swarm', preset: 'custom', roster: [] })`.
3. IPC routes to `swarmsCtl.create` → `src/main/core/swarms/controller.ts:53` → `createSwarm(input, deps)`.
4. **`createSwarm` in `src/main/core/swarms/factory.ts:106`:**
   ```ts
   const roster =
     input.roster && input.roster.length > 0 ? input.roster : defaultRoster(input.preset);
   if (roster.length === 0) {
     throw new Error('Cannot create swarm: empty roster.');  // ← THROWS HERE
   }
   ```
   `input.roster = []`, `input.preset = 'custom'`, and `defaultRoster('custom')` returns `[]`
   (`src/main/core/swarms/types.ts:280`). Both branches produce an empty array, so the guard fires.
5. Error propagates back over IPC; `addPane()` catch block at `AddPaneButton.tsx:129` shows:
   `toast.error('Could not add pane', { description: 'Cannot create swarm: empty roster.' })`.

**The mistake v1.13.1 made:**

The comment at `AddPaneButton.tsx:107` says: "`swarms.create` with an empty roster simply provisions the swarm row; `addAgent` will attach the pane." That assumption is wrong. `createSwarm` was never designed to accept an empty roster — the `roster.length === 0` guard pre-dates v1.13.1 (factory.ts:108). The fix would have needed to either (a) pass `preset: 'custom'` WITH at least one roster entry, or (b) create the swarm via a separate lean API that intentionally omits the empty-roster guard.

The `addEmptyStatePane()` path in `CommandRoom.tsx:209` has the exact same bug (identical call site).

---

### Flow B — CLI pane crashes after init → pane silently disappears

**Hop trace:**

1. A spawned CLI (codex, gemini, etc.) exits early or crashes.
2. `node-pty` fires `onExit({ exitCode, signal })` → `PtyRegistry.create()` inner `unsubExit` callback — `src/main/core/pty/registry.ts:263`.
3. Registry marks `rec.alive = false`, fires `this.onExit(id, exitCode, signal)` which broadcasts `pty:exit` over IPC to all renderer windows.
4. Also fires `this.onPaneEvent({ sessionId: id, kind: exitCode === 0 ? 'exited' : 'error', exitCode })` at `registry.ts:272`.
5. Grace timer (`gracefulExitDelayMs = 3000ms`) fires → `this.forget(id)` clears the ring buffer and removes the session from the registry.
6. **Renderer receives `pty:exit`** → `use-live-events.ts:29` → dispatches `MARK_SESSION_EXITED` → `state.reducer.ts:272` marks the session `status: 'exited'`.
7. **`useExitedSessionGc`** in `use-exited-session-gc.ts:25` detects `status === 'exited'` and schedules a `REMOVE_SESSION` dispatch after `EXITED_AUTO_REMOVE_MS = 5000ms`.
8. After 5 seconds, `REMOVE_SESSION` fires → `state.reducer.ts:284` removes the session from the sessions array. With no remaining sessions for the workspace, the `CommandRoom` shows the empty-state ("No agents launched yet") with no error or fallback terminal.

**Why it's silent:**

- `MARK_SESSION_EXITED` → `REMOVE_SESSION` auto-removal path contains no user-facing toast or notification for the removal itself.
- The `onPaneEvent` write to `jorvis_pane_events` and `pushPtyExitNotification` feed the **notifications bell** (not the toast system), and only if the pane event is an exit. The notification appears in the bell but does not prevent the pane from silently disappearing.
- There is no "terminal fallback" or "pane went offline" banner left in the UI after removal. The pane slot simply vanishes.

---

## 2. Independence vs. Shared Root

| Issue | Root |
|---|---|
| Flow A — empty-roster `swarms.create` | Wrong call-site assumption in v1.13.1: `preset:'custom'` + `roster:[]` is always rejected by the factory guard. Fully independent. |
| Flow B — pane disappears on crash | Auto-GC (`useExitedSessionGc` 5s REMOVE) + no toast/fallback. Fully independent. |
| P2 — restored workspace shows empty swarm that blocks "+ Pane" | Related to Flow A: the restored `Swarm` object from `loadSwarm` has `agents: []` (all PTYs are dead), `swarm.status = 'running'`, so `activeSwarm !== null`. `addPane()` takes the EXISTING swarm branch, calls `addAgent({swarmId, providerId})`, and `addAgentToSwarm` checks `swarmRow.status !== 'running'` (passes) — but the `swarm_agents` table may have 0 live sessions. This path WORKS correctly for the re-add case. However if the restored swarm's DB status is `'completed'` (killSwarm was called), `addAgentToSwarm` throws "status is completed", causing the same "Could not add pane" toast. This is a DIFFERENT trigger path from Flow A but the same toast. |

**Summary:**
- Flow A and Flow B share no root.
- P2 is a variant of Flow A only when the restored swarm has `status !== 'running'`.

---

## 3. Prioritized Minimal Remediation Plan

### P0 — Unblock pane creation (the roster fix)

**Problem:** `swarms.create({ preset: 'custom', roster: [] })` throws.

**Smallest safe change:**

In `AddPaneButton.tsx:addPane()` and `CommandRoom.tsx:addEmptyStatePane()`, do NOT call `swarms.create` at all for the zero-swarms case. Instead, call `swarms.addAgent` directly and let the backend create-or-reuse logic handle it — OR pass a meaningful `preset` that produces a non-empty default roster. The cleanest minimal fix is to change `factory.ts` to allow an empty roster when `preset === 'custom'`, skipping the agent-spawn loop rather than throwing:

```ts
// factory.ts:107 — CURRENT (throws)
if (roster.length === 0) {
  throw new Error('Cannot create swarm: empty roster.');
}

// PROPOSED (allow empty-roster custom swarms; agents added later via addAgent)
if (roster.length === 0 && input.preset !== 'custom') {
  throw new Error('Cannot create swarm: empty roster (non-custom preset requires agents).');
}
// For custom preset with roster:[], proceed — swarm row is created, agents added via addAgent.
```

The swarm `status: 'running'` is already set before the roster loop, so the `addAgentToSwarm` guard passes immediately after. `mailbox.append` SYSTEM message is skipped only if `agents.length === 0` — the existing code only appends if `agents.length > 0`... actually the append is unconditional at `factory.ts:193`, which is safe.

**Do NOT** change the preset check order — non-custom presets with a missing roster should still fail loudly.

**Test to lock it:**
```
test: swarms.create({ workspaceId, mission: 'x', preset: 'custom', roster: [] })
  → resolves with a Swarm (status='running', agents=[])
  → subsequent addAgent({ swarmId, providerId }) resolves with a session
```

---

### P1 — Pane crash → error/fallback instead of silent disappear

**Problem:** When a CLI PTY exits early, the pane disappears in 5 s with no visible error state left in the UI.

**Smallest safe change (two parts):**

1. In `use-exited-session-gc.ts`, gate the auto-remove timer on exit code. Sessions that exit with `exitCode !== 0` (or `exitCode = -1`) should NOT be auto-removed on the 5-second timer. Instead, dispatch `MARK_SESSION_EXITED` and leave the pane visible in an error banner state (the terminal cache already writes the exit message to the xterm). Users dismiss manually or the existing "Respawn fresh" flow handles recovery.

   Alternatively, keep the 5-second remove but show a toast when a pane with `exitCode !== 0` is auto-removed:

   ```ts
   // use-exited-session-gc.ts — inside the timer callback
   const session = state.sessions.find(s => s.id === sessionId);
   if (session?.exitCode !== 0 && session?.exitCode !== undefined) {
     toast.error(`Pane exited (code ${session.exitCode})`, { description: 'Pane removed.' });
   }
   dispatch({ type: 'REMOVE_SESSION', id: sessionId });
   ```

2. The pane's `Terminal.tsx` already writes an exit banner when `pty:exit` arrives — ensure the banner includes the exit code and is visible before the pane is removed.

**Test to lock it:**
```
test: spawn a pane with a provider whose binary immediately exits code 1
  → pty:exit fires → MARK_SESSION_EXITED
  → error toast appears within 1s (before REMOVE_SESSION)
  → REMOVE_SESSION fires after 5s
```

---

### P2 — Existing-workspace restore: swarm with status='completed' blocks addAgent

**Problem:** When the user re-opens a workspace whose swarm was killed (status='completed'), `addAgentToSwarm` throws "status is completed". This surfaces as "Could not add pane" toast — same UX as the P0 failure but different trigger.

**Smallest safe change:**

In `AddPaneButton.addPane()`, when `addAgent` throws with a message containing "status is" (the specific factory wording), create a new swarm first, then retry `addAgent`. OR: more defensively, in `getAddPaneDisabledReason`, check `activeSwarm.status !== 'running'` and show "Swarm is completed — add a new pane to restart it." (the existing `activeSwarm.status !== 'running'` guard at `AddPaneButton.tsx:58` already fires for `'paused'` but `'completed'` falls through because `'completed'` is not `'paused'`).

Actually, looking at the code: `AddPaneButton.tsx:58` checks `activeSwarm.status !== 'running'` and returns "Swarm is paused — resume it to add panes". This fires for `status='completed'` too. So the button IS disabled for a completed swarm — the toast path is only hit if `activeSwarm` is somehow not null but status is not 'running', which the disabled check already catches.

**Re-evaluation:** The actual P2 risk is that the swarm restore path in `use-session-restore.ts:132-147` fetches `rpc.swarms.list(workspaceId)` and dispatches `UPSERT_SWARM` for ALL swarms including completed ones. The `activeSwarm` derivation in CommandRoom.tsx:88-93 picks `workspaceSwarms.find((s) => s.status === 'running')`. If all swarms are completed, `activeSwarm = null`, and the v1.13.1 `swarms.create({roster:[]})` path fires again. So P2 IS a recurrence of P0 via the restore path.

**Fix:** Same as P0 — allow `roster:[]` for `preset:'custom'` in `createSwarm`.

**Test to lock it:**
```
test: workspace with one swarm that has status='completed' in DB
  → app restores workspace
  → activeSwarm = null (no running swarm)
  → user clicks "+ Pane"
  → swarms.create({ preset:'custom', roster:[] }) resolves
  → addAgent resolves → pane appears
```

---

## 4. Regression Test List

| # | Test | Guards Against |
|---|---|---|
| T-01 | `swarms.create({ preset:'custom', roster:[] })` resolves with an empty-agent swarm (P0) | Recurrence of empty-roster throw |
| T-02 | `AddPaneButton` with `activeSwarm=null`: clicking provider creates swarm then adds agent (E2E renderer test, already in AddPaneButton.test.tsx case 14 — MUST stay passing after fix) | v1.13.1 flow regression |
| T-03 | CLI exits code 1 → toast appears before pane is removed (P1) | Silent pane disappear |
| T-04 | CLI exits code 0 → pane removed silently after 5s (P1, correct behaviour preserved) | Over-alerting on clean exit |
| T-05 | Restore workspace with all-completed swarms → `activeSwarm=null` → addPane creates new swarm → addAgent succeeds (P2) | P2 recurrence via restore path |
| T-06 | `createSwarm({ preset:'solo', roster:[] })` still throws (non-custom empty roster guard preserved) | Over-permissive guard change |

---

## 5. What v1.13.1 Got Wrong (Do Not Repeat)

The v1.13.1 fix added a `swarms.create({ preset: 'custom', roster: [] })` call under the assumption that passing an empty roster would provision a bare swarm row. The factory's `roster.length === 0` guard (in place since the swarm factory was written) makes this call throw unconditionally for `preset: 'custom'`. The fix needs to land in the factory (allow empty-roster custom swarms), not in the call-site. Any future call-site that re-uses `swarms.create` for swarm provisioning without agents MUST use `preset: 'custom'` AND the factory must allow it, OR use a dedicated `provisionSwarm` API that explicitly skips the empty-roster guard.

---

*Files referenced in this investigation:*

- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/AddPaneButton.tsx`
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/CommandRoom.tsx`
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory-add-agent.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/factory-spawn.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/controller.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/swarms/types.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/pty/registry.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/app/state-hooks/use-exited-session-gc.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/app/state-hooks/use-live-events.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/app/state-hooks/use-session-restore.ts`
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/app/state.reducer.ts`
