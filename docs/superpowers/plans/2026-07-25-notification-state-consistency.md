# Notification State Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make notification persistence and renderer synchronization atomic, versioned, severity-safe, and fully pageable so no committed alert is silently deleted, hidden, or overwritten by startup races.

**Architecture:** Keep SQLite and `NotificationsManager` authoritative. Every changing mutation runs in one SQLite transaction, advances a persisted revision, and emits one complete post-commit change set with authoritative severity counts. Renderers subscribe before fetching a versioned snapshot, reconcile buffered deltas, recover revision gaps, and page older rows with a stable keyset cursor.

**Tech Stack:** TypeScript, Electron RPC, better-sqlite3, React reducer/hooks, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-25-notification-state-consistency-design.md`

## Global Constraints

- Work in `/Users/aisigma/projects/SigmaLink-wt-notification-audit-2026-07-24` on branch
  `audit/notification-system-2026-07-24`; never implement on `main`.
- Commands below assume cwd `app/` unless stated otherwise.
- Follow strict red-green-refactor: add one regression, run it and confirm the expected failure,
  write the minimum production change, then rerun focused and adjacent tests.
- Do not delete or overwrite the audit ledger in `WISHLIST.md`.
- Preserve unread `error`/`critical` rows even when caps soft-break.
- Emit only after a successful database commit. A failed renderer emit must never roll back state.
- Keep legacy RPC methods until repository-wide consumer migration is proven.
- Do not report Electron-dependent verification as passing when the local Electron binary is absent.

---

## Task 1: Make soft-cap collapse severity-safe and delta-complete

**Files:**
- Modify: `app/src/main/core/notifications/manager.test.ts`
- Modify: `app/src/main/core/notifications/manager.ts`

- [x] **Step 1: Add a failing protected-severity regression**

  Seed the oldest 50 rows as alternating `error`/`critical`, seed at least 201 later `info` rows
  in the same workspace/kind, trigger collapse, and assert every protected ID remains while the
  oldest eligible info rows are removed.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts -t "preserves protected unread rows during soft-cap collapse"`

  Expected: FAIL because the current victim query has no severity predicate and removes the oldest
  protected rows.

- [x] **Step 3: Implement the minimum severity filter**

  Add `severity IN ('info', 'warn')` to both workspace and global victim queries. Update the focused
  test database parser to model that predicate.

- [x] **Step 4: Verify GREEN**

  Rerun the focused test. Expected: PASS.

- [x] **Step 5: Add a failing summary-delta regression**

  Trigger collapse and assert `emitted[0].added` contains both the triggering row and the generated
  `<kind>-summary` row, while `removed` contains the victim IDs.

- [x] **Step 6: Verify RED**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts -t "emits the soft-cap summary in the added lane"`

  Expected: FAIL because `softCapCollapse()` returns only victim IDs.

- [x] **Step 7: Return the complete collapse result**

  Change the private helper to return `{ removed: string[]; added: Notification[] }`. Construct the
  summary row once, insert it, convert it with `rowToNotification`, and append it to the outer
  `added` lane. Empty/no-eligible collapse returns empty lanes.

- [x] **Step 8: Verify task**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts`

  Expected: all manager tests pass.

- [x] **Step 9: Commit checkpoint**

  ```bash
  git add app/src/main/core/notifications/manager.ts app/src/main/core/notifications/manager.test.ts
  git commit -m "fix(notifications): preserve protected rows during collapse"
  ```

## Task 2: Persist the notification revision

**Files:**
- Create: `app/src/main/core/db/migrations/0043_notification_state_revision.ts`
- Create: `app/src/main/core/db/migrations/0043_notification_state_revision.test.ts`
- Modify: `app/src/main/core/db/migrate.ts`
- Test: `app/src/main/core/db/__tests__/migrate.spec.ts`

- [x] **Step 1: Write migration tests first**

  Assert that `up()` creates the singleton `notification_state` table, seeds `(1,0)`, preserves an
  existing revision when rerun, and contains no self-managed transaction statements.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/main/core/db/migrations/0043_notification_state_revision.test.ts src/main/core/db/__tests__/migrate.spec.ts`

  Expected: FAIL because migration 0043 does not exist or is not registered.

- [x] **Step 3: Implement and register the idempotent migration**

  Follow the existing forward-only migration shape. Add `mig0043` to `ALL_MIGRATIONS` exactly once
  and keep lexical order. Do not add `BEGIN`, `COMMIT`, or `ROLLBACK` to the migration.

- [x] **Step 4: Verify GREEN**

  Rerun the migration tests. Expected: PASS.

- [x] **Step 5: Commit checkpoint**

  ```bash
  git add app/src/main/core/db/migrations/0043_notification_state_revision.ts \
    app/src/main/core/db/migrations/0043_notification_state_revision.test.ts \
    app/src/main/core/db/migrate.ts
  git commit -m "feat(notifications): persist state revision"
  ```

## Task 3: Introduce versioned shared contracts and authoritative counts

**Files:**
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/main/core/notifications/manager.ts`
- Modify: `app/src/main/core/notifications/manager.test.ts`

