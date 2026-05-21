# Design — Pane "+" gate fix + Notification sound

> Brainstormed 2026-05-22 (superpowers:brainstorming). Two audited bugs (read-only
> feature audit). Decisions captured via AskUserQuestion. Ships as v1.13.1 off the
> post-Bridge→Sigma-rename main.

## Fix 1 — Pane "+" shows "Open or create a workspace first" while a workspace IS open

**Root cause:** `getAddPaneDisabledReason()` (`AddPaneButton.tsx:43`) reads only `activeSwarm`, which is `null` during the async swarm-hydration window (between `SET_ACTIVE_WORKSPACE_ID` and `rpc.swarms.list` resolving) even when a workspace is open. A v1.5.3-hotfix reduced it but a residual boot-window race remains (worse on slow startup / many panes).

**Fix:**
- Rework `getAddPaneDisabledReason` to take `activeWorkspace` + `activeSwarm` + `swarmsLoading`:
  - `!activeWorkspace` → "Open or create a workspace first" (the **only** case this message fires).
  - `activeWorkspace && swarmsLoading` → "Loading workspace…" (disabled, accurate, transient).
  - `activeWorkspace && !swarmsLoading && !activeSwarm` (genuinely 0 swarms) → button **enabled**; `addPane()` ensures a swarm exists (create/select the workspace's swarm) before `rpc.swarms.addAgent`.
  - existing running / ≤20-agent checks unchanged.
- `CommandRoom` passes `activeWorkspace` + a `swarmsLoading` signal (derived from the in-flight `rpc.swarms.list` for the active workspace) into `AddPaneButton`.
- `addPane()` (and the empty-state CTA): when no `activeSwarm` but a workspace is active, ensure a swarm first (reuse the existing swarm-create/ensure path; verify an RPC exists).
- **Tests (RTL):** message only when no workspace; "Loading…" mid-hydration; enabled when workspace+swarm ready; add-with-zero-swarms creates a swarm.

## Fix 2 — Notification sound (bell/panel was silent)

**Root cause:** operator-facing notifications (`NotificationsManager` → `notifications:changed` delta → bell/dropdown) play no sound. `playDing()` exists but is wired only to Jorvis dispatch-completion.

**Fix:**
- New **distinct** tone `playNotificationTone()` in `renderer/lib/notifications.ts` — audibly different from the Jorvis `playDing()` chime (e.g. a short two-note tone).
- The renderer's `notifications:changed` subscriber plays it **once per delta** when `added` contains new **unread** rows of severity ∈ **{warn, error, critical}**. `info` stays silent.
- **Toggle** `kv['notifications.sound']`, **default ON** (unset ⇒ on), surfaced in `NotificationsSettings` next to the existing Jorvis-chime toggle.
- Dedup is free — `NotificationsManager` already 30s-dedups, so `added` carries no duplicates.
- **Tests:** tone on warn+ delta when enabled; silent on info; silent when toggled off; silent on removed-only / empty deltas.

## Execution
- **One Sonnet coder** (both fixes are small, renderer-side, coherent "UX fixes" packet) in an isolated worktree off the post-rename main; complete-or-report; full gate; never push/tag/release.
- Lead reviews + runs the full gate in main + ships **v1.13.1**.
