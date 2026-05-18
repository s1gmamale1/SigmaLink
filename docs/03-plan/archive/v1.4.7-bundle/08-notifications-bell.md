# Packet 08 — Notifications system + top-right bell

> **Effort**: L (~3-4d). **Tier**: v1.3 feature. **Delegate**: Opus 4.7 (architecture-critical).
> **Blocks**: nothing. **Blocked by**: nothing.

## Problem

The top-right Breadcrumb has a settings gear but no notification bell. The V3 BridgeMind mockup showed a bell next to the gear. SigmaLink doesn't have one because no notification source exists yet.

This is a long-deferred wishlist item (originally from v1.1.4 deferred → v1.3 → v1.4+ → still open). Effort estimate: L (~3-4 days for source taxonomy + dropdown UI + persistence + GC).

## Notification source taxonomy (decide before code)

Three sources for v1 of this feature:

### Source 1 — PTY exits (existing event)

Surface: `pty:exit` event in `app/src/main/core/pty/registry.ts`. Already wired to renderer via `useLiveEvents.ts:27`.

Notification: `{kind: 'pty-exit', sessionId, providerId, exitCode, cwd}`. Rendered as: `"<provider> pane exited with code <code> in <workspace>"`. Severity: `info` (exit 0) or `warn` (non-zero).

### Source 2 — Swarm broadcasts (existing event)

Surface: `swarm:message` event. Already wired to renderer via `useLiveEvents.ts:39` for the side-chat.

Notification: `{kind: 'swarm-message', swarmId, agentId, summary}`. Rendered as: `"<agent> posted to <swarm>"`. Severity: `info`. NOT every swarm message becomes a notification — gate on `message.broadcastToSidebar === true` (new optional flag on swarm-message envelope).

### Source 3 — Sigma Assistant tool errors (NEW event)

Surface: `runClaudeCliTurn.ts` catch block. When a tool invocation throws (e.g. `launch_pane` fails because workspace closed mid-turn), emit `assistant:tool-error` IPC event.

Notification: `{kind: 'tool-error', toolName, error, conversationId}`. Rendered as: `"Sigma's <tool> call failed: <error>"`. Severity: `error`.

## Schema

```sql
-- migration 0017_notifications.sql (NEW)
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,                  -- ulid
  workspace_id TEXT,                    -- nullable (global notifications)
  kind TEXT NOT NULL,                   -- 'pty-exit' | 'swarm-message' | 'tool-error'
  severity TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
  title TEXT NOT NULL,
  body TEXT,                            -- nullable details
  payload TEXT,                         -- nullable JSON (kind-specific)
  created_at INTEGER NOT NULL,
  read_at INTEGER,                       -- nullable (read marker)
  source_event TEXT                     -- 'pty:exit' / 'swarm:message' / 'assistant:tool-error'
);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at) WHERE read_at IS NULL;
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Main process                                                 │
│                                                              │
│  pty:exit          →  ┐                                     │
│  swarm:message     →  ├─→ NotificationManager.add()         │
│  assistant:tool-error→  ┘     │                              │
│                              ▼                              │
│                       ┌──────────────────┐                  │
│                       │ notifications DB │                  │
│                       └──────────────────┘                  │
│                              │                              │
│                              ▼                              │
│                       'notifications:changed' IPC          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Renderer                                                     │
│                                                              │
│  useLiveEvents listens to 'notifications:changed'           │
│    → dispatches SET_NOTIFICATIONS                            │
│                                                              │
│  Breadcrumb.tsx renders <NotificationBell />                │
│    - Badge: count of unread                                  │
│    - Click: opens <NotificationDropdown />                   │
│                                                              │
│  NotificationDropdown.tsx:                                   │
│    - Lists last 50 notifications, unread first              │
│    - Per-item: title, body, severity icon, "x" to dismiss   │
│    - "Mark all read" button                                  │
│    - "Clear read" button                                     │
└──────────────────────────────────────────────────────────────┘
```