- [x] **Step 1: Add failing count and revision tests**

  Add tests asserting a change set contains all four unread severity counts and that consecutive
  changing mutations advance revisions by exactly one. Add no-op tests for already-read/missing
  IDs.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts -t "revision|severity counts|no-op"`

  Expected: FAIL because the delta only exposes `unreadCount` and no revision.

- [x] **Step 3: Add shared types**

  Define `NotificationCounts`, `NotificationChangeSet`, `NotificationCursor`,
  `NotificationSnapshot`, and `NotificationPage`. Replace optional `updated` with a required array
  in the new change-set type. Keep `NotificationsDelta` as a temporary deprecated alias only if a
  staged compiler migration requires it.

- [x] **Step 4: Add manager primitives**

  Add private database-handle helpers to read counts, read revision, and increment revision using
  `UPDATE notification_state SET revision = revision + 1 ... RETURNING revision`. Update the test
  database fake to model revision and grouped severity counts.

- [x] **Step 5: Emit the new envelope for existing mutations**

  Ensure all changing methods include required lanes, revision, and counts. No-op methods emit
  nothing and leave the revision unchanged.

- [x] **Step 6: Verify GREEN and typecheck**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts`

  Run:
  `pnpm exec tsc -b --pretty false`

  Expected: PASS and exit 0.

- [x] **Step 7: Commit checkpoint**

  ```bash
  git add app/src/shared/types.ts app/src/main/core/notifications/manager.ts \
    app/src/main/core/notifications/manager.test.ts
  git commit -m "feat(notifications): version change sets and severity counts"
  ```

## Task 4: Make each notification mutation atomic

**Files:**
- Modify: `app/src/main/core/notifications/manager.ts`
- Modify: `app/src/main/core/notifications/manager.test.ts`

- [x] **Step 1: Add failing rollback tests**

  Extend the focused test database with a transaction snapshot/rollback model and an injected
  failure point after collapse but before revision advancement. Assert the triggering insert,
  victims, summary, and revision all roll back and no change set emits.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts -t "rolls back the complete mutation"`

  Expected: FAIL because current SQL calls are not wrapped in one transaction.

- [x] **Step 3: Refactor mutation internals**

  Build each public changing method around a synchronous `db.transaction()` closure that returns
  either a complete change set or `null`. Pass `db` to helpers rather than calling `getRawDb()`
  repeatedly. Emit only after the closure returns successfully.

- [x] **Step 4: Add mutation matrix tests**

  Cover `add`, dedup absorb, `markRead`, `markAllRead`, `markUnread`, `dismiss`, `clearRead`, and GC.
  Assert one revision/one event for state changes and zero for no-ops.

- [x] **Step 5: Verify task**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts`

  Expected: PASS.

- [x] **Step 6: Commit checkpoint**

  ```bash
  git add app/src/main/core/notifications/manager.ts app/src/main/core/notifications/manager.test.ts
  git commit -m "refactor(notifications): commit mutations atomically"
  ```

## Task 5: Add atomic snapshots and stable cursor pages

**Files:**
- Modify: `app/src/main/core/notifications/manager.ts`
- Modify: `app/src/main/core/notifications/manager.test.ts`

