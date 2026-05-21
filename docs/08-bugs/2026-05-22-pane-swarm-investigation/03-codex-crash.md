# Codex Crash Investigation: Pane Disappears Instead of Showing Error

## Root Cause Summary

When Codex initializes and then crashes within **1.5 seconds** of spawn, the pane window
disappears entirely instead of showing an error state. This is caused by two compounding
issues:

1. **Wrong status emitted on fast crash**: `executeLaunchPlan`'s inline `onExit` handler
   classifies any exit within 1500ms as `'error'` in the DB, but the **renderer only receives
   `'exited'`** via the `pty:exit` IPC broadcast (which always dispatches
   `MARK_SESSION_EXITED` — hardcoded to `status: 'exited'`). The `'error'` status is never
   propagated to the renderer at all.

2. **Auto-GC removes `'exited'` panes after 5 seconds**: `use-exited-session-gc.ts`
   (`EXITED_AUTO_REMOVE_MS = 5_000`) watches for any session whose status transitions to
   `'exited'` and fires `REMOVE_SESSION` after 5 seconds. Because the fast-crash Codex
   pane lands as `'exited'` (from the renderer's perspective), it is silently removed from
   `state.sessions` — causing the pane cell to vanish from the grid.

There is **no shell fallback** for a crashed CLI provider. The registry only knows how to
kill and forget sessions; `resolveAndSpawn` only walks `altCommands` for ENOENT — not for
post-init crashes. The renderer has no code path that converts a crashed CLI session into
a live shell pane.

---

## Full Lifecycle Trace

### 1. Codex spawn (`executeLaunchPlan`)

- File: `src/main/core/workspaces/launcher.ts:315`
- `resolveAndSpawn` calls `deps.ptyRegistry.create(...)` which calls `spawnLocalPty`.
- Codex has `command: 'codex'`, `args: []`, `oneshotArgs: ['-q', '{prompt}']`.
  - File: `src/shared/providers.ts:84-103`
- Session is inserted into `agent_sessions` with `status: 'running'`.
  - File: `src/main/core/workspaces/launcher.ts:349-386`
- An inline `rec.pty.onExit` handler is wired:
  - File: `src/main/core/workspaces/launcher.ts:431-445`
  - If `Date.now() - startedMs < 1500` → writes `status = 'error'` to DB.
  - Otherwise → writes `status = 'exited'`.
- The `AgentSession` pushed to the renderer has `status: 'running'`.
  - File: `src/main/core/workspaces/launcher.ts:414-424`

### 2. Codex crashes post-init

- The node-pty `proc.onExit` fires inside `spawnLocalPty`'s event loop.
  - File: `src/main/core/pty/local-pty.ts:581-583`
- This propagates through `PtyHandle.onExit` into `PtyRegistry.create`'s `unsubExit`
  handler.
  - File: `src/main/core/pty/registry.ts:263-288`
- Registry sets `rec.alive = false`, `rec.exitCode`, fires `this.onExit(id, exitCode,
  signal)`.
  - File: `src/main/core/pty/registry.ts:264-269`
- `this.onExit` is wired in `rpc-router.ts` to:
  ```
  broadcast('pty:exit', { sessionId, exitCode, signal })
  ```
  - File: `src/main/rpc-router.ts:319-321`
- `onPaneEvent` is fired with `kind: 'error'` (when exitCode !== 0) or `'exited'`:
  - File: `src/main/core/pty/registry.ts:271-275`
- Grace timer of **3000ms** (v1.5.6) calls `forget(id)` which removes the session from
  the registry map.
  - File: `src/main/core/pty/registry.ts:288`

### 3. Renderer receives `pty:exit` — status always becomes `'exited'`

- File: `src/renderer/app/state-hooks/use-live-events.ts:29-37`
  ```ts
  dispatch({ type: 'MARK_SESSION_EXITED', id: p.sessionId, exitCode });
  ```
- `MARK_SESSION_EXITED` reducer hardcodes `status: 'exited'`:
  - File: `src/renderer/app/state.reducer.ts:272-283`
  ```ts
  { ...s, status: 'exited', exitCode: action.exitCode, exitedAt: Date.now() }
  ```
- **Critical gap**: there is no `MARK_SESSION_ERROR` action and no mechanism to
  distinguish a fast crash from a clean exit at the renderer level. The `'error'` status
  written to the DB by the launcher is **never IPC'd back** to the renderer.

### 4. Auto-GC removes the pane after 5 seconds (disappear)

- File: `src/renderer/app/state-hooks/use-exited-session-gc.ts:22-35`
  ```ts
  if (session.status === 'exited' && !timers.has(session.id)) {
    // ... after EXITED_AUTO_REMOVE_MS (5000ms)
    dispatch({ type: 'REMOVE_SESSION', id: sessionId });
  }
  ```
- `REMOVE_SESSION` splices the session from `state.sessions` and
  `state.sessionsByWorkspace`.
  - File: `src/renderer/app/state.reducer.ts:284-306`
- `CommandRoom` derives `cells` from `state.sessionsByWorkspace[workspaceId]`; with the
  session gone, `GroupSessionsIntoCells` produces one fewer cell and `GridLayout` re-renders
  without the Codex pane.
  - File: `src/renderer/features/command-room/CommandRoom.tsx:136`

### 5. Why there is no shell fallback

- `resolveAndSpawn` only falls back to `altCommands` on synchronous ENOENT at spawn time.
  - File: `src/main/core/providers/launcher.ts:311-363`
- No code in the registry, rpc-router, or renderer converts a post-init crash into a fresh
  shell spawn. `PaneSplash` hides once `session.status === 'exited'`
  (`src/renderer/features/command-room/PaneSplash.tsx:55`) but does not trigger a fallback.
- The `shell` sentinel provider exists but nothing automatically re-spawns a crashed CLI
  pane as a shell.

---

## Disappear-vs-Error Mechanism (the core problem)

| What happens | Where |
|---|---|
| Codex crashes | `spawnLocalPty` → `onExit` |
| DB gets `status='error'` on fast crash | `launcher.ts:436` (main process only) |
| Renderer receives `pty:exit` broadcast | `rpc-router.ts:320` |
| Renderer dispatches `MARK_SESSION_EXITED` | `use-live-events.ts:34` |
| Reducer sets `status: 'exited'` (never `'error'`) | `state.reducer.ts:275` |
| GC timer fires after 5 s | `use-exited-session-gc.ts:27-35` |
| `REMOVE_SESSION` splices the pane | `state.reducer.ts:284-306` |
| Pane cell disappears from grid | `CommandRoom.tsx:136` |

The `'error'` sessions that **do** stay visible (e.g. unknown-provider errors) are added
synchronously at launch time with `status: 'error'` in the initial `ADD_SESSIONS`
dispatch (`launcher.ts:465-476`). The GC only watches for `'exited'`, not `'error'`, so
those error sessions persist. But a crashed post-init session never gets `status: 'error'`
in the renderer — it goes straight to `'exited'` then disappears.

---

## Proposed Fix

**Two-part fix — no schema changes needed:**

### Fix A — Propagate the error status to the renderer

In `rpc-router.ts`, change the `onExit` broadcast to include whether the exit was a fast
crash. One approach: the launcher's inline `onExit` (which already knows `earlyDeath`)
can broadcast a separate event, or the `gracefulExitDelayMs` path in the registry could
pass a flag. The minimal approach is:

Extend the `pty:exit` IPC envelope to include an optional `isError` boolean, set when
`exitCode < 0 OR earlyDeath`. The renderer's `MARK_SESSION_EXITED` case checks this flag
and sets `status: 'error'` instead of `'exited'`.

Or more surgically: add a `MARK_SESSION_ERROR` action alongside `MARK_SESSION_EXITED` and
have the launcher broadcast a separate `pty:error` event for fast crashes. The GC hook
already ignores `'error'` sessions (`if (session.status === 'exited' && ...)`) so they
would persist with an error banner.

**Files to touch:**
- `src/main/core/workspaces/launcher.ts:431-445` — broadcast `'pty:error'` on early death
- `src/renderer/app/state.types.ts` — add `MARK_SESSION_ERROR` action
- `src/renderer/app/state.reducer.ts` — handle `MARK_SESSION_ERROR` → `status: 'error'`
- `src/renderer/app/state-hooks/use-live-events.ts` — subscribe to `'pty:error'`

### Fix B — Show a shell fallback (optional, separate from Fix A)

Add a "Restart as shell" button to the pane error overlay. When clicked, call
`rpc.pty.create({ providerId: 'shell', cwd: session.cwd })` and update the session in
state. This does not require the registry or launcher to change.

---

## 5-Line Summary

1. Codex crashes within 1.5 s of spawn; `launcher.ts:436` writes `status='error'` to DB but broadcasts only `pty:exit` (no error flag) via `rpc-router.ts:320`.
2. Renderer dispatches `MARK_SESSION_EXITED` (`use-live-events.ts:34`) which hardcodes `status: 'exited'` — the `'error'` state never reaches the renderer.
3. `use-exited-session-gc.ts:27-35` GC fires `REMOVE_SESSION` after 5 s for any `'exited'` session, splicing the Codex pane from `state.sessions`.
4. `CommandRoom` re-derives `cells` from the now-shorter `sessionsByWorkspace` and the pane grid cell disappears silently — no error banner, no shell fallback.
5. Fix: broadcast a distinct `pty:error` event (or flag) on early-death exits, add `MARK_SESSION_ERROR` to the reducer, and ensure the GC ignores `'error'` sessions (it already does — only `'exited'` sessions are auto-removed).
