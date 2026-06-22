# Universal Workspace Chrome — Design

**Date:** 2026-06-23
**Branch base:** `origin/main` (`704a8c5`)
**Status:** Approved (design), pending implementation plan

## Problem

The DB / `kv` store persists several pieces of UI **shell** state per-workspace.
Switching workspaces re-applies the saved-for-that-workspace shell, so the
"furniture" moves on every switch:

- the **left sidebar (workspace panel) width** re-adjusts,
- the **right-rail** (Browser / Jorvis / IDE tools dock) width + open/closed state changes,
- the **chrome color** changes (a per-workspace accent "tint").

The operator's intent: the outside **tools and chrome must be universal** (app-global).
Only **pane state** (and the per-workspace tool *content* + which room is viewed)
should be workspace-scoped.

## Verified current behavior (receipts)

Per-workspace UI shell state, keyed `ui.<wsId>.<panel>` in the global `kv` table
via `readWorkspaceUi` / `writeWorkspaceUi` (`src/renderer/lib/workspace-ui-kv.ts`):

| State | Current key | Hydrate re-runs on | File:line |
|---|---|---|---|
| Sidebar width | `ui.<wsId>.sidebar.width` (legacy `app.sidebar.width`) | `[wsId]` | `features/sidebar/Sidebar.tsx:88-121` |
| Right-rail width | `ui.<wsId>.rightRail.width` (legacy `rightRail.width`) | `[wsId]` | `features/right-rail/RightRail.tsx:140-165` |
| Right-rail open/closed | `ui.<wsId>.rightRail.open` (no legacy) | `[wsId]` | `features/right-rail/RightRailContext.tsx:65-104` |
| Workspace tint (chrome accent) | `ui.<wsId>.tint` | `[activeWorkspaceId, theme]` | `app/useWorkspaceTint.ts`, `features/settings/WorkspaceTintSection.tsx:62,70` |

Already global (correct, **no change**): theme `app.theme` (`app/ThemeProvider.tsx`),
active rail tab `rightRail.tab` (`RightRailContext.tsx:43-60`), sidebar collapse
`app.sidebar.collapsed`, density, font size, zoom.

Stays per-workspace (correct, **no change**): command-room panes
(`agent_sessions` / `sessionsByWorkspace`), viewed room (`roomByWorkspace`),
tool **content** — browser tabs (`browser_tabs.workspaceId`), Jorvis conversations
(`conversations.workspaceId`), and room-internal grid layouts
(`ui.<wsId>.browser.cols`, `ui.<wsId>.memory.cols`).

## Decisions

1. **Tool scope:** *Shell global, content per-workspace.* Globalize the panel
   chrome (sizes / open-state / active-tab / tint). Browser tabs and Jorvis
   conversations stay scoped per workspace (a repo's tabs/assistant context do not
   leak into another). No DB migration.
2. **Color:** *Remove the per-workspace tint feature.* Color is then driven solely
   by the already-global Theme — fully universal, never changes on switch.

## Solution

### A. Globalize the three shell keys

For each of the three components, stop keying by `wsId`: read/write the existing
**global** key and hydrate **once on mount** (effect dep `[]` instead of `[wsId]`).
The global keys already exist (they are today's legacy-fallback targets), so this is
a small, localized change.

| State | After |
|---|---|
| Sidebar width | always `app.sidebar.width` |
| Right-rail width | always `rightRail.width` |
| Right-rail open/closed | always `rightRail.open` |

- `Sidebar.tsx`: drop `SIDEBAR_WIDTH_PANEL` / `readWorkspaceUi` / `writeWorkspaceUi`
  usage for width; read/write `app.sidebar.width` directly; effect dep `[]`.
- `RightRail.tsx`: same for `rightRail.width` (`KV_WIDTH`); effect dep `[]`.
- `RightRailContext.tsx`: same for `rightRail.open` (`KV_OPEN`); effect dep `[]`;
  `setRailOpen` always writes the global key (drop the `wsId` branch).
- Active tab (`rightRail.tab`) is already global — untouched.

### B. Remove the per-workspace tint feature (color → universal)

Delete only the **workspace-chrome-tint** feature; leave generic "tint" styling
elsewhere intact. Each "tint" reference is verified before removal.

Remove:
- `app/useWorkspaceTint.ts` (+ `app/useWorkspaceTint.test.tsx`)
- `lib/workspace-tint.ts` (+ `lib/workspace-tint.test.ts`)
- `features/settings/WorkspaceTintSection.tsx` (+ `.test.tsx`)
- `WorkspaceTintMount` usage in `app/App.tsx`
- the `WorkspaceTintSection` usage in `features/settings/AppearanceTab.tsx`
- `.sl-chrome-tint` CSS rules in `src/index.css` (verify no other consumer)

Keep (generic "tint", not the chrome wash — verify each): `features/sidebar/use-workspace-colors.ts`
(sidebar workspace dots), `features/jorvis-assistant/Orb.tsx`, `components/ui/button.data.ts`,
`features/command-room/GitActivityStrip.tsx`, `features/notifications/NotificationDropdown.tsx`.

### C. Back-compat

No destructive cleanup. Orphaned `ui.<wsId>.{sidebar.width,rightRail.width,rightRail.open,tint}`
keys are simply ignored. On first load the global key wins; missing global key →
default (sidebar 240, rail 480, rail open). A user's sidebar width may load once from
a stale legacy global value — acceptable, not worth a migration. (Optional
seed-from-current-workspace is parked to wishlist, not built.)

## Components / boundaries

- `Sidebar.tsx` — owns sidebar width; after change, depends only on `kv['app.sidebar.width']`.
- `RightRail.tsx` — owns rail width; depends only on `kv['rightRail.width']`.
- `RightRailContext.tsx` — owns rail open/closed; depends only on `kv['rightRail.open']`.
- Tint feature — removed; `ThemeProvider` remains the sole color authority.

Each unit reads/writes one global kv key and no longer reacts to `activeWorkspaceId`
for that piece of state.

## Testing

- jsdom unit tests (`@vitest-environment jsdom` + `vi.hoisted` mocks): for each of the
  three components, assert it reads/writes the **global** key and that changing the
  active workspace id does **not** change the hydrated value (no per-`wsId` read).
- `AppearanceTab` no longer renders the tint section; remove dead tint tests.
- Full `vitest run` to catch mocked-sibling breakage.
- Gate: `tsc -b` + `vitest run` + lint + build in the worktree; full e2e deferred to CI.
- Live-verify in Electron (switch workspaces, watch chrome stay put) **only if the
  operator asks** — jsdom cannot prove the visual.

## Out of scope / parked (wishlist)

- Globalizing `ui.<wsId>.browser.cols` / `ui.<wsId>.memory.cols` (per-workspace
  content arrangement — staying scoped).
- One-time migration seeding the global keys from the current workspace's values.
- Fully-universal tool *content* (one shared browser / Jorvis) — explicitly declined.
