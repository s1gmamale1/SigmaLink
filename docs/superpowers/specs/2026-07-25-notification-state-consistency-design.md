# Notification State Consistency Design

**Date:** 2026-07-25

**Status:** approved as workstream 1 of the notification reliability program

**Parent:** `docs/superpowers/specs/2026-07-25-notification-reliability-program-design.md`

## Scope

This workstream fixes the authoritative data path before any delivery policy is changed:

- severity-safe soft-cap collapse;
- collapse summaries included in live change sets;
- atomic mutations and monotonic revisions;
- one snapshot/count response instead of two racy requests;
- stable cursor pagination;
- subscribe-before-snapshot renderer hydration with gap recovery;
- authoritative unread severity counts for the bell;
- every retained row reachable from the dropdown.

It does not change native eligibility, click routing, producer classification, attention semantics,
digest scheduling, or accessibility beyond what the new paging controls require.

## Storage model

Migration `0043_notification_state_revision` creates a singleton metadata table:

```sql
CREATE TABLE IF NOT EXISTS notification_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT OR IGNORE INTO notification_state(singleton, revision) VALUES (1, 0);
```

The revision lives in the same SQLite database and transaction as notification mutations. It is not
process-local because renderer recovery and future restarts require a stable ordering token.

## Mutation contract

`NotificationsManager` performs each changing public method inside `better-sqlite3`'s synchronous
transaction wrapper. Internal helpers receive the active database handle and never emit. The outer
method:

1. performs the mutation and retention work;
2. builds complete `added`, `updated`, and `removed` lanes;
3. reads severity counts;
4. increments and reads the revision once;
5. commits;
6. emits the committed change set outside the transaction.

If any SQL step throws, SQLite rolls back all row and revision changes and no delta is emitted.
Emission remains best-effort after commit; a renderer exception cannot undo durable state.

No-op `markRead`, `markUnread`, `dismiss`, `clearRead`, and GC calls do not advance the revision or
emit.

## Soft-cap policy

When unread rows for `(workspace_id, kind)` exceed 200:

- only unread `info` and `warn` rows are eligible victims;
- choose the oldest 50 eligible rows, or fewer if fewer are eligible;
- never delete unread `error` or `critical` rows;
- if no eligible victims exist, allow the bucket to exceed the soft cap;
- when victims exist, insert one `info` summary row recording the number collapsed;
- return victim IDs and the full summary row to the outer mutation;
- include both the triggering/absorbing row and summary in `changeSet.added`.

The global hard-cap behavior remains severity-safe and may soft-break when only protected rows
remain. This is intentional: data safety outranks a strict visual cap.

## Counts

`NotificationCounts` is computed authoritatively from unread rows:

```ts
{
  unread: number;
  unreadBySeverity: {
    info: number;
    warn: number;
    error: number;
    critical: number;
  };
}
```

The bell uses these counts for badge color and pulse. Loaded pages are presentation data only and
must not be used to infer global urgency.

## Snapshot and paging API

New RPC methods:

```ts
notifications.snapshot({ limit?, workspaceId?, severities? })
  -> NotificationSnapshot

notifications.page({ cursor, limit?, workspaceId?, severities? })
  -> NotificationPage
```

The first snapshot reads revision, counts, and the newest page in one deferred SQLite transaction.
The cursor is an opaque base64url encoding of `{createdAt,id}`. Page queries use:

```sql
WHERE (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT ?
```

Fetch `limit + 1` rows to determine `nextCursor`. Cursor decoding validates shape and safe integer
ranges; malformed cursors are rejected by the RPC boundary. Filters are repeated on every page and
are not encoded into the cursor, so the renderer resets paging whenever a filter changes.

Legacy `list` and `unreadCount` remain temporarily for non-renderer callers and are removed only
after repository-wide search proves no consumer remains.

## Renderer reconciliation

App state adds:

```ts
notificationRevision: number | null;
notificationNextCursor: string | null;
notificationHydration: 'idle' | 'loading' | 'ready' | 'retrying';
notificationCounts: NotificationCounts;
```

The live event hook installs the event listener before requesting a snapshot. While loading, it
buffers validated change sets. After snapshot installation it sorts buffered sets by revision,
discards `revision <= snapshot.revision`, and applies consecutive later revisions.

If a live change set arrives at `currentRevision + 1`, apply it. If it is older or equal, ignore it.
If it is greater than `currentRevision + 1`, mark the projection stale and schedule a fresh
snapshot. Failed snapshot calls retry while the component is mounted with bounded delays (250 ms,
1 s, 4 s, then 10 s maximum). Only one retry timer/request may exist at a time.

Loading another page appends unseen IDs without changing the revision. Live updates can delete or
update already loaded older rows; keyset ordering prevents new rows from shifting page boundaries.

## Dropdown behavior

The dropdown requests the next page when the operator activates a visible “Load older” control;
automatic intersection loading may be added later, but reachability must not depend on observer
timing. The control exposes loading, retry, and end-of-history states accessibly. Applying a filter
starts a new snapshot/page sequence for that filter.

## Error handling

- A failed mutation throws through RPC, leaves SQLite/revision unchanged, and emits no change set.
- An emit failure is logged/isolated after commit and recovery occurs through a later snapshot.
- Malformed deltas and cursors are rejected, not coerced to revision/count zero.
- Hydration failures are observable and retryable rather than silently abandoned.
- Optimistic mutation rollback belongs to workstream 6; this workstream supplies the authoritative
  snapshot/change-set mechanism it will call.

## Tests and acceptance

Required regression coverage:

1. Oldest protected unread rows survive a soft-cap collapse.
2. The inserted summary appears in `changeSet.added`.
3. A forced SQL failure rolls back insert/collapse/revision and emits nothing.
4. Revisions advance exactly once per changing mutation and never on no-op.
5. Snapshot revision, counts, and first page are internally consistent.
6. Equal timestamps paginate deterministically without gaps or duplicates.
7. A delta received during hydration survives an older snapshot.
8. A revision gap triggers one refetch and retry failures do not abandon the session.
9. A critical unread row outside the first page still produces critical badge state.
10. Loading older pages eventually exposes every retained row.

The focused manager, migration, RPC, reducer, live-hook, bell, and dropdown tests plus `tsc -b`
must pass. The broader notification suite is required before the workstream is marked complete.
