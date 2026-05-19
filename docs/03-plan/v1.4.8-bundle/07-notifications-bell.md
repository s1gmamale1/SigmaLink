# Packet 07 — Notifications system + top-right bell (v1.4.8 review)

> **Status**: REVIEWED + TAXONOMY LOCKED. Ready to delegate.
> **Effort**: L (~3-4d). **Tier**: long-deferred (v1.1.4 → v1.3 → v1.4.7-archive → v1.4.8).
> **Delegate**: Opus 4.7 (architecture-critical, irreversible schema choice).
> **Blocks**: nothing. **Blocked by**: nothing.
> **Migration ceiling**: schema is at **0017**. This packet adds **0018_notifications**.
> **Source brief**: `docs/03-plan/archive/v1.4.7-bundle/08-notifications-bell.md`.

---

## 1. Original brief summary (for context)

The archived v1.4.7 brief proposed:

- **Three sources**: PTY exits, swarm broadcasts (gated on `broadcastToSidebar`), Sigma Assistant tool errors.
- **Severity**: `info` / `warn` / `error` (three levels).
- **Schema**: new `notifications` table with `read_at` per row, full payload column, indexes on `(workspace_id, created_at DESC)` and `WHERE read_at IS NULL`.
- **Migration**: `0017_notifications` (now `0018` — see ceiling note above).
- **Renderer**: bell next to settings gear → dropdown of last 50 notifications, mark-read / mark-all-read / clear-read controls.
- **GC**: boot-time drop of read notifications older than 30 days.
- **Risk hedge**: debounce 10 same-kind from same workspace within 5s → collapse to summary.

The original was a strong skeleton but **left six design decisions unforced**. The reviewer (this doc) locks D1–D6 with rationale so the implementing agent does not re-litigate them mid-PR.

---

## 2. v1.4.8 review — locked taxonomy

### D1 — Severity scale: **4 levels** `info | warn | error | critical`

**Choice**: 4 levels, not 3.

