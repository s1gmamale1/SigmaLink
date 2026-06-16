# Tools in Scoped (Popped-Out) Workspace Windows — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); implementation plan to follow
- **Topic:** Make the in-app Browser, the Jorvis assistant, and the other right-rail tools usable inside a workspace that has been detached into its own OS window.
- **Builds on:** Multi-window workspaces (Phase 16 / ADR-009, PR #169). Picks up the follow-up explicitly parked as "non-workspace rooms in secondary windows."

---

## 1. Problem

A workspace can be detached into its own OS window (Sidebar → "Open in new window" → `rpc.windows.detachWorkspace`). That secondary window renders `ScopedShell` (`src/renderer/app/App.tsx:228–247`): a drag-titlebar + `<CommandRoom />` and nothing else. It has no `Sidebar`, no `Breadcrumb`, no `RoomSwitch`, and no `RightRail`.

Consequently the in-app **Browser**, the **Jorvis** assistant, and the **Skills / Swarm / Sigma** tools — all of which live in `RoomSwitch` and `RightRail`, mounted only by the main window — are unreachable from a popped-out workspace. The user must flip back to the main window to use them.

**Goal:** give a popped-out workspace window the right-rail tools (Browser, Jorvis, Skills, Swarm, Sigma) alongside its Command Room, scoped to that one workspace, without making it a full clone of the main window.

---

## 2. Decisions (locked with the user)

1. **Scope = right-rail parity.** Mount the existing `<RightRail>` in `ScopedShell` so the scoped window gains Browser + Jorvis + Skills + Swarm + Sigma as side-rail tabs next to the Command Room. NOT full room navigation; NOT Settings/Memory/Git rooms.
2. **Rail control = switcher in the titlebar.** Put the existing `<RightRailSwitcher>` into the scoped window's drag-titlebar (it has no `Breadcrumb` to host it).
3. **Jorvis model = per-window, scoped to its workspace.** Each window's Jorvis is an independent assistant bound to that window's workspace, with its own conversation; its pane/dispatch/chat events land only in the owning window. Matches ADR-009 ("detach is a MOVE, never a mirror"). No cross-window pane stomping.

---

## 3. Verified ground truth (as of 2026-06-16)

| Fact | Location |
| --- | --- |
| Scoped window shell (titlebar + `CommandRoom` only) | `src/renderer/app/App.tsx:228–247` |
| Window-type branch `IS_SCOPED_WINDOW ? <ScopedShell/> : <full layout>` | `src/renderer/app/App.tsx:46`, `:372–390` |
| `RightRailProvider` already wraps BOTH shells | `src/renderer/app/App.tsx:358–391` |
| `RightRailSwitcher` is a zero-prop component (`useRightRail()` + `useAppDispatch()`) | `src/renderer/features/top-bar/RightRailSwitcher.tsx:37–42` |
| `MainBody` wraps body in `<RightRail>` (the reuse pattern) | `src/renderer/app/App.tsx:192–210` |
| Active-tab persisted to a **single global** KV key `rightRail.tab` (COLLIDES across windows) | `RightRailContext.data.ts:10` (`KV_TAB`); read `RightRailContext.tsx:47`; write `RightRailContext.tsx:90` |
| Open/closed persisted per-workspace `ui.<wsId>.rightRail.open` (no collision) | `RightRailContext.data.ts:12` (`KV_OPEN`); `RightRailContext.tsx:97–103`; key fmt `workspace-ui-kv.ts:10` |
| Width persisted per-workspace on write (no collision) | `RightRail.tsx:82` |
| Rail tab ids | `RightRailContext.data.ts:8` — `'browser' \| 'editor' \| 'jorvis' \| 'skills' \| 'swarm' \| 'sigma'` (Editor is an unwired placeholder) |
| `BrowserManager` holds `this.window`; `ensureView()` → `this.window.contentView.addChildView(view)` | `manager.ts:71–76`, `:561–609` (attach `:599`) |
| `setBounds`/`applyBounds` position the view in whatever window it's attached to; no window identity in the IPC | `manager.ts:306–335`; renderer `BrowserViewMount.tsx:96–100` (rect = `getBoundingClientRect()`) |
| `windowProvider` resolves window via `BrowserWindow.getFocusedWindow()` (not by workspace owner) | `rpc-router.ts:727–736` |
| `registry.get(workspaceId)` calls `mgr.setWindow(windowProvider())` on every RPC | `manager.ts:758–803` |
| `BrowserManager.setWindow` only reassigns `this.window`; does NOT re-parent the view | `manager.ts:80–87` |
| Existing view re-parent mechanics to reuse | `detachToWindow()` `manager.ts:395`, `:432`, `:441`; `_reattachView()` `manager.ts:513+` |
| Workspace detach handler creates the window but never re-points the browser | `detach-handlers.ts:20–37` |
| `assistant.send` input has NO window id | `controller.ts:303–321` |
| `ActiveTurn` has NO window id | `controller.ts:79–83` |
| IPC handler discards the Electron sender (`_e`) | `rpc-router.ts:2430–2453` |
| All `assistant:*` events go to `sendToAll` (NOT session-routed) | `rpc-router.ts:239–249`; `registry.sendToAll` `registry.ts:95–99` |
| `WindowRegistry` maps `workspaceId → owner window` + `sessionId → workspace`; routes via `sendToWorkspaceOwner` / `sendToSessionOwner` | `registry.ts:69–72` (`assignWorkspace`), `:78–81` (`ownerWindowIdFor`), `:115–125` (`sendToSessionOwner`) |
| Assistant emit path (`broadcast` + Telegram `assistantStateSubscribers` fan-out) | `rpc-router.ts:2080–2106` |
| Jorvis tools incl. browser tools (`open_url`, `browser_navigate`, `browser_snapshot`) | `tools.ts`, `tool-catalogue.ts` |

> **Note:** each OS window is a separate renderer process with its own in-memory `RightRailProvider`. The only renderer-side cross-window coupling is the shared KV store (hence the `rightRail.tab` collision).

---

## 4. Architecture / chosen approach

**Approach A — reuse-in-place** (chosen over extracting a shared `WorkspaceWorkbench`, which would edit the already-shipped main-window layout for no user-visible gain; and over per-window identity tracking via the IPC sender, which is more invasive than routing by `workspaceId`).

Two leaks must be closed so tools act on the correct window:

- **Event leak (Jorvis):** route `assistant:*` events by the turn's `workspaceId` → owner window, instead of `sendToAll`.
- **View leak (Browser):** the `WebContentsView` must be re-parented to the workspace's owner window.

Both leverage `WindowRegistry`'s existing exclusive `workspaceId → owner window` ownership. No new window-identity plumbing.

---

## 5. Detailed design

### 5.1 Renderer shell — `ScopedShell` (`src/renderer/app/App.tsx:228–247`)

Change the scoped shell from `titlebar + <CommandRoom/>` to `titlebar(with switcher) + <RightRail><CommandRoom/></RightRail>`.

- Wrap the body in the existing `<RightRail>` (the same wrapper `MainBody` uses at `App.tsx:192–210`). No new layout code; the rail self-manages open/width/tab via `RightRailContext`.
- Add `<RightRailSwitcher />` to the titlebar, right-aligned, inside a span styled `-webkit-app-region: no-drag` so it remains clickable within the drag region (the rest of the titlebar keeps `dragStyle()`).
- No `RoomSwitch`, no `Sidebar`, no navigation-bearing globals — scope stays "one workspace + its tools."
- The scoped window's `RightRail` mounts the same tab bodies as the main window: `BrowserRoom` (browser tab), `JorvisRoom variant="rail"` (jorvis tab), `SkillsTab`, `SwarmRailTab`, `SigmaPanel`, and the `EditorTabPlaceholder` (unwired placeholder, identical to main).

### 5.2 Rail tab persistence — `RightRailContext.tsx`

Make the active-tab key per-workspace to stop the main/scoped clobber:

- On write (currently `RightRailContext.tsx:90`), when an active `wsId` exists, persist to `ui.<wsId>.rightRail.tab` via the existing `writeWorkspaceUi(...)` helper; fall back to the global `rightRail.tab` only when `wsId` is null.
- On read (currently `RightRailContext.tsx:47`), read `ui.<wsId>.rightRail.tab` first, fall back to the legacy global `rightRail.tab` for back-compat.
- This mirrors how `KV_OPEN` / width are already scoped, and as a bonus each workspace remembers its own last rail tab in the main window. Contained to this one file (+ its data module if a new key constant is added).

### 5.3 Jorvis event routing — `rpc-router.ts` + `controller.ts`

Today all `assistant:*` events broadcast to every window (`rpc-router.ts:239–249`). Scope them by workspace owner:

1. **Thread `workspaceId` into the event payloads.** The controller knows the turn's `workspaceId` (from `send`, `controller.ts:303–321`). Add `workspaceId` to the payloads of: `assistant:state`, `assistant:tool-trace`, `assistant:dispatch-echo`, `assistant:pane-closed`, `assistant:pane-event`. (Store `workspaceId` on `ActiveTurn` so emits that only have a `turnId`/`conversationId` can resolve it.)
2. **Route by owner in `broadcast()`.** Introduce a `WORKSPACE_ROUTED_ASSISTANT_EVENTS` set (the five events above). For these, if the payload carries a `workspaceId` owned by a window, deliver via `registry.sendToWorkspaceOwner(workspaceId, event, payload)`; otherwise fall back to `registry.sendToAll(...)` (back-compat / unowned).
3. **Preserve the Telegram bridge.** The separate `assistantStateSubscribers` fan-out for `assistant:state` (`rpc-router.ts:2080–2106`) stays unchanged — it is not window delivery.

**Effect:** a scoped window's `launch_pane`/`close_pane`/chat stream lands only in that window's Command Room and chat; the main window never double-acts. Single-window behavior is unchanged because the main window owns the active workspace, so its own turns route back to it.

**Renderer side:** the scoped window's `JorvisRoom` (rail variant) is bound to the scoped window's active workspace (its only workspace). Confirm during implementation that:
- `assistant.send` from the rail passes the scoped `workspaceId` (it sends the active workspace id today).
- The `useJorvisDispatchEcho` refetch uses workspace-scoped lists (`panes.listForWorkspace` / `swarms.list` for the active workspace) so it only hydrates this window's grid.
- Existing `turnId`/`conversationId` filtering in `use-jorvis-assistant-state.ts` remains as a second line of defense against stale/foreign events.

### 5.4 Browser view follows its workspace — `browser/manager.ts`, `BrowserManagerRegistry`, detach/redock handlers

1. **Resolve target window by workspace owner.** Change `windowProvider` (`rpc-router.ts:727–736`) to accept the `workspaceId` and resolve the owner window from `WindowRegistry` (`ownerWindowIdFor` → handle), falling back to focused/first window when ownership is unknown. Thread the `workspaceId` through `registry.get(workspaceId)` → `windowProvider(workspaceId)`.
2. **Re-parent on window change.** Make `BrowserManager.setWindow(win)` (`manager.ts:80–87`) detect when `win` differs from the currently attached window and, if a `WebContentsView` is mounted, re-parent it: `oldWindow.contentView.removeChildView(view)` → `win.contentView.addChildView(view)`, reusing the exact mechanics in `detachToWindow()`/`_reattachView()` (`manager.ts:395+`, `:513+`). Because the window is now resolved by owner (not focus), this fires once on detach/redock — not on every RPC — so no thrash.
3. **Trigger on detach/redock.** In the `windows.detachWorkspace` / `windows.redockWorkspace` handlers (`detach-handlers.ts:20–37`), after ownership changes in `WindowRegistry`, nudge the workspace's `BrowserManager` to re-point to the new owner window (e.g. `browserRegistry.repointToOwner(workspaceId)` which calls `mgr.setWindow(resolvedOwner)`), so the view follows the workspace into the popped-out window and back on redock.
4. **Coordinate-space correctness.** `setBounds` rects are window-relative (`BrowserViewMount.tsx:96–100`). Once the view is parented to the same window whose renderer sends the rect, coordinates line up. Re-pointing must therefore complete before/with the scoped window's first `setBounds`; the lazy `setWindow` on the next browser RPC plus the explicit detach/redock nudge covers both the proactive and reactive paths.

### 5.5 Edge cases

- **Browser open in main, then workspace detached:** view is in the main window's `contentView`. The detach nudge (5.4.3) re-parents it to the scoped window. On redock, ownership returns to main; the redock nudge re-parents it back, and the scoped window's unmounting `BrowserViewMount` sends `setBounds(null)`.
- **Two windows, two browsers:** each workspace has its own `BrowserManager` keyed by `workspaceId`, each parented to its owner window — independent.
- **Scoped window closed (not redocked):** existing close handler re-docks the workspace to the main window (`electron/main.ts` secondary `closed` handler); the redock nudge re-points the browser to main.
- **Voice focus:** unchanged — `voice:focused-session` remains last-writer-wins across windows (tracked separately in WISHLIST); not addressed here.

---

## 6. Testing

Per the project's Electron/`better-sqlite3` constraint, DB/native paths use mocks (assert emitted behavior / in-memory arrays; never `new Database()`).

- **RightRailContext:** active-tab read/write uses `ui.<wsId>.rightRail.tab` when a workspace is active (no global clobber); falls back to global `rightRail.tab` when `wsId` is null.
- **`broadcast()` / WindowRegistry:** `assistant:*` event with an owned `workspaceId` routes to that workspace's owner window (`sendToWorkspaceOwner`), not `sendToAll`; an event with absent/unowned `workspaceId` falls back to `sendToAll`.
- **Controller:** `ActiveTurn` records `workspaceId`; the five emit paths include `workspaceId` in their payloads.
- **`BrowserManager.setWindow`:** re-parents the view when the target window changes (mock `contentView.add/removeChildView`); is a no-op when unchanged. `windowProvider(workspaceId)` resolves the owner window from a mocked registry, falls back when unowned. `repointToOwner` calls `setWindow` with the resolved owner.
- **Renderer (jsdom):** `ScopedShell` mounts `RightRailSwitcher` + `RightRail` wrapping `CommandRoom`; the switcher sits in a `no-drag` region. Full `vitest run` afterward to catch sibling mock breakage.
- **Sibling-site sweep (per project conventions):** grep for the twin sites — every `assistant:*` emit, both browser view attach/detach paths, and the detach/redock handler pair — so one is not changed while its mirror is missed.

---

## 7. Out of scope (YAGNI)

- Full room navigation in scoped windows (`RoomSwitch`, Settings, Memory, Git, Operator, etc.).
- `CommandPalette` (⌘K) / `GlobalMemorySwitcher` (⌘O) / onboarding & spotlight modals in scoped windows.
- `VoicePill` / window-aware voice focus.
- Wiring the Editor rail tab (it remains the same placeholder as in the main window).
- Window-layout boot restore (`ui.windows.layout`) — separate WISHLIST item.

---

## 8. File change inventory (anticipated)

**Renderer**
- `src/renderer/app/App.tsx` — `ScopedShell`: titlebar `<RightRailSwitcher>` + `<RightRail><CommandRoom/></RightRail>`.
- `src/renderer/features/right-rail/RightRailContext.tsx` (+ `RightRailContext.data.ts` if a key constant is added) — per-workspace active-tab persistence.
- (Verify only) `src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts`, `use-jorvis-assistant-state.ts` — workspace-scoped refetch + event filtering already correct.

**Main**
- `src/main/rpc-router.ts` — `WORKSPACE_ROUTED_ASSISTANT_EVENTS` + owner routing in `broadcast()`; `windowProvider(workspaceId)` resolving owner window.
- `src/main/core/assistant/controller.ts` — `ActiveTurn.workspaceId`; include `workspaceId` in the five emit payloads.
- `src/main/core/browser/manager.ts` — `setWindow` re-parents the view; `BrowserManagerRegistry.get(workspaceId)` passes workspaceId to provider; add `repointToOwner(workspaceId)`.
- `src/main/core/windows/detach-handlers.ts` — nudge browser re-point on detach/redock.
- (Possibly) `src/main/core/windows/registry.ts` — only if a small helper is needed; routing reuses `sendToWorkspaceOwner`/`ownerWindowIdFor`.
- `src/shared/rpc-channels.ts` / `router-shape.ts` — only if event payload types are declared there (add `workspaceId`).

**Tests** — alongside each changed unit, as in §6.

---

## 9. Open questions

None blocking. Implementation-time confirmations are noted inline in §5.3 (renderer Jorvis already workspace-scoped) and §5.4 (re-point timing vs first `setBounds`).
