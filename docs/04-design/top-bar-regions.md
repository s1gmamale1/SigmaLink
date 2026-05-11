# Top-bar regions — v1.1.4

The top breadcrumb bar gained two new chrome regions in v1.1.4 to port the V3 BridgeMind layout. This doc maps the regions and the drag-region behaviour around them.

## Regions

```
┌─────┬────────────────────────────────────────────────┬───────────────────────────┐
│ TL  │                       MID                       │            TR             │
└─────┴────────────────────────────────────────────────┴───────────────────────────┘
  ↑                            ↑                                      ↑
  RoomsMenuButton              Workspace number / username /          RightRailSwitcher
  (LayoutGrid icon →           workspace name / RufloReadinessPill    ([Browser][Editor]
   DropdownMenu)                                                       [Sigma] + ⚙)
```

| Region | Component | File | Drag behaviour |
|---|---|---|---|
| **TL** (left edge) | `RoomsMenuButton` | `src/renderer/features/top-bar/RoomsMenuButton.tsx` | Button itself: `noDragStyle()` (clicks register). Surrounding bar: `dragStyle()`. |
| **MID** (centre) | workspace breadcrumb + Ruflo pill | `src/renderer/features/top-bar/Breadcrumb.tsx` (inline) | All `dragStyle()`. Double-click here to zoom the macOS window. |
| **TR** (right edge) | `RightRailSwitcher` | `src/renderer/features/top-bar/RightRailSwitcher.tsx` | Buttons: `noDragStyle()`. Surrounding bar: `dragStyle()`. |

## Why the regions exist

- **TL — RoomsMenuButton**: v1.1.4 removed the 12-item room nav from the left sidebar (sidebar became a pure workspaces panel). Users need a way to switch between Workspaces / Command / Swarm / Operator / Review / Tasks / Memory / Browser / Skills / Sigma / Settings rooms — the dropdown is that surface. The button is always visible (Workspaces room is reachable even with no workspace open).
- **TR — RightRailSwitcher**: the right-rail tabs (Browser / Editor / Sigma) previously lived inside the right rail as an always-visible h-9 strip. v1.1.4 lifted them to the top bar as a segmented control. The settings gear next to them dispatches `SET_ROOM('settings')`. A notifications bell V3 also shows in this region is explicitly out of scope until a notification source exists.

## State lift: RightRailContext

The TR switcher and the right-rail content need to stay in sync. v1.1.4 introduces `RightRailContext` (`src/renderer/features/right-rail/RightRailContext.tsx`) wrapping `{ activeTab, setActiveTab }`:

- Hydrates from kv `rightRail.tab` on mount.
- Persists every `setActiveTab` call via `rpc.kv.set`.
- `useRightRail()` hook consumed by both `RightRailSwitcher` (top-bar) and `RightRailTabs` (in-rail content).
- Provider wraps the whole layout in `App.tsx`.

This is the only piece of v1.1.4 that lifts state into a new context — every other change is renderer-local.

## Disabled-room logic

`RoomsMenuButton` mirrors v1.1.3 sidebar behaviour exactly:

- Always enabled: `workspaces`, `settings`, `skills`, `bridge` (Sigma).
- Disabled when `state.activeWorkspace === null`: all the rest (command, swarm, operator, review, tasks, memory, browser).

The logic lives in `src/renderer/features/top-bar/rooms-menu-items.ts:isRoomDisabled(roomId, hasActiveWorkspace)`.

## RoomId union note

The plan estimated 12 rooms; the actual `RoomId` union in `state.tsx:20-38` has 11 entries. `RoomsMenuButton` reads the actual union so the menu can never drift from the type.