- [x] **Step 1: Add failing cursor tests**

  Seed rows with equal and unequal timestamps. Assert two pages contain every ID once in deterministic
  `(createdAt,id)` descending order. Assert malformed cursors throw a validation error.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/main/core/notifications/manager.test.ts -t "cursor|snapshot"`

  Expected: FAIL because only offset-based `list()` exists.

- [x] **Step 3: Implement opaque cursor helpers and page query**

  Add private encode/decode helpers, fetch `limit + 1`, return `nextCursor`, and preserve workspace
  and severity filters. Use `id DESC` as the deterministic tie-breaker.

- [x] **Step 4: Implement `snapshot()`**

  Read revision, counts, and first page in one deferred read transaction and return one
  `NotificationSnapshot`.

- [x] **Step 5: Verify task**

  Run manager tests and `pnpm exec tsc -b --pretty false`. Expected: PASS/exit 0.

- [x] **Step 6: Commit checkpoint**

  ```bash
  git add app/src/main/core/notifications/manager.ts app/src/main/core/notifications/manager.test.ts
  git commit -m "feat(notifications): add atomic snapshots and cursor paging"
  ```

## Task 6: Expose snapshot and page RPC methods

**Files:**
- Modify: `app/src/shared/rpc-channels.ts`
- Modify: `app/src/shared/router-shape.ts`
- Modify: `app/src/main/rpc-router.ts`
- Modify: `app/src/main/rpc-router.wiring.test.ts`

- [x] **Step 1: Add failing RPC wiring tests**

  Assert `notifications.snapshot` and `notifications.page` are registered, pass validated options to
  the manager, and return the manager response unchanged. Assert an invalid cursor is rejected.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/main/rpc-router.wiring.test.ts -t "notifications snapshot|notifications page"`

  Expected: FAIL because the methods/channels do not exist.

- [x] **Step 3: Add typed channels and controller methods**

  Extend the channel allowlist and `AppRouter` shape. Wire the controller to `snapshot()`/`page()`.
  Keep `list`/`unreadCount` available during renderer migration.

- [x] **Step 4: Verify task**

  Run the wiring test and `pnpm exec tsc -b --pretty false`. Expected: PASS/exit 0.

- [x] **Step 5: Commit checkpoint**

  ```bash
  git add app/src/shared/rpc-channels.ts app/src/shared/router-shape.ts \
    app/src/main/rpc-router.ts app/src/main/rpc-router.wiring.test.ts
  git commit -m "feat(notifications): expose snapshot and page RPC"
  ```

## Task 7: Reconcile snapshots and live revisions safely

**Files:**
- Modify: `app/src/renderer/app/state.types.ts`
- Modify: `app/src/renderer/app/state.reducer.ts`
- Modify: `app/src/renderer/app/state.reducer.test.ts`
- Modify: `app/src/renderer/app/state-hooks/use-live-events.ts`
- Modify: `app/src/renderer/app/state-hooks/use-live-events.test.ts`

