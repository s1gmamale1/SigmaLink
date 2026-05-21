# v1.13.1 Regression Audit (commit a1aadfd)

## Scope

Six files changed in commit `a1aadfd` ("fix: pane-+ gate race + notification sound").
This document enumerates every behavioural change and gives a safe/regression verdict
for each, followed by proposed fixes where needed.

---

## Change 1 — `swarmsLoading` state added to `CommandRoom`

**File:** `app/src/renderer/features/command-room/CommandRoom.tsx:81`

**What changed:** A new `boolean` state `swarmsLoading` is set to `true` immediately
before `rpc.swarms.list` is awaited and cleared in the `finally` block. It is passed
down to `AddPaneButton` and used in the `canAddPane` expression inside the empty-state
branch.

**Verdict: SAFE with one caveat (see Bug A below).**

The loading flag correctly prevents the "Open or create a workspace first" message
from flashing while the async list is in flight. The `finally { if (alive)
setSwarmsLoading(false) }` pattern is correct: if the component unmounts while the
request is in flight, `alive` is false and the setState is skipped, avoiding the
"update on unmounted component" warning.

**Bug A — `alive` guard only protects `setSwarmsLoading(false)`, not `UPSERT_SWARM`
dispatches.**
Inside the `try` block at line 117–120:

```
if (!alive) return;          // ← guards UPSERT_SWARM correctly
for (const swarm of list) {
  dispatch({ type: 'UPSERT_SWARM', swarm });
}
```

The `if (!alive) return` before the loop is correct. No regression here; the existing
guard pattern was preserved from the pre-v1.13.1 `.then(list => { if (!alive) return })`.

**Bug A (real) — dual load: `CommandRoom` and `use-live-events` both call
`rpc.swarms.list` on workspace switch.**
`use-live-events.ts:196–200` has an independent `useEffect` on
`state.activeWorkspace?.id` that also calls `rpc.swarms.list` and dispatches
`SET_SWARMS`. The new `CommandRoom` effect dispatches `UPSERT_SWARM` (one per swarm),
while the live-events hook dispatches `SET_SWARMS` (replaces the whole list). Both fire
concurrently on workspace activation. The race has two outcomes:

- If `CommandRoom`'s list resolves first: `UPSERT_SWARM` adds swarms, then
  `SET_SWARMS` overwrites with the same data — no harm, but two redundant RPC calls per
  workspace switch.
- If `use-live-events`'s `SET_SWARMS` resolves first and `CommandRoom`'s `UPSERT_SWARM`
  dispatches after: `UPSERT_SWARM` moves the upserted swarm to the front of
  `swarmsByWorkspace[wsId]` (reducer line 319: `[action.swarm, ...without]`). This
  re-sorts the list and may change `activeSwarmId` unexpectedly if the workspace had
  previously been empty (UPSERT auto-activate logic, reducer line 332).

This is a latent ordering hazard introduced by adding a second parallel loader.
Severity: Low–Medium. Proposed fix: remove the `CommandRoom`-local swarm-list effect
entirely and rely solely on the existing `use-live-events` loader; pass `swarmsLoading`
as a prop or derive it from a shared loading slice rather than a local `useState`.

---

## Change 2 — `canAddPane` expression change (empty-state branch)

**File:** `app/src/renderer/features/command-room/CommandRoom.tsx:249–254`

**Before:**
```ts
const canAddPane = activeSwarm?.status === 'running' && providers.length > 0;
```

**After:**
```ts
const hasRunningSwarm = workspaceSwarms.some((s) => s.status === 'running');
const hasNoSwarms = workspaceSwarms.length === 0;
const canAddPane = !swarmsLoading && providers.length > 0 && (hasRunningSwarm || hasNoSwarms);
```

**Verdict: REGRESSION — paused/completed swarms enable the broken create path.**

The intent stated in the comment ("A paused/completed swarm keeps canAddPane=false")
is NOT implemented correctly. Consider:

- Workspace has one swarm with `status: 'paused'`.
- `hasRunningSwarm = false`, `hasNoSwarms = false` → `canAddPane = false`. Correct.

- Workspace has one swarm with `status: 'paused'` AND one with `status: 'running'`.
- `hasRunningSwarm = true` → `canAddPane = true`. The button appears and calls
  `addEmptyStatePane`, which checks `if (activeSwarm) { targetSwarmId = activeSwarm.id }`.
  `activeSwarm` is derived as the running swarm (line 92: `workspaceSwarms.find(s =>
  s.status === 'running')`), so the correct running swarm is used. Correct.

The `hasNoSwarms` branch is the real issue. After `swarmsLoading` completes,
`workspaceSwarms.length === 0` is true in exactly two situations:

1. The workspace genuinely has no swarms — intended, safe.
2. The `SET_SWARMS` or `UPSERT_SWARM` dispatches have not yet arrived even though
   `swarmsLoading` is now false (e.g. if the CommandRoom local effect completes
   but the `use-live-events` `SET_SWARMS` has not fired yet, and `swarmsByWorkspace`
   still holds a stale entry from a prior workspace).

In case 2 the button becomes clickable and `addEmptyStatePane` creates a duplicate
swarm via `rpc.swarms.create` even though swarms already exist on the server. This is
the same class of bug as the "empty-roster create" bug described elsewhere in this
investigation series.

**Proposed fix:** Replace the `workspaceSwarms.length === 0` guard with a server-side
confirmation or with the result from the CommandRoom local load (compare the length of
the list returned by `rpc.swarms.list` rather than the derived Redux slice, which may
lag). Alternatively, keep the `canAddPane` gated only on a running swarm and let the
`addEmptyStatePane` path handle the zero-swarms case silently (i.e. always try; let
the server return a useful error if a swarm already exists).

---

## Change 3 — `swarmId` prop removed from `AddPaneButton`; replaced by `activeWorkspace`

**File:** `app/src/renderer/features/command-room/AddPaneButton.tsx:67–73`,
`app/src/renderer/features/command-room/CommandRoom.tsx:400–405`

**What changed:** `AddPaneButtonProps.swarmId: string | null` was deleted.
`AddPaneButtonProps.activeWorkspace: Workspace | null` and `swarmsLoading: boolean`
were added. The sole call site in `CommandRoom` was updated.

**Dangling consumer check:**
Grep confirms `AddPaneButton` is imported and rendered only in `CommandRoom.tsx:21,400`.
No other file references `AddPaneButtonProps` or the `swarmId` prop. The prop deletion
is safe — no dangling consumers.

**Verdict: SAFE.** The prop rename is complete and consistent.

---

## Change 4 — `getAddPaneDisabledReason` signature change and `!activeSwarm` now returns `null`

**File:** `app/src/renderer/features/command-room/AddPaneButton.tsx:47–65`

**Before:** `!activeSwarm` → `'Open or create a workspace first'`
**After:** `!activeSwarm` → `null` (button enabled; `addPane` will create a swarm)

**Verdict: REGRESSION — paused swarm that was selected by the user is silently bypassed.**

The `activeSwarm` memo in `CommandRoom` (line 87–93) resolves the active swarm as:

```ts
selected ?? workspaceSwarms.find((s) => s.status === 'running') ?? null
```

If the user has a paused swarm AND a running swarm:
- `activeSwarm` = the running swarm → `status !== 'running'` check does not fire.
- `getAddPaneDisabledReason` returns null (enabled).
- `addPane` attaches to the running swarm. Intended.

If the user has ONLY a paused swarm:
- `activeSwarm` = the paused swarm → `status !== 'running'` → returns
  `'Swarm is paused — resume it to add panes'`. Correct.

