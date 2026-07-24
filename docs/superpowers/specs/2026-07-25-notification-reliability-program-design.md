# Notification Reliability Remediation Program

**Date:** 2026-07-25

**Status:** approved in operator review

**Audit:** `WISHLIST.md` — “Deep review findings (2026-07-24) — notification system”

## Goal

Make SigmaLink notifications trustworthy: a notification-worthy event is retained according to
its severity, appears in every renderer without startup races, reaches an appropriate visible or
native surface, routes back to the correct workspace and target, and reports delivery failures
honestly.

## Why this is a program

The audit found defects in six independently testable subsystems. Treating them as one patch would
couple database protocol changes to Electron lifecycle behavior, producer semantics, agent
attention heuristics, and UI accessibility. The remediation therefore uses one shared architecture
and six ordered implementation projects.

## Chosen architecture

SQLite in the main process remains the source of truth. Every successful notification mutation
commits a monotonically versioned change set. Renderers keep disposable, paginated projections and
reconcile versioned snapshots with live deltas. Native delivery and the daily digest consume the
committed change set independently; neither can corrupt or block persistence or another consumer.

An append-only event-log rewrite was rejected as disproportionate. Re-fetching an unversioned full
snapshot after every mutation was rejected because it preserves ordering races and makes paging
expensive.

```text
event source
    |
    v
NotificationsManager + one SQLite transaction
    |
    v
versioned NotificationChangeSet
    +--> renderer projections
    +--> native-delivery planner
    +--> daily digest
```

## Shared contracts

```ts
interface NotificationCounts {
  unread: number;
  unreadBySeverity: Record<NotificationSeverity, number>;
}

interface NotificationChangeSet {
  revision: number;
  added: Notification[];
  updated: Notification[];
  removed: string[];
  counts: NotificationCounts;
}

interface NotificationSnapshot {
  revision: number;
  items: Notification[];
  nextCursor: string | null;
  counts: NotificationCounts;
}

interface NotificationTarget {
  workspaceId: string | null;
  roomId?: string;
  sessionId?: string;
  messageId?: string;
  artifactId?: string;
}
```

The existing `payload` column may carry a validated target during the compatibility phase. A later
migration may promote target fields if query requirements justify it; this program does not add
columns merely to mirror TypeScript.

## System invariants

1. Persistence, deduplication, retention, soft-cap handling, summary insertion, counts, and revision
   advancement happen in one transaction.
2. Soft-cap cleanup never deletes unread `error` or `critical` rows.
3. Every inserted row, including a collapse summary, appears in the committed `added` lane.
4. Every mutation that changes notification state advances the revision exactly once and emits one
   post-commit change set. No-op mutations do neither.
5. Renderer snapshots and deltas carry revisions. A renderer never replaces newer state with an
   older snapshot and never silently continues across a revision gap.
6. Badge urgency derives from authoritative severity counts, not from the currently loaded page.
7. Stable cursor pagination makes every retained row reachable.
8. Persistence success is independent from renderer, native, and digest consumer failures.
9. A native attempt is not reported as delivered until Electron confirms its `show` lifecycle
   event. Failed attempts do not consume the delivery throttle.
10. Routing activates the notification's workspace before opening its destination. A notification
    is marked read only after routing succeeds.
11. Native suppression requires a relevant visible surface, not merely any focused SigmaLink
    window.
12. Agent attention requiring operator action is replayable and uses the same authoritative
    notification path as other alerts.
13. Notification reporting inside cleanup and recovery paths is best-effort and cannot mask the
    original failure.

## Runtime synchronization

Renderer startup uses subscribe-before-snapshot:

1. Register the `notifications:changed` listener.
2. Buffer deltas while hydration is pending.
3. Request the first snapshot.
4. Install the snapshot at its revision.
5. Apply buffered deltas with higher consecutive revisions.
6. Discard duplicates and older deltas.
7. On a gap or malformed envelope, clear the buffer and request a fresh snapshot with bounded
   exponential backoff.

All windows receive state changes. Only the window selected by the delivery planner owns in-app
toast/tone side effects. One window throwing during broadcast cannot starve later windows or other
delivery consumers.

## Delivery and routing

The planner chooses a presentation using the structured target:

- Prefer a focused, visible notification surface for the target workspace.
- Scoped/detached windows gain a durable notification surface.
- An unrelated focused window does not suppress native delivery.
- If no relevant surface is visible, apply native eligibility policy.
- Critical notifications retain their severity bypass behavior, subject to explicit operator
  settings and platform support.

Native clicks find or create an appropriate window, activate the workspace, open the room or pane,
dispatch through a registered destination handler, and mark read only after successful routing.

## Agent attention

Question and turn-finished attention stops being a transient renderer-only event. The detector
creates structured, deduplicated notification records keyed by session and attention generation.
The notification projection drives the bell, glow, toast/tone, replay, and native policy. Focusing
or interacting with the target pane acknowledges the attention state. Minimized panes are not
treated as visibly attended. Claude and Codex BEL/idle behavior must be covered by integration
fixtures before rollout; the implementation must not claim a heuristic is an exact semantic event.

## Producer and failure semantics

Producers normalize into a typed candidate containing source, kind, severity, target, dedup key,
and—when relevant—failure phase/classification. Validation, approval-required, frozen-control, and
operator-denied results are not critical execution failures. Execution and cleanup failures derive
severity from impact rather than tool name alone.

Canonical swarm `OPERATOR` broadcasts become a supported producer. Shell-exit deduplication is
scoped to a process/session generation and resets on relaunch. Cleanup paths use a best-effort
notification adapter.

## UX consistency

- Persistent duplicates update one toast and surface `dupCount` rather than stacking copies.
- Daily digest accounting includes duplicate counts and uses a local-date/time-zone idempotency
  key.
- Failed optimistic renderer mutations roll back or refetch authoritative state.
- The existing working live daily-summary rearm path remains intact and receives regression tests.
- Bell, dropdown, actions, and destination links provide keyboard navigation, focus restoration,
  accessible names, and screen-reader announcements.

## Ordered workstreams

1. **Notification state consistency:** atomic retention, complete deltas, revisions, snapshots,
   cursor pagination, authoritative counts, renderer hydration recovery.
2. **Window delivery and destination routing:** isolated fan-out, relevant-window selection, scoped
   surfaces, structured cross-workspace navigation.
3. **Native delivery lifecycle and packaging:** async outcomes, throttle correctness, click routing,
   installed icon, platform smoke tests.
4. **Producer semantics and failure isolation:** tool phases, canonical swarm events, generation
   dedup, best-effort recovery notifications.
5. **Durable agent attention:** persisted/replayed attention, acknowledgement, zero-window and
   minimized behavior, Claude/Codex fixtures.
6. **Digest, settings, toast, and accessibility:** duplicate accounting, once-per-day digest,
   mutation recovery, toast coalescing, assistive interaction.

Workstreams 2–6 depend on the change-set contract from workstream 1. Workstreams 2–4 may proceed in
parallel after that contract lands. Workstream 5 depends on both state consistency and delivery
routing. Workstream 6 integrates last so it tests the final contracts instead of preserving legacy
assumptions.

## Rollout and compatibility

- Migrations are forward-only and idempotent under the existing migration runner.
- RPC changes are introduced additively (`snapshot`/`page`) before legacy `list` and
  `unreadCount` are removed.
- Renderer parsing rejects malformed or unversioned new envelopes; compatibility adapters are
  temporary and covered by explicit removal tasks.
- Native and attention behavior changes are guarded by existing preferences where applicable; no
  new remote service or telemetry dependency is introduced.
- Each workstream has focused regression tests, TypeScript verification, and a fresh relevant-suite
  gate. Electron-dependent tests remain mandatory before release even when a local worktree lacks
  an installed Electron binary.

## Non-goals

- Replacing SQLite with an event store.
- Guaranteeing that an operating system visibly presented a banner after Electron's `show` event.
- Syncing notification state across machines.
- Inferring perfect question-vs-completion semantics from arbitrary terminal output.
- Rewriting working daily-summary live rearming.

## Completion definition

The program completes only when each confirmed audit finding is linked to a passing regression
test or an explicitly approved non-code operational gate, all six implementation plans have been
executed, cross-window/native platform smoke checks are recorded, and the WISHLIST audit ledger is
updated with disposition and evidence.