- [x] **Step 1: Add reducer tests first**

  Assert stale snapshots cannot replace a newer revision, consecutive deltas apply, duplicate/old
  revisions are ignored, and gaps put state into a stale/retry state.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/renderer/app/state.reducer.test.ts -t "notification revision|stale snapshot|revision gap"`

  Expected: FAIL because renderer state has no revision.

- [x] **Step 3: Add state and reducer actions**

  Introduce snapshot-install, change-set-apply, page-append, hydration-status, and reset actions.
  Remove the reducer's assumption that missing/invalid counts mean zero.

- [x] **Step 4: Add failing hook race tests**

  Defer the snapshot promise, emit a newer live change set, resolve the older snapshot, and assert
  the live row remains. Add a revision-gap test and fake-timer retry/backoff test.

- [x] **Step 5: Verify RED**

  Run:
  `pnpm exec vitest run src/renderer/app/state-hooks/use-live-events.test.ts -t "buffers notification changes during hydration|refetches a notification revision gap"`

  Expected: FAIL under the current fetch-before-safe-reconciliation behavior.

- [x] **Step 6: Implement subscribe-before-snapshot**

  Register the listener in the same effect before starting `snapshot()`, buffer validated envelopes
  while loading, apply only consecutive revisions, and schedule a single bounded retry on failure
  or gaps. Cancel requests/timers on unmount.

- [x] **Step 7: Verify task**

  Run both focused renderer tests and `pnpm exec tsc -b --pretty false`. Expected: PASS/exit 0.

- [x] **Step 8: Commit checkpoint**

  ```bash
  git add app/src/renderer/app/state.types.ts app/src/renderer/app/state.reducer.ts \
    app/src/renderer/app/state.reducer.test.ts \
    app/src/renderer/app/state-hooks/use-live-events.ts \
    app/src/renderer/app/state-hooks/use-live-events.test.ts
  git commit -m "fix(notifications): reconcile hydration with live revisions"
  ```

## Task 8: Use authoritative urgency and expose all history

**Files:**
- Modify: `app/src/renderer/features/notifications/NotificationBell.tsx`
- Modify: `app/src/renderer/features/notifications/NotificationBell.test.tsx`
- Modify: `app/src/renderer/features/notifications/NotificationDropdown.tsx`
- Modify: `app/src/renderer/features/notifications/NotificationDropdown.test.tsx`

- [x] **Step 1: Add the off-page critical regression**

  Render a state whose first page contains only info rows but whose authoritative counts contain an
  unread critical. Assert the badge is critical and the bell uses critical pulse/static classes.

- [x] **Step 2: Verify RED**

  Run:
  `pnpm exec vitest run src/renderer/features/notifications/NotificationBell.test.tsx -t "uses authoritative off-page severity counts"`

  Expected: FAIL because severity is derived from loaded rows.

- [x] **Step 3: Drive the bell from `notificationCounts`**

  Keep row inspection out of urgency calculation. Preserve the existing label/color helper API or
  update its tests explicitly.

- [x] **Step 4: Add failing paging component tests**

  Mock `notifications.page`, activate “Load older,” and assert unique append, next-cursor update,
  retry state after failure, and end-of-history state.

- [x] **Step 5: Verify RED**

  Run:
  `pnpm exec vitest run src/renderer/features/notifications/NotificationDropdown.test.tsx -t "loads older notification pages"`

  Expected: FAIL because the dropdown never requests another page.

- [x] **Step 6: Implement the explicit paging control**

  Add accessible loading/retry/end states. Reset paging when a server-side filter changes; until
  filter RPC migration is complete, keep local grouping/filter behavior over loaded pages and
  document the staged limitation in the component test.

- [x] **Step 7: Verify task**

  Run both component tests and `pnpm exec tsc -b --pretty false`. Expected: PASS/exit 0.

- [x] **Step 8: Commit checkpoint**

  ```bash
  git add app/src/renderer/features/notifications/NotificationBell.tsx \
    app/src/renderer/features/notifications/NotificationBell.test.tsx \
    app/src/renderer/features/notifications/NotificationDropdown.tsx \
    app/src/renderer/features/notifications/NotificationDropdown.test.tsx
  git commit -m "feat(notifications): expose authoritative urgency and history"
  ```

## Task 9: Remove compatibility paths and verify the workstream

**Files:**
- Modify as needed after `rg`: `app/src/shared/rpc-channels.ts`,
  `app/src/shared/router-shape.ts`, `app/src/main/rpc-router.ts`
- Modify: `WISHLIST.md`

- [x] **Step 1: Prove legacy consumer status**

  Run:
  `rg -n "notifications\.(list|unreadCount)" app/src --glob '*.{ts,tsx}'`

  Remove the methods only if every consumer has migrated. Otherwise retain them with an explicit
  follow-up reference; do not guess.

- [x] **Step 2: Run the focused workstream gate**

  ```bash
  cd app
  pnpm exec vitest run \
    src/main/core/notifications/manager.test.ts \
    src/main/core/db/migrations/0043_notification_state_revision.test.ts \
    src/main/core/db/__tests__/migrate.spec.ts \
    src/main/rpc-router.wiring.test.ts \
    src/renderer/app/state.reducer.test.ts \
    src/renderer/app/state-hooks/use-live-events.test.ts \
    src/renderer/features/notifications/NotificationBell.test.tsx \
    src/renderer/features/notifications/NotificationDropdown.test.tsx
  pnpm exec tsc -b --pretty false
  ```

  Expected: all selected tests pass and TypeScript exits 0.

- [x] **Step 3: Run the broader pure notification gate**

  ```bash
  pnpm exec vitest run \
    src/main/core/notifications \
    src/main/core/pty/attention-detector.test.ts \
    src/main/core/db/migrations/0018_notifications.test.ts \
    src/main/core/db/migrations/0038_os_notify_default_on.test.ts \
    src/main/rpc-router.wiring.test.ts \
    src/shared/notification-prefs.test.ts \
    src/renderer/app/state-hooks/use-live-events.test.ts \
    src/renderer/app/state.reducer.test.ts \
    src/renderer/features/notifications \
    src/renderer/features/settings/NotificationsSettings.test.tsx \
    src/renderer/lib/sounds.test.ts
  ```

  Expected: zero failures. Record counts, exit codes, and any environment-only exclusions.

- [x] **Step 4: Update the audit ledger**

  Add a dated implementation subsection under the notification audit with each fixed finding,
  regression-test name, verification command/result, and remaining Electron/platform gate. Do not
  erase the original evidence.

- [x] **Step 5: Final checkpoint commit**

  ```bash
  git add WISHLIST.md docs/superpowers/specs/2026-07-25-notification-state-consistency-design.md \
    docs/superpowers/plans/2026-07-25-notification-state-consistency.md
  git commit -m "docs(notifications): record state-consistency verification"
  ```

## Execution handoff

After this workstream is verified, write and execute the remaining focused plans in dependency
order: window delivery/routing, native lifecycle/packaging, producer semantics, durable attention,
then UX/digest/accessibility. Do not start workstream 5 until workstreams 1 and 2 have landed.
