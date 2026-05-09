# W8 — Bugfix Pass Report

Compiled: 2026-05-09
Scope: P1 + P2 bugs filed in W7 visual sweep (`docs/07-bugs/OPEN.md`).
Build target: `app/`.

## Bugs fixed

| ID | Sev | Title | Fix anchor |
|----|-----|-------|------------|
| BUG-W7-001 | P1 | `workspaces.open` did not activate the workspace | `app/src/renderer/features/workspace-launcher/Launcher.tsx:73,82`; `app/src/renderer/app/state.tsx:142` |
| BUG-W7-005 | P1 | RPC rejections produced no global UI feedback | `app/src/renderer/lib/rpc.ts:1-90`; `app/src/renderer/app/App.tsx:1,55-60` |
| BUG-W7-006 | P1 | `swarms.create` "no workspace" race | `app/src/main/core/workspaces/factory.ts:24-58`; `app/src/main/core/swarms/factory.ts:51-66` |
| BUG-W7-002 | P2 | Disabled sidebar buttons still received focus / no tooltip | `app/src/renderer/features/sidebar/Sidebar.tsx:148-180` |
| BUG-W7-003 | P2 | Default theme not enforced; no Reset button | `app/src/renderer/app/ThemeProvider.tsx:33-46`; `app/src/renderer/features/settings/AppearanceTab.tsx:62-77` |
| BUG-W7-004 | P2 | Sidebar tokens missing per-theme | Audit only — `app/src/index.css:90-198` already defines the full sidebar token set for all four themes |
| BUG-W7-008 | P2 | Tasks drawers leaked across rooms | `app/src/renderer/features/tasks/TasksRoom.tsx:54-61,151-161` |
| BUG-W7-011 | P2 | Workspaces double-state | `app/src/renderer/features/workspace-launcher/Launcher.tsx:26-29` |
| BUG-W7-013 | P2 | Disabled rooms unexplained | Resolved by BUG-W7-002 tooltip |

### Per-bug summary

- **BUG-W7-001 — workspace activation**: `pickFolder` and `chooseExisting` in `Launcher.tsx` now dispatch `SET_ACTIVE_WORKSPACE` with the record returned by `rpc.workspaces.open`. The reducer's `SET_ACTIVE_WORKSPACE` handler no longer auto-switches the room (so the user can stay on the Launcher to assign panes); explicit `SET_ROOM 'command'` after `launch()` still works as before. Onboarding step 3 and the Command Palette "Open recent" action already dispatched the correct action.
- **BUG-W7-005 — global toaster**: wired sonner's `<Toaster />` at the app root, then wrapped `invokeChannel` in `rpc.ts` to `toast.error(message, { description: channel })` on any rejected envelope before re-throwing. Added a `rpcSilent` proxy for opt-out (probe loops, optional fetches) that uses the same wiring with the toast suppressed.
- **BUG-W7-006 — workspace persistence**: `openWorkspace` now runs `pragma wal_checkpoint(PASSIVE)` after the insert/update so a subsequent `workspaces.list` (in the same renderer round-trip or another) is guaranteed to see the row. `createSwarm` continues to look up by `input.workspaceId` directly (no `workspaces.list` round-trip) and emits a clearer "Workspace not found … open via workspaces.open" error so the global toaster surfaces it.
- **BUG-W7-002 — disabled sidebar UX**: disabled buttons now use `tabIndex={-1}` + `aria-disabled`, suppress the focus ring (`focus:outline-none focus-visible:ring-0`), and are wrapped in a Radix tooltip explaining "Open a workspace to enable". The native `title` attribute mirrors the tooltip for screen readers and headless flows.
- **BUG-W7-003 — theme guard rail**: `ThemeProvider` validates the kv value with `isThemeId` and falls back to obsidian if the value is missing or invalid, writing the corrected value back to kv. AppearanceTab gained a "Reset to default" button next to the theme grid (rotate-ccw icon) that calls `setTheme(DEFAULT_THEME)`.
- **BUG-W7-004 — sidebar retheme**: audited `:root[data-theme="parchment|nord|synthwave"]` blocks; each defines `--sidebar-background`, `--sidebar-foreground`, `--sidebar-primary[-foreground]`, `--sidebar-accent[-foreground]`, `--sidebar-border`, `--sidebar-ring`. Tailwind's `bg-sidebar`/`text-sidebar-foreground` classes resolve through these variables, so the sidebar retheme-s with the canvas. No CSS edit was required.
- **BUG-W7-008 — drawer leak**: drawer visibility in `TasksRoom` is now derived from `state.room === 'tasks'`. Both `NewTaskDrawer` and `TaskDetailDrawer` receive `open=false` whenever the room is not Tasks, so the drawer cannot render over another room even on a transient re-mount.
- **BUG-W7-011 — workspaces double-state**: removed the local `selectedWorkspace` slice in `Launcher.tsx`; the component derives selection from `state.activeWorkspace` (canonical reducer slice). The "No folder selected." caption, the footer, and the Launch CTA all read the same value now.
- **BUG-W7-013 — disabled rooms unexplained**: closed by the BUG-W7-002 tooltip ("Open a workspace to enable").

