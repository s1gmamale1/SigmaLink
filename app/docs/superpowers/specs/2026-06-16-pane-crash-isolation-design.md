# Pane crash isolation + resume-loop backoff + boot safety net

**Date:** 2026-06-16
**Status:** Design approved (operator), pending spec review → plan → TDD implementation
**Base:** `origin/main` @ `c44868a` (v2.7.0)

## Problem

After a hard power-loss kill (no graceful quit), on restart SigmaLink restores the
last session: multiple workspaces (`app.lastSession.openWorkspaces`) each resume
their panes. The operator observes: workspaces open, panes load for a few seconds,
then "panes crash and it routes back to 'go to workspace'", repeating on every
restart. The app is effectively unusable.

### Evidence gathered (Phase 1, systematic-debugging)

- **DB is healthy** — `PRAGMA integrity_check = ok`. Not corruption. The app reads
  valid persisted state and the **restore/render logic chokes on it**.
- Persisted state: 5 `openWorkspaces`, ~7 sessions stuck `status='running'` (the
  power kill never flipped them to `exited`), plus open `status='error'` sessions
  and stale `browser_tabs` (dead localhost URLs).
- **Main-process resume largely succeeds** — after the boot janitor flips
  `running`→`exited,-1`, panes resume and the DB shows them `running` (PTY alive).
  So the failure is **renderer-side**, when mounting/rendering the restored panes.
- **Browser-tab restore is eliminated** — views are lazily constructed, never
  created during boot/restore, fully `try/catch`-guarded, decoupled from the
  restore `Promise.all`.