If `workspaceSwarms` is empty (`hasNoSwarms`):
- `activeSwarm` = null.
- `getAddPaneDisabledReason` returns null (line 57: `if (!activeSwarm) return null`).
- Button is enabled and `addPane` is invoked. The `else` branch at line 111 creates a
  new swarm. This path is the intended zero-swarms flow.

The function is therefore only correct in AddPaneButton because AddPaneButton also has
`swarmsLoading` gating — if loading is still true, the loading message is shown.
However there is no guard for the case where `swarmsLoading` is false but the Redux
slice is stale (same Bug A / Change 2 hazard above). A second `rpc.swarms.create`
could be issued to a workspace that already has swarms.

**Verdict: Logically sound under ideal conditions; vulnerable to the dual-loader
ordering hazard described in Change 1/Bug A.**

---

## Change 5 — `addPane` guard change: `!activeSwarm || !swarmId` → `!activeWorkspace`

**File:** `app/src/renderer/features/command-room/AddPaneButton.tsx:101`

**Before:** `if (!activeSwarm || !swarmId || adding) return;`
**After:** `if (!activeWorkspace || adding) return;`

**Verdict: SAFE with note.**
The old guard was defensive (bail if no swarm). The new guard is intentionally
permissive to allow swarm creation. The intent is correct. The only risk is the
zero-swarms false-positive noted above (Change 2).

One additional note: the `addPane` function creates a swarm optimistically
(`dispatch({ type: 'UPSERT_SWARM', swarm: newSwarm })` at line 118) before
`addAgent` resolves. If `addAgent` subsequently fails, the newly created swarm
remains in Redux state but has no agent attached, leaving orphaned swarm data.
There is no rollback dispatch on the `addAgent` failure path (catch block at line
128 only sets the error chip). This orphaned-swarm state could cause the button to
show "Swarm is paused" on next render if the created swarm's status is not 'running'.

**Proposed fix:** Either rollback the UPSERT_SWARM on addAgent failure (dispatch a
`REMOVE_SWARM` or re-fetch), or make swarm creation atomic with addAgent on the server
side (preferred).

---

## Change 6 — `addEmptyStatePane` guard change: `!activeSwarm` → `!activeWorkspace`

**File:** `app/src/renderer/features/command-room/CommandRoom.tsx:201–202`

**Verdict: SAME as Change 5** — identical logic, same orphaned-swarm risk on
`addAgent` failure. No additional issues.

---

## Change 7 — `playNotificationTone` added to `use-live-events`

**File:** `app/src/renderer/app/state-hooks/use-live-events.ts:177–182`

**What changed:** After `NOTIFICATIONS_DELTA` is dispatched, if any `added`
notification has `readAt == null` and severity `warn`/`error`/`critical`,
`playNotificationTone()` is called as `void` (fire-and-forget).

**Verdict: SAFE.**

- `playNotificationTone` is fully wrapped in try/catch, non-blocking, and
  `void`-discarded. Audio failure does not affect render or state.
- The check is performed on the `added` array (notifications new in this delta),
  not on the full notifications list, so the tone does not fire for pre-existing
  notifications on re-mount.
- The `readAt == null` guard means already-read notifications do not trigger the tone.
- The function reads `cachedSoundEnabled` (module-level cache); the first call
  per session will await `rpcSilent.kv.get`. Subsequent calls return synchronously
  from cache. No unintended re-render is possible.
- The `notifications:changed` listener is set up in a `useEffect` with `[dispatch]`
  dep; `dispatch` is stable, so the listener is registered once and not torn down
  on notification state changes. This is correct.

**Minor concern:** If a `notifications:changed` event fires during app startup before
user gesture (e.g. a system-generated notification on login), the Web Audio API may
refuse to create the `AudioContext` in some browsers due to autoplay policies. This is
handled by the `try/catch` in `playNotificationTone` (silent failure). No regression.

---

## Change 8 — `playNotificationTone` implementation (new function in `notifications.ts`)

**File:** `app/src/renderer/lib/notifications.ts:106–146`

