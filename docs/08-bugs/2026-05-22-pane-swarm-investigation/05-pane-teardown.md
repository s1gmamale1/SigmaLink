# Lane 5 — Pane Teardown: Runtime-Crash Pane Disappears

## Root Cause

A CLI process that dies **after startup** (runtime-crash) triggers the same
auto-removal timer as a clean exit and the pane disappears within 5 s. The
prior audit described an `error`-status pane persisting — that only applies to
**spawn failures** (ENOENT, pre-flight catch block). Runtime crashes take a
completely different path and land in `status: 'exited'`, which the GC timer
unconditionally removes.

## Full Removal Chain

### 1. PTY exit fires in main process
`src/main/core/pty/registry.ts:263` — `pty.onExit` callback in
`PtyRegistry.create`:

```
rec.alive = false
this.onExit(id, exitCode, signal)          // → broadcast('pty:exit', …)
setTimeout(() => this.forget(id), 3_000)   // drops ring-buffer after 3 s
```

`this.onExit` is wired in `rpc-router.ts:321`:
```
(sessionId, exitCode, signal) => broadcast('pty:exit', { sessionId, exitCode, signal })
```

Concurrently, the `onExit` closure registered inside **`launcher.ts:431`** runs:
```ts
const earlyDeath = Date.now() - startedMs < 1500;
db.update(agentSessions).set({
  status: earlyDeath ? 'error' : 'exited',
  …
})
```

For a runtime crash (lives > 1.5 s), `earlyDeath === false`, so the DB row is
written as `status = 'exited'`.

### 2. Renderer receives `pty:exit` — MARK_SESSION_EXITED

`src/renderer/app/state-hooks/use-live-events.ts:29-36`:
```ts
window.sigma.eventOn('pty:exit', (raw) => {
  dispatch({ type: 'MARK_SESSION_EXITED', id: p.sessionId, exitCode });
});
```

`state.reducer.ts:272-283` — MARK_SESSION_EXITED:
```ts
{ ...s, status: 'exited', exitCode: action.exitCode, exitedAt: Date.now() }
```

The session now has `status: 'exited'` in the renderer state.

### 3. GC timer fires — REMOVE_SESSION after 5 s

`src/renderer/app/state-hooks/use-exited-session-gc.ts:25-35`:
```ts
if (session.status === 'exited' && !timers.has(session.id)) {
  const t = setTimeout(() => {
    …
    dispatch({ type: 'REMOVE_SESSION', id: sessionId });
  }, EXITED_AUTO_REMOVE_MS);   // 5 000 ms
}
```

The check is `status === 'exited'` — it fires for **both** a clean exit and a
runtime crash. No distinction is made.

### 4. REMOVE_SESSION filters the session out of the array

`state.reducer.ts:285`:
```ts
const sessions = state.sessions.filter((s) => s.id !== action.id);
```

The pane vanishes from `sessionsByWorkspace`, the grid re-renders with one
fewer cell, and the xterm cache entry is destroyed.

---

## Spawn-Failure vs Runtime-Crash Paths (distinction)

| Condition | `earlyDeath` | DB status | Renderer status after pty:exit |
|-----------|-------------|-----------|-------------------------------|
| ENOENT / pre-flight catch (never starts) | n/a — caught before `pty.create` | no DB row | `'error'` (set by `launcher.ts` catch block, line 472) |
| Exits within 1.5 s of spawn | `true` | `'error'` | **`'exited'`** (see gap below) |
| Exits after 1.5 s (runtime-crash) | `false` | `'exited'` | `'exited'` |

**Critical gap**: the `launcher.ts` DB update correctly writes `status: 'error'`
for earlyDeath sessions, but the renderer's `MARK_SESSION_EXITED` reducer
**always** sets `status: 'exited'` regardless of exit code or timing. The DB
and renderer states diverge. Even for the 0–1.5 s case the renderer marks it
`exited`, the GC timer fires, and the pane is removed in 5 s.