- Operator-reported symptom ("panes crash → route to 'go to workspace'", "a few
  seconds after panes load") is a **React render throw inside the command-room pane
  tree**, caught by `RoomErrorBoundary` (`App.tsx:173`), which swaps the room for a
  fallback / the `sessions.length === 0` "Go to Workspaces" empty state.

## Root causes (three confirmed + one unknown)

1. **No per-pane crash isolation (confirmed).** The entire command room sits under a
   single `RoomErrorBoundary`. There is no boundary between `CommandRoom` →
   `PaneGrid` → `PaneShell`. A single restored pane's render throw therefore takes
   down the **whole room**, not just that pane.

2. **Resume loop never backs off (confirmed).** The boot janitor
   (`janitor.ts:33-49`) flips orphaned `running`/`starting` → `exited,-1`. But
   `exited,-1` is *also* the resume-eligible state **and** the value
   `markResumeFailed` (`resume-launcher.ts:264-277`) writes on a failed spawn — the
   resume predicate `listEligibleRows` (`resume-launcher.ts:333-358`) matches
   `running OR (exited AND exit_code = -1)`. So a pane that fails to spawn is retried
   identically on **every** boot, forever, with no attempt cap.

3. **No main-process safety net (confirmed).** Zero
   `process.on('uncaughtException')` / `process.on('unhandledRejection')` handlers
   anywhere in main; the boot chain `app.whenReady().then(async () => {...})`
   (`electron/main.ts:873`) has no `.catch()`. Any unhandled main-side boot error
   dies silently with no log and no recovery.

4. **The exact throwing component (unknown).** Could not be pinned from code + DB
   alone, and the operator cannot capture the DevTools console right now. The app
   logs it (`ErrorBoundary.componentDidCatch` → `console.error('[ErrorBoundary]', …)`)
   but does not persist it. Part 4 below fixes that so the surgical fix is a trivial
   follow-up.

## Design

Four focused, additive/defensive parts. No DB migration.

### Part 1 — Per-pane error boundary (the symptom fix · renderer)

Wrap each pane's rendered content inside `CommandRoom`'s `renderLeaf` in a
`PaneErrorBoundary` keyed by `session.id`, reusing the existing `ErrorBoundary`
class (`src/renderer/app/ErrorBoundary.tsx`).

- **Fallback** = a compact, in-cell card ("This pane couldn't render" + the error
  message) with three actions:
  - **Relaunch** → existing `onRelaunch` (re-adds a pane of the same provider).
  - **Close pane** → existing `onRemove` → `panes.close` (soft-delete: sets
    `closed_at`, which *also stops the pane resurrecting on the next restart*).
  - **Copy diagnostics** → reuse the existing `copyDiagnostics` helper.
- Keyed by `session.id` so a relaunch/reflow gives a clean slate and a recovered
  pane is not stuck on a stale error.
- Net effect: a throwing pane is contained to its own cell; every sibling pane and
  the room survive. "Close pane" lets the operator permanently dismiss the one bad
  pane in a click — which is also the manual loop-break for a deterministic
  render throw.

### Part 2 — Resume backoff (stops the spawn-failure loop · main)

`markResumeFailed` currently writes `status='exited', exit_code=-1` — which is
resume-eligible, so a failed resume is retried every boot. Change a **failed resume
attempt** to land in a state that `listEligibleRows` does **not** match, surfaced to
the renderer as the existing crashed/Relaunch card, so it does not silently
retry-and-fail on a loop.

- Mechanism: `markResumeFailed` writes `status='error'` (with the existing
  exit-code semantics) instead of `exited,-1`. `status='error'` is **not** in the
  resume predicate, and the renderer already renders an `error` session as the
  "Pane crashed" + Relaunch surface (`PaneShell.tsx:255`, `crashed` branch). The
  operator can Relaunch (manual, intentional) instead of an automatic crash loop.
- This is secondary to Part 1 for the operator's specific (renderer-side) loop, but
  it closes a real "reaper keep ⊇ use" sibling bug. **Regression guard:** an
  orphaned-but-never-resumed `running` session (the legitimate force-quit case) must
  still resume — only a session that *actually attempted and failed* to spawn is
  demoted. The janitor's `running`→`exited,-1` path is unchanged; only the
  `markResumeFailed` target changes.

### Part 3 — Main-process safety net (· main)

- Register `process.on('uncaughtException', …)` and
  `process.on('unhandledRejection', …)` early in `electron/main.ts` (before
  `whenReady`).
- Add a `.catch()` to the `app.whenReady().then(...)` boot chain so a boot failure
  shows the existing diagnostic window instead of dying silently.
- Handlers **log** (console + Part 4 persisted file). They do not silently swallow;
  for a fatal boot error the existing `showDiagnosticWindow()` path is reused.

### Part 4 — Persist crash diagnostics (enables the surgical fix · main + renderer)

- `ErrorBoundary.componentDidCatch` sends the error message + stack + component
  stack over IPC to main, which appends a timestamped entry to a diagnostics log
  file under userData (e.g. `logs/renderer-errors.log`, capped/rotated to a small
  size).
- The Part 3 main handlers append to the same log.
- Result: the next time **any** boundary fires, the exact throwing component + line
  is on disk. The surgical fix (Part 4 follow-up) reads the file — no DevTools work
  required from the operator.

## Data flow

- **Render throw** → `PaneErrorBoundary` (per pane) catches → renders pane fallback
  in-cell → `componentDidCatch` → IPC → main appends to `logs/renderer-errors.log`.
  Room + sibling panes unaffected.
- **Failed resume spawn** → per-pane `catch` in `resumeWorkspacePanes` →
  `markResumeFailed` writes `status='error'` → renderer shows crashed/Relaunch card
  → next boot does **not** re-resume it.
- **Main uncaught error** → `process.on` handler → log to file (+ diagnostic window
  if during boot) instead of silent exit.

## Error handling

- All new boundaries/handlers are defensive: failures inside the diagnostics-log
  write are themselves swallowed (best-effort) so logging can never cascade.
- The diagnostics log is size-capped to avoid unbounded growth.

## Testing (TDD — failing test first per part)

1. **Pane isolation** (jsdom): a `renderLeaf` whose `PaneShell` throws renders the
   pane fallback while a sibling pane still renders; the room does not unmount.
2. **Resume backoff** (MockDb / predicate test, per
   `reference_better_sqlite3_electron_abi`): after `markResumeFailed`, the session is
   **not** matched by the `listEligibleRows` predicate; an orphaned `running` session
   still is.
3. **Main handlers**: `uncaughtException` / `unhandledRejection` listeners are
   registered, and the boot chain has a rejection handler (assert via a unit around
   the registration helper).
4. **Diagnostics persistence**: an error payload routed through the IPC handler
   appends a parseable line to the log; oversized logs are trimmed.

Re-gate the **full** `vitest run` (per `feedback_full_suite_catches_mock_breakage`)
plus `tsc -b`; defer e2e to CI.

## Out of scope (wishlist / follow-up)

- The **surgical fix** of the exact throwing component — done once
  `logs/renderer-errors.log` (Part 4) captures the stack.
- Reducing the boot restore avalanche (lazy/throttled multi-workspace resume).
- Browser-tab stale-URL handling (`did-fail-load`) — not implicated in this crash.
- Marking stale `running` sessions differently from `exited,-1` at the janitor level
  (Part 2 addresses the failed-spawn case without it).

## Risk

Touches `CommandRoom.tsx`, `ErrorBoundary.tsx` (renderer), `resume-launcher.ts`,
`electron/main.ts`, + a small IPC channel and main-side log writer. All additive /
defensive; the only behavior change is Part 2's `markResumeFailed` target state,
guarded by a regression test asserting the legitimate orphaned-`running` resume path
is preserved. Low regression risk.