## Files to touch

### Main process
- `app/src/main/core/db/migrations/0017_notifications.ts` — NEW
- `app/src/main/core/db/schema.ts` — register notifications table
- `app/src/main/core/db/migrate.ts` — register migration
- `app/src/main/core/notifications/manager.ts` — NEW (add, list, markRead, gc)
- `app/src/main/core/notifications/manager.test.ts` — NEW
- `app/src/main/core/notifications/sources/pty-exit.ts` — NEW (subscribe to PtyRegistry exits, call manager.add)
- `app/src/main/core/notifications/sources/swarm-message.ts` — NEW (gate on broadcastToSidebar)
- `app/src/main/core/notifications/sources/tool-error.ts` — NEW (subscribe to assistant tool errors)
- `app/src/main/core/notifications/gc.ts` — NEW (boot-time GC: drop read >30d old)
- `app/src/main/rpc-router.ts` — register `notifications.list`, `notifications.markRead`, `notifications.markAllRead`, `notifications.clearRead`

### Renderer
- `app/src/renderer/features/notifications/NotificationBell.tsx` — NEW
- `app/src/renderer/features/notifications/NotificationDropdown.tsx` — NEW
- `app/src/renderer/features/notifications/NotificationItem.tsx` — NEW
- `app/src/renderer/features/breadcrumb/Breadcrumb.tsx` — mount bell next to settings gear
- `app/src/renderer/app/state-hooks/use-live-events.ts` — subscribe to `notifications:changed`
- `app/src/renderer/app/state.reducer.ts` — `SET_NOTIFICATIONS`, `MARK_NOTIFICATION_READ` actions
- `app/src/renderer/app/state.types.ts` — `Notification` type + action types
- Renderer tests for the new components

### Shared
- `app/src/shared/types.ts` — `Notification` interface
- `app/src/shared/rpc-channels.ts` — register notification channels
- `app/src/shared/router-shape.ts` — add `notifications` controller shape

## UX details

- Bell badge: small red dot if `unreadCount > 0`. Number badge if `unreadCount > 0 && unreadCount < 10`; "9+" if more.
- Dropdown: max-height 480px, virtual-scroll if needed (use existing `react-window` if already a dep, else simple overflow-y).
- Per-notification age: relative ("2m ago", "1h ago", "yesterday").
- Click on notification body: navigate to the relevant context (PTY exit → that pane's history; swarm-message → that swarm; tool-error → that conversation).

## Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false
pnpm exec vitest run src/main/core/notifications/   # NEW
pnpm exec vitest run src/renderer/features/notifications/   # NEW
pnpm exec vitest run                                  # baseline + new
pnpm exec eslint .                                    # 0 errors
```

Manual smoke:
1. Open workspace, spawn a shell pane, type `exit`. Confirm pty-exit notification appears in bell.
2. Spawn a swarm with two agents that broadcast. Confirm swarm-message notifications appear.
3. Trigger a tool error (start a Sigma turn, close the workspace mid-call). Confirm tool-error notification appears.
4. Mark one read → badge count decrements. Mark all read → badge disappears. Clear read → list collapses.
5. Quit + relaunch → unread notifications persist.

## Risk

- Notification flood: a swarm with N agents broadcasting frequently could create N notifications/sec. Gate aggressively — only `broadcastToSidebar === true` enters the bell. Add a debounce in the manager: if 10+ notifications of the same `kind` from the same `workspace_id` arrive within 5 seconds, collapse to one summary notification.
- Migration safety: 0017 migration must be idempotent (CREATE TABLE IF NOT EXISTS pattern from migration 0014/0015).
- IPC bandwidth: don't push every notification individually via `notifications:changed` — push the FULL list (last 50 unread) on every change. Renderer reconciles via reducer.

## Reporting back

PR title: `feat(v1.4.7): notifications + top-right bell — pty/swarm/tool-error sources`. Include screenshot of bell+dropdown + the migration 0017 SQL.