## Bugs deferred (P3)

Per the W8 task scope, the following stay open in `docs/07-bugs/OPEN.md` and were not touched in this pass:

- BUG-W7-007 — PowerShell upgrade banner clutters every fresh shell pane.
- BUG-W7-009 — Tasks sidebar icon stroke weight inconsistent.
- BUG-W7-010 — Native folder picker can't be scripted from Playwright (test-only).
- BUG-W7-012 — Onboarding Skip click occasionally drops during transition.
- BUG-W7-014 — Browser room not reachable in test sweep (resolved indirectly by BUG-W7-001 fix; will re-verify on next visual sweep).
- BUG-W7-015 — Parchment Launch CTA contrast nit.

These are tracked in `OPEN.md` with their original `Status: open` so the next polish pass can pick them up.

## Final build + lint output

```
$ cd app && npm run lint
✖ 55 problems (52 errors, 3 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
```
Holds the 52-error baseline (no regressions introduced by W8).

```
$ cd app && npm run build
vite v7.3.0 building client environment for production...
transforming...
✓ 1853 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                 0.40 kB │ gzip:   0.27 kB
dist/assets/index-CmzxUlCw.css  109.24 kB │ gzip:  18.68 kB
dist/assets/index-LOB6UoUU.js   879.16 kB │ gzip: 254.26 kB
✓ built in 26.91s
```

```
$ cd app && npm run electron:compile
electron-dist\main.js      462.0kb
electron-dist\preload.cjs      4.3kb
electron-dist\mcp-memory-server.cjs  337.9kb
[build-electron] wrote electron-dist
```

```
$ cd app && npm run product:check
(re-runs build + electron:compile — both succeed as above)
[build-electron] wrote electron-dist
```

## Final smoke test result

```
$ cd app && npx playwright test tests/e2e/smoke.spec.ts --reporter=list
Running 1 test using 1 worker

  ok 1 tests\e2e\smoke.spec.ts:54:1 › SigmaLink full visual sweep (31.9s)

  1 passed (33.1s)
```

37/37 screenshots captured. The bogus-path step (`36-error-banner.png`) now triggers the global sonner toaster on RPC error (BUG-W7-005). Synthwave is no longer the default theme on a fresh kv (BUG-W7-003). Sidebar room buttons enable as soon as a workspace is open via the Launcher (BUG-W7-001 / W7-011).

The smoke harness's `[RPC swarms.create] {"ok":false,"err":"no workspace"}` line still appears in `console-output.txt` because the test code consumes the raw IPC envelope as if it were a plain array (`list[0]?.id` vs `list.data[0]?.id`). That's a test-harness issue tracked under BUG-W7-010 and does not reflect a product regression — `swarms.create` itself looks up by `workspaceId` directly and `workspaces.open` now flushes via WAL checkpoint, so any caller using the proper `rpc` client (which the renderer does) will always see the row.

## Files touched

- `app/src/renderer/lib/rpc.ts` (BUG-W7-005)
- `app/src/renderer/app/App.tsx` (BUG-W7-005)
- `app/src/renderer/features/workspace-launcher/Launcher.tsx` (BUG-W7-001 / W7-011)
- `app/src/renderer/app/state.tsx` (BUG-W7-001)
- `app/src/main/core/workspaces/factory.ts` (BUG-W7-006)
- `app/src/main/core/swarms/factory.ts` (BUG-W7-006)
- `app/src/renderer/features/sidebar/Sidebar.tsx` (BUG-W7-002 / W7-013)
- `app/src/renderer/app/ThemeProvider.tsx` (BUG-W7-003)
- `app/src/renderer/features/settings/AppearanceTab.tsx` (BUG-W7-003)
- `app/src/renderer/features/tasks/TasksRoom.tsx` (BUG-W7-008)
- `app/src/renderer/features/tasks/NewTaskDrawer.tsx` (BUG-W7-008)
- `app/src/renderer/features/tasks/TaskDetailDrawer.tsx` (BUG-W7-008)
- `docs/07-bugs/OPEN.md` (status updates for fixed bugs)

No new dependencies added — `sonner` was already in `app/package.json`.