**Verdict: SAFE.**

- Uses two overlapping oscillators (D4 293.66 Hz, A3 220 Hz) with exponential
  gain envelopes. Tone duration ≤ 260ms. `AudioContext` is closed after 500ms
  via `setTimeout`.
- `cachedSoundEnabled` module variable is cleared/set by `setNotificationSoundEnabled`
  and read by `getNotificationSoundEnabled`. Cache coherence is correct for a
  single-tab Electron renderer.
- Two overlapping tones share the same `AudioContext` — the context is closed while
  the second oscillator may still be playing (tone ends at `now + 0.1 + 0.16 = 0.26s`,
  context closes at 500ms). This is fine; closing an AudioContext after all scheduled
  audio completes is correct.

---

## Change 9 — `getNotificationSoundEnabled` / `setNotificationSoundEnabled` added to `notifications.ts`

**File:** `app/src/renderer/lib/notifications.ts:39–58`

**Verdict: SAFE.**

Pattern is identical to the pre-existing `getDingEnabled`/`setDingEnabled`. The
`cachedSoundEnabled` module variable is initialised to `null` (lazy) and the default
on missing kv key is `true` (on). No state leak between the two caches.

---

## Change 10 — `NotificationsSettings`: new `soundEnabled` state + `persistSound` + settings row

**File:** `app/src/renderer/features/settings/NotificationsSettings.tsx:60,92–95,190–198`

**Verdict: SAFE.**

The `soundEnabled` state is hydrated from `getNotificationSoundEnabled()` in the same
`useEffect` that loads ding and OS-notification prefs. The `persistSound` callback is
optimistic (setState then write kv). Pattern is consistent with `persistDing`.

One observation: `persistDing` and `persistSound` are async functions but are not
awaited at the call site (`onChange={(e) => void persistDing(e.target.checked)}`).
If the kv write fails silently (best-effort catch in `setNotificationSoundEnabled`),
the UI state (`soundEnabled`) will diverge from persisted state. This is pre-existing
behaviour inherited from `persistDing` and is not a new regression in v1.13.1.

---

## Summary of Regressions / Risks

| # | Verdict | Severity | Location |
|---|---------|----------|----------|
| A | REGRESSION — dual loader race; orphaned swarm on addAgent failure | Medium | `CommandRoom.tsx:108–130`, `use-live-events.ts:196–208` |
| B | REGRESSION — `hasNoSwarms` in `canAddPane` can be true while swarms exist (stale slice) | Medium | `CommandRoom.tsx:249–254` |
| C | SAFE | — | `AddPaneButton` prop rename (swarmId → activeWorkspace) |
| D | SAFE | — | Notification tone (use-live-events, notifications.ts) |
| E | SAFE | — | NotificationsSettings new row |

### Proposed Fixes

**Fix A (dual loader):** Delete the `CommandRoom`-local `rpc.swarms.list` effect
(lines 108–130 in `CommandRoom.tsx`). The `use-live-events` hook already loads swarms
on workspace switch. Drive `swarmsLoading` from that single canonical loader (e.g.
a dedicated loading action in the reducer, or pass it as a prop from the parent that
owns `useLiveEvents`).

**Fix B (stale-slice canAddPane):** Gate `canAddPane`'s `hasNoSwarms` branch on the
result of the CommandRoom local list call (if kept), not on `workspaceSwarms.length`.
Alternatively, remove the `hasNoSwarms` condition from `canAddPane` and let
`addEmptyStatePane` always attempt swarm creation; rely on the server to return an
idempotent response or an appropriate error if a swarm already exists.

**Fix C (orphaned swarm on addAgent failure):** In `addPane` and `addEmptyStatePane`,
move `dispatch({ type: 'UPSERT_SWARM', swarm: newSwarm })` to after `addAgent` resolves
successfully, or add a `REMOVE_SWARM` dispatch in the catch block.