**Rationale**:
- The original 3-level scale lumps `pty:exit code != 0` (mildly annoying) with `tool-error` (Sigma's agency is broken) at `error`. They are not the same urgency.
- Precedent: VS Code uses `info/warning/error` (3) but adds a separate "modal" channel for must-acknowledge events. Slack uses `info/highlight/mention/urgent` (4). Cursor uses `info/warning/error` (3) + toast/banner promotion for blockers.
- SigmaLink needs `critical` reserved for events that **block the operator's mental model**: e.g., workspace DB corruption detected, Claude API key rotated/invalid, swarm coordinator crash. None of these have sources in v1, but reserving the slot now prevents a future migration when Packet 9 (Cross-machine sync) or Packet 6 (Windows SAPI5) inevitably needs it.

**Mapping**:
| Source | Default severity | Bump conditions |
|---|---|---|
| `pty:exit` exit code 0 | `info` | — |
| `pty:exit` exit code != 0, signal-killed | `warn` | — |
| `pty:exit` Sigma-monitored pane with `kind: 'error'` in `sigma_pane_events` | `warn` | — |
| `swarm:message` with `broadcastToSidebar=true` | `info` | `warn` if `kind ∈ {escalation, error_report}` |
| `assistant:tool-error` | `error` | `critical` if `toolName === 'create_workspace'` or DB-touching tool |
| **Reserved for v1.4.9+** sources | `critical` | DB corruption, auth-key invalid, sync conflict |

**UI affordance**:
- `info` → no badge color, gray dot in dropdown.
- `warn` → amber dot, badge stays gray.
- `error` → red dot, **badge turns red**.
- `critical` → red dot + **bell pulses** (subtle 2s CSS pulse for 30s after first arrival, then settles), **banner** above breadcrumb until acknowledged.

---

### D2 — Persistence model: **rolling window N=500 global + per-workspace soft cap of 200, 30d hard TTL on read**

**Choice**: hybrid rolling window + TTL, NOT per-workspace silos.

**Rationale**:
- "Persist all forever" is wrong: the swarm broadcast source can realistically emit 50–200 events/day in heavy operator use. At 200/day × 365d × 3 years = 219k rows. Indexes survive that, but the dropdown UX (and any future "search notifications" feature) does not.
- "Per-workspace only" is wrong: tool errors and (future) critical events are app-global. The operator wants to see "Claude API key invalid" regardless of which workspace they were in.
- The original brief's "last 50 unread + push the full list every change" approach **scales linearly with notification rate** and will cause IPC saturation under broadcast floods.

**Locked model**:
1. **Hard cap**: rolling window of **N=500** notifications total (global).
2. **Soft per-workspace cap**: at insert time, if a workspace has > 200 unread notifications of the same `kind`, collapse the oldest 50 into a **summary row** (`kind = '<original>-summary'`, `body = "47 more <pty-exit> notifications collapsed"`). This is the dedup mechanism in D3.
3. **TTL**: boot-time GC drops `read_at IS NOT NULL AND created_at < now() - 30 days` (matches original brief).
4. **Per-workspace storage**: `workspace_id` stays on the row (allows filtering); nullable for global events (auth, sync, app-level). Bell **shows all** by default; the dropdown has a filter chip `[All | This workspace | Errors only]`.
5. **Eviction order under hard cap**: drop oldest **read** rows first; if all 500 are unread, drop oldest **info** unread; never auto-drop `error` or `critical` (force the operator to dismiss).

**IPC contract** (replaces brief's "push full list" naïveté):
- Main fires `notifications:changed` with `{added: Notification[], removed: id[], unreadCount: number}` — delta, not full list. Renderer reconciles via reducer.
- Initial mount: renderer calls `notifications.list({limit: 100, offset: 0})` — paginated. Drop-down infinite-scrolls if user wants older.

---

### D3 — Dedup rules: **content-hash + temporal window, per source-tuple**

**Choice**: hash-based dedup keyed on `(workspace_id, kind, dedup_key)` within a **30-second** window.

**Rationale**:
- The original brief proposed "10+ same `kind` from same `workspace_id` within 5 seconds → collapse to one summary". That under-handles the common case: **the same pane exiting twice** (PTY restart loop), or **two swarm agents posting identical broadcast** at the same instant.
- VS Code, Slack, and Cursor all collapse identical notifications. Slack's heuristic: within 60s, same channel + same message body → collapse with count badge "(×3)". This is the right shape.

**Locked rules**:
1. Every source supplies a `dedupKey: string`:
   - PTY exit: `dedupKey = "pty-exit:${sessionId}"` (per-session, so two different panes exiting separately don't collapse).
   - Swarm message: `dedupKey = "swarm:${swarmId}:${kind}:${fromAgent}"` (per swarm + envelope kind + sender; bursts from one agent collapse, two agents posting independently don't).
   - Tool error: `dedupKey = "tool-error:${toolName}:${conversationId}"` (per conversation + tool; a tool failing 5x in one turn collapses).
2. On `add()`, query existing rows where:
   - `workspace_id` matches (NULL matches NULL)
   - `dedup_key` matches
   - `created_at >= now() - 30_000` (30s window)
   - `read_at IS NULL` (read rows do NOT absorb new events; user has already dismissed them)
3. **If a match exists**: increment `dup_count` on the existing row, update `created_at` to now (bumps it to top), update `body` to "<original body> (×N)". Do NOT insert a new row.
4. **If no match**: insert a new row with `dup_count = 1`.
5. **Critical bypass**: severity `critical` never dedups — every critical event gets its own row regardless.

**Schema impact**: adds `dedup_key TEXT` and `dup_count INTEGER NOT NULL DEFAULT 1` columns (folded into the 0018 migration below).

**Floods stay manageable**: the original brief's 10-event/5s collapse becomes a special case of (1)–(4). Most real bursts share `dedupKey`. The rare case of 11 *different* events in 5s (e.g., 11 different panes exit simultaneously) does NOT collapse — and that's correct: each pane deserves its own line.

---

### D4 — Read/unread tracking: **per-notification `read_at` + derived bell badge count**

**Choice**: per-row `read_at` (matches original). Bell badge = `COUNT(*) WHERE read_at IS NULL`.

**Rationale**:
- Per-row read tracking is non-negotiable: the dropdown needs visual separation of read/unread, and "mark this one read" is table-stakes (every reference app — Slack, Discord, VS Code Activity Bar, GitHub bell — does this).
- Alternative considered: single `bell_last_seen_at` timestamp (badge = `COUNT(*) WHERE created_at > bell_last_seen_at`). **Rejected**: doesn't model the "dismissed this one but not that one" workflow that any operator with > 5 simultaneous notifications needs.
- The original brief already proposed `read_at`. Locking it here so the implementing agent doesn't second-guess.

**Extra rule (new)**: opening the dropdown does NOT mark-all-read automatically. The operator must click items or "Mark all read". Auto-mark-on-open is a well-known UX anti-pattern (Slack-dropdown grievance #1, see HN discussion linked in Cursor's notification rewrite RFC) — it silently loses signal.

**Badge math**:
- `unreadCount === 0` → no badge.
- `1 <= unreadCount <= 9` → number badge `1` … `9`.
- `unreadCount >= 10` → `9+`.
- Color: red if any unread is `error` OR `critical`; amber if max is `warn`; gray otherwise.

---

### D5 — Click action: **deep-link to context + mark-read as side effect**

**Choice**: clicking the notification body navigates to the relevant context AND marks the notification read. Mark-read alone (without navigation) requires the explicit "×" dismiss button on the right of each row.

**Rationale**:
- The original brief said "Click on notification body: navigate to the relevant context" but didn't lock whether that *also* marks the row read. Operators expect both. (Slack: click → channel jump + read. GitHub: click → issue + read. VS Code: click → file + read.)
- Separating "read" from "dismiss/clear" is critical: read = "I have seen this"; dismiss/clear = "remove from list". Slack's model. Discord's model. The original brief conflated them.

**Locked deep-link targets**:
| Source | Target |
|---|---|
| `pty-exit` | Switch to the workspace + room of that session, scroll PTY history to bottom (use existing `session-history` route). If session was forgotten (>200ms post-exit), fall back to opening the agent-sessions list filtered to that session id. |
| `swarm-message` | Switch to the Swarm room of that `swarmId`, scroll mailbox to that message id (use existing mailbox `tail` path). |
| `tool-error` | Switch to the Sigma Assistant conversation, scroll to the `messageId` of the failing trace (already persisted by `tool-tracer.ts:persistTrace`). |
| `*-summary` (dedup collapse) | Open the dropdown filtered to that `dedup_key` so the operator sees the underlying rows. |
| `critical` (reserved) | Source-specific; for v1, no critical sources are wired. |

**Row controls** (right side of each dropdown item, hover-revealed):
1. `[×]` dismiss → DELETE row (not mark-read; the user said "remove").
2. `[Mark unread]` → `UPDATE … SET read_at = NULL` (only shown if `read_at IS NOT NULL`).
3. No "snooze" in v1 (deferred; cited as future option in D6).

---

### D6 — Native OS notifications: **opt-in, per-severity gates, no quiet-hours in v1**

**Choice**: native OS notifications are **OFF by default**. Enabled via Settings → Notifications → "Show OS notifications for [warn] [error] [critical]". v1 does NOT ship quiet-hours or per-source toggles.

**Rationale**:
- Aggressive defaults punish the operator. Cursor learned this the hard way (v0.31 → mass-disable, mass-complaint, reverted in v0.33).
- Per-severity gate (not per-source) covers 95% of the desire space without the configuration sprawl of "toggle PTY notifications on, swarm off, tool-error on". Quiet-hours adds a date-picker UI element to Settings; out of scope for v1.4.8.
- Reserving the **schema** for future per-source toggles is cheap (one extra kv key) and unlocks v1.4.9 without breaking changes.

**Locked v1 behaviour**:
1. **Default**: OS notifications disabled.
2. **Settings UI** (new section under existing Settings Room):
   - Master toggle: `Show OS notifications [ ] off / [x] on`.
   - When on, three checkboxes appear: `[ ] info  [x] warn  [x] error  [x] critical` (warn+ checked by default).
   - `critical` checkbox is **disabled and forced-on** (operator can disable warn/error but never critical — by definition critical is must-see).
3. **Implementation**: use Electron's built-in `new Notification(...)` API. Click → `BrowserWindow.focus()` + deep-link to context (same target as D5).
4. **Throttle**: at most one OS notification per `dedup_key` per 5 minutes (independent of the in-app dedup window of 30s). Prevents an OS notification storm during a swarm broadcast burst.
5. **Quiet hours**: NOT IN v1. Listed as v1.4.9 follow-up.
6. **Per-source toggles**: NOT IN v1. Stored as `kv['notifications.osPerSource']` JSON shape, unused for now.

**kv keys added** (no migration needed — `kv` table already exists):
- `notifications.osEnabled` → `'0'` | `'1'` (default `'0'`)
- `notifications.osSeverities` → JSON `string[]` (default `["warn","error","critical"]`)

---

## 3. Locked schema (migration 0018_notifications)

Replaces the schema block in the original brief. **Migration number is 0018, not 0017** — schema ceiling has advanced.

```sql
-- migration 0018_notifications.sql (NEW)
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,                    -- ulid
  workspace_id TEXT,                      -- nullable (global)
  kind TEXT NOT NULL,                     -- 'pty-exit' | 'swarm-message' | 'tool-error' | '<kind>-summary'
  severity TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error' | 'critical'
  title TEXT NOT NULL,                    -- one-liner shown in dropdown
  body TEXT,                              -- nullable detail; mutated by dedup to append " (×N)"
  payload TEXT,                           -- nullable JSON (kind-specific; pane id, swarm id, conv id, message id)
  source_event TEXT,                      -- 'pty:exit' | 'swarm:message' | 'assistant:tool-error'
  dedup_key TEXT NOT NULL,                -- D3 dedup tuple key
  dup_count INTEGER NOT NULL DEFAULT 1,   -- D3 absorbed-event count
  created_at INTEGER NOT NULL,
  read_at INTEGER                         -- nullable; per-row read marker
);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace
  ON notifications(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(workspace_id, dedup_key, created_at DESC) WHERE read_at IS NULL;
```

**Why three indexes**:
- `idx_notifications_workspace`: dropdown list query (per-workspace filter).
- `idx_notifications_unread`: badge count + "mark all read" query.
- `idx_notifications_dedup`: hot path on every `add()` — the 30s-window match lookup. Partial index on `read_at IS NULL` keeps it small.

---

## 4. Final delegation brief (hand-off to implementing agent)

> **You are the implementing agent for Packet 07 — Notifications + top-right bell.**
>
> Read **this entire document** before touching code. The reviewer has locked D1–D6; do NOT re-litigate them. If you find a hard blocker, escalate via SendMessage to the lead — do not silently change the taxonomy.

### Scope
- **In scope**: schema + manager + 3 sources (pty/swarm/tool-error) + renderer bell + dropdown + per-row controls + Settings panel for OS notifications + GC.
- **Out of scope**: quiet-hours, per-source OS toggles, snooze, search/filter beyond the 3 chips in D2, sync of notifications across machines (Packet 7 of v1.4.8 territory).

### Files to touch

**Main process** (numbers updated):
- `app/src/main/core/db/migrations/0018_notifications.ts` — NEW
- `app/src/main/core/db/migrations/0018_notifications.test.ts` — NEW (mirror 0017 test pattern)
- `app/src/main/core/db/schema.ts` — add `notifications` drizzle table + types
- `app/src/main/core/db/migrate.ts` — register migration 0018
- `app/src/main/core/notifications/manager.ts` — NEW (`add`, `list`, `markRead`, `markAllRead`, `dismiss`, `clearRead`, `gc`, dedup logic from D3, hard-cap eviction from D2)
- `app/src/main/core/notifications/manager.test.ts` — NEW (cover dedup window, eviction order, severity bump, critical bypass)
- `app/src/main/core/notifications/sources/pty-exit.ts` — NEW (subscribe to PtyRegistry `onPaneEvent` `kind: 'exited' | 'error'`; map to severity per D1)
- `app/src/main/core/notifications/sources/pty-exit.test.ts` — NEW
- `app/src/main/core/notifications/sources/swarm-message.ts` — NEW (subscribe via `mailbox.setEmitter` wrap or new hook; gate on `broadcastToSidebar`)
- `app/src/main/core/notifications/sources/swarm-message.test.ts` — NEW
- `app/src/main/core/notifications/sources/tool-error.ts` — NEW (subscribe to ToolTracer emit; gate on `trace.ok === false`)
- `app/src/main/core/notifications/sources/tool-error.test.ts` — NEW
- `app/src/main/core/notifications/gc.ts` — NEW (boot-time GC: drop read > 30d)
- `app/src/main/core/notifications/os-notify.ts` — NEW (Electron Notification wrapper, severity gate, 5min throttle per D6)
- `app/src/main/rpc-router.ts` — register `notifications.list`, `notifications.markRead`, `notifications.markAllRead`, `notifications.dismiss`, `notifications.clearRead`, `notifications.markUnread`

**Renderer**:
- `app/src/renderer/features/notifications/NotificationBell.tsx` — NEW (badge math from D4, pulse for critical from D1)
- `app/src/renderer/features/notifications/NotificationBell.test.tsx` — NEW
- `app/src/renderer/features/notifications/NotificationDropdown.tsx` — NEW (filter chips: All / This workspace / Errors only)
- `app/src/renderer/features/notifications/NotificationDropdown.test.tsx` — NEW
- `app/src/renderer/features/notifications/NotificationItem.tsx` — NEW (severity icon, dup-count badge, hover controls)
- `app/src/renderer/features/notifications/NotificationItem.test.tsx` — NEW
- `app/src/renderer/features/top-bar/Breadcrumb.tsx` — mount `<NotificationBell />` BEFORE `<RightRailSwitcher />` in the rightmost cluster
- `app/src/renderer/features/top-bar/Breadcrumb.test.tsx` — assert bell renders
- `app/src/renderer/features/settings/NotificationsSettings.tsx` — NEW (Settings panel for OS notifications per D6)
- `app/src/renderer/app/state-hooks/use-live-events.ts` — subscribe to `notifications:changed` delta payload
- `app/src/renderer/app/state.reducer.ts` — `NOTIFICATIONS_DELTA`, `MARK_NOTIFICATION_READ`, `DISMISS_NOTIFICATION` actions
- `app/src/renderer/app/state.types.ts` — `Notification` type + action types

**Shared**:
- `app/src/shared/types.ts` — `Notification` interface (with `severity: 'info'|'warn'|'error'|'critical'`, `dupCount`, `dedupKey`)
- `app/src/shared/rpc-channels.ts` — register notification channels
- `app/src/shared/router-shape.ts` — add `notifications` controller shape

### Wiring contracts

1. **PtyRegistry → notifications**: extend the existing `onPaneEvent` sink (already plumbed in `registry.ts:onPaneEvent`). Don't add a new `pty:exit` listener — re-use the existing event with `kind: 'exited' | 'error'` and bump severity per D1.

2. **Mailbox → notifications**: the mailbox already calls `this.emit(message)` on every append. Wrap the emitter at boot in `rpc-router.ts` so the same single emit feeds (a) the renderer broadcast (existing) and (b) the notifications source. Gate the notification source on:
   - `message.payload?.broadcastToSidebar === true` (operator-set on the envelope), AND
   - `message.kind ∈ {swarm-broadcast, escalation, review_request, error_report}` (legacy SIGMA:: kinds we already track).

3. **ToolTracer → notifications**: ToolTracer already calls `this.emit('assistant:tool-trace', trace)`. The notifications source subscribes to that channel, filters on `trace.ok === false`, and forwards to the manager.

4. **IPC delta**: main emits `notifications:changed` with `{added, removed, unreadCount}` (D2). NEVER push the full list — that's the original brief's mistake and would saturate IPC under flood.

### Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec tsc -b --pretty false
pnpm exec vitest run src/main/core/db/migrations/0018_notifications.test.ts
pnpm exec vitest run src/main/core/notifications/
pnpm exec vitest run src/renderer/features/notifications/
pnpm exec vitest run                              # full baseline
pnpm exec eslint .                                # 0 errors
```

### Manual smoke (mandatory before PR)

1. **Bell mount**: open SigmaLink, verify bell renders left of settings gear in Breadcrumb, no Win32 caption-overlay collision.
2. **PTY exit `info`**: open shell pane, type `exit`. Bell badge appears with count 1, gray. Click bell → dropdown shows "shell pane exited with code 0". Click item → navigates to that pane (or its history if forgotten). Row marked read; badge decrements.
3. **PTY exit `warn`**: open pane, run `false; exit 1`. Severity is `warn`, badge stays gray (no errors yet), dropdown shows amber dot.
4. **Swarm broadcast**: spawn 2-agent swarm, post a `broadcastToSidebar=true` envelope from agent A. Bell badge increments. Repeat from same agent within 30s — dropdown row shows `(×2)`, no new row.
5. **Tool error `error`**: start a Sigma turn, close the workspace mid-call so `launch_pane` throws. Bell badge turns **red**, count goes to 1, dropdown shows red dot. Click → jumps to that Sigma conversation message.
6. **Dedup window**: trigger same pty-exit 5 times in 30s (kill + restart loop). Confirm ONE row with `(×5)`, not 5 rows.
7. **Dedup expiry**: trigger pty-exit, wait 35s, trigger again. Two separate rows.
8. **Mark all read**: 10 unread → click "Mark all read" → badge clears, rows stay visible with read styling.
9. **Dismiss**: hover row → click `×` → row disappears (DELETE), badge updates if it was unread.
10. **OS notifications off (default)**: trigger 5 tool-errors. NO macOS Notification Center entries.
11. **OS notifications on**: Settings → Notifications → enable, check `warn` + `error`. Trigger pty-exit-1 → OS notification appears. Trigger again within 5 min → suppressed (throttle). Wait 6 min, trigger → fires again.
12. **GC**: insert read row dated 31d ago via dev console / migration test; relaunch app; row gone.
13. **Hard cap (synthetic)**: bulk-insert 600 rows via test seed → confirm oldest read evicted; if all 500 are unread, oldest `info` unread evicted; `error` and `critical` survive.
14. **Quit + relaunch**: unread notifications persist; read notifications < 30d persist with read styling.

### PR reporting

- Title: `feat(v1.4.8): notifications + top-right bell — pty/swarm/tool-error sources (packet 07)`
- Body must include:
  - Screenshot of bell + open dropdown with mixed-severity rows
  - The 0018 migration SQL
  - Coverage report for `src/main/core/notifications/`
  - One paragraph confirming D1–D6 were honored without deviation
- Do NOT bump version, write CHANGELOG, or open release PRs. Scope is exactly this packet.

---

## 5. Open questions for lead

The implementing agent should NOT proceed without lead answers on these (or lead confirmation of "use the default"):

1. **OS notification icon path**: Electron `new Notification({icon})` needs a `.png` path. Default to `app/build/icon.png` (already used by app icon)? **Lead default: yes, use the existing app icon.**
2. **Critical bypass count tracking**: per D3, critical never dedups. Should the bell still pulse if 10 different criticals arrive in 1 minute, or escalate to a modal? **Lead default: keep pulse only; no modal in v1.**
3. **"Errors only" filter chip**: shows `severity ∈ {error, critical}` or just `severity === 'error'`? **Lead default: include critical (the chip is named "Errors", critical-as-superset is what operators expect).**
4. **First-launch state**: after the migration runs on an existing install, the table is empty. Should the GC pass still run on boot (no-op) or be gated on `notifications` count > 0? **Lead default: always run (cheap and self-documenting).**
5. **Swarm gating field name**: the original brief proposed `broadcastToSidebar` on the envelope payload. Does this already exist on any envelope? Audit reveals it does NOT — implementing agent must add it as `payload.broadcastToSidebar: boolean` on the V3 envelope schema (no DB change; payload is JSON). **Lead default: agent adds the field as part of this packet; no separate envelope-schema packet needed.**

If lead is silent for 30 minutes, use the listed defaults and proceed. Note each default chosen in the PR body.

---

## 6. Delta vs. original brief

| Item | Original | Locked |
|---|---|---|
| Migration number | 0017 | **0018** (schema ceiling moved) |
| Severity levels | 3 (`info/warn/error`) | **4** (`info/warn/error/critical`) |
| Persistence | Implicit "last 50 unread" + per-row | **N=500 global, 200/kind/workspace soft cap, 30d TTL on read, severity-aware eviction** |
| Dedup | 10/5s same-kind collapse | **dedup_key tuple + 30s window + dup_count + critical bypass** |
| Read tracking | per-row `read_at` | per-row `read_at` + **no auto-mark-on-open** |
| Click action | navigate to context | **navigate + mark-read; separate `×` dismiss; separate "mark unread"** |
| Native OS notifications | Not specified | **opt-in, per-severity gates, 5min throttle, no quiet-hours v1** |
| IPC payload | full list every change | **delta `{added, removed, unreadCount}`** |
| Schema columns | id/workspace/kind/severity/title/body/payload/created/read/source | + `dedup_key`, `dup_count` |
| Indexes | 2 | **3** (added partial index for dedup hot path) |
| Files to touch | ~20 | **~28** (added 0018 test, Settings panel, OS-notify wrapper, additional source tests, item test) |

## 7. Effort re-estimate

- Original: L (~3-4d).
- Locked: **L (~3.5-4.5d)** — schema unchanged in shape, dedup logic adds ~2hr, Settings panel adds ~3hr, OS-notify wrapper + tests add ~3hr, item-level controls + tests add ~3hr. Net: ~half a day over the original estimate.
- Recommended single delegation: **Opus 4.7**. Sonnet would re-litigate D1/D3 mid-PR.
- Recommended sequencing: **after** Packets 01/02/03 of v1.4.8 ship (low-risk warm-ups); this is the highest-risk packet in v1.4.8 due to schema irreversibility.