The prior audit's "error pane persists" claim is only true for ENOENT paths
where the launcher catch block pushes an `AgentSession` object with
`status: 'error'` into the `sessions` array **before** any PTY exists. Those
sessions never receive a `pty:exit` event and are never enqueued by the GC.

---

## What Should Happen

When `pty:exit` fires (or when `earlyDeath` is detected):

1. The session should be marked `status: 'error'` (not `'exited'`) when the exit
   code is non-zero OR when earlyDeath is true.
2. Error-status sessions should **not** be auto-removed by the GC timer.
3. The pane should stay visible with:
   - The terminal scrollback intact (so the user can read the crash output).
   - An error banner or coloured header indicating the crash.
   - A "Relaunch" button and an "Open shell" fallback affordance.
4. The user explicitly closes the pane when ready.

---

## Proposed Fix (non-breaking, targeted)

### A. Carry exit semantics from main to renderer in the `pty:exit` broadcast

Extend the broadcast payload to include the `earlyDeath` flag or let the
renderer derive it from `exitCode`:

**`rpc-router.ts:321`** — add `exitCode` to the broadcast (already present).
No change needed here; the renderer receives `exitCode`.

### B. `MARK_SESSION_EXITED` → distinguish crash vs clean exit

**`state.reducer.ts:272-283`** — change:
```ts
{ ...s, status: 'exited', … }
```
to:
```ts
{ ...s,
  status: (action.exitCode !== 0 && action.exitCode !== undefined)
    ? 'error'
    : 'exited',
  … }
```

### C. GC timer must skip `error` sessions

**`use-exited-session-gc.ts:25`** — already only checks `status === 'exited'`,
so fix B alone is sufficient: a crashed session lands as `status: 'error'`,
the GC timer never enqueues it, and the pane stays visible.

### D. PaneShell error UI needs a "Relaunch" affordance for runtime crashes

**`src/renderer/features/command-room/PaneShell.tsx:351-356`** — the `errored`
branch currently shows "Failed to launch" with `session.error`. It should also
render when `session.status === 'error'` **and** `session.exitCode !== undefined`
(a crash) with a different message ("Session crashed — exit code N"), the
terminal scrollback visible below, and a "Relaunch" / "Open terminal" button.

---

## Evidence Files (read in this investigation)

- `src/main/core/pty/registry.ts` — PTY exit → `onExit` → gracefulExitDelayMs forget
- `src/main/rpc-router.ts:321` — `broadcast('pty:exit', …)`
- `src/main/core/workspaces/launcher.ts:431-444` — `earlyDeath` heuristic + DB update
- `src/renderer/app/state-hooks/use-live-events.ts:29-36` — `MARK_SESSION_EXITED` dispatch
- `src/renderer/app/state.reducer.ts:272-283` — always sets `status: 'exited'`
- `src/renderer/app/state-hooks/use-exited-session-gc.ts:25-35` — 5 s GC fires on `exited`
- `src/renderer/app/state.reducer.ts:285` — `REMOVE_SESSION` filters session from array
- `src/renderer/features/command-room/PaneShell.tsx:169,351-356` — error UI only for spawn-failure

---

## 5-Line Summary

1. Runtime-crash: `registry.ts` fires `pty:exit` → renderer dispatches `MARK_SESSION_EXITED` → reducer unconditionally sets `status: 'exited'` (`state.reducer.ts:275`).
2. `use-exited-session-gc.ts:25` checks `status === 'exited'` and enqueues a `REMOVE_SESSION` after 5 000 ms — no exception for crash exits.
3. `state.reducer.ts:285` filters the session from the array; the pane cell vanishes from the grid.
4. The `error`-pane path only fires for ENOENT/pre-flight failures where the launcher catch block pushes a synthetic `{status:'error'}` session that never receives `pty:exit`.
5. Fix: in `MARK_SESSION_EXITED`, set `status: 'error'` when `exitCode !== 0`; the GC guard on `'exited'` then preserves the pane automatically.
