# 02 — Workspace routing: Settings → Workspace click stuck on Settings

**Severity**: P1
**Effort**: XS (~30min)
**Cluster**: State / routing
**Suggested delegate**: Sonnet (Claude Code)
**Depends on**: nothing — parallel-safe

## Context

v1.4.1 dogfood (commit `6e635db`, 2026-05-17). User report:

> When clicked to settings and tried to switch back to workspace via clicking to the Workspace from left panel not working, need to go to menu and click Command Room.

This is a v1.3.3 ship-claim regression (commit `66b4fa6 fix(ui): sidebar workspace click routes to Command Room`). The v1.3.3 fix removed the explicit `SET_ROOM='command'` follow-up from `Sidebar.tsx onPick` and added per-workspace room recall in the reducer. The recall correctly excludes `'workspaces'` (the launcher) but does NOT exclude `'settings'` (a global room) — so visiting Settings persists `roomByWorkspace[wsId] = 'settings'`, and the next workspace click replays the user into Settings.

## Repro

1. Open workspace; Command Room renders.
2. Click gear/Settings → `state.room = 'settings'`, SettingsRoom mounts.
3. Click the same (or any open) workspace row in the left sidebar.
4. **Expected**: lands on Command Room.
5. **Actual**: stays on Settings; only the top-bar room dropdown can route them back.

## File:line targets

| File | Line | Edit |
|---|---|---|
| `app/src/renderer/app/state.reducer.ts` | 91-102 (SET_ROOM writer) | Extend the `action.room !== 'workspaces'` guard so `'settings'` is also excluded from `roomByWorkspace`. New shape: `action.room !== 'workspaces' && action.room !== 'settings'` — or pull the list into a `const GLOBAL_ROOMS = ['workspaces', 'settings'] as const` for clarity. |
| `app/src/renderer/app/state.reducer.test.ts` | (new case) | Add `it('SET_ACTIVE_WORKSPACE_ID after Settings visit routes to Command Room')`: dispatch `SET_ACTIVE_WORKSPACE_ID(wsA) → SET_ROOM('settings') → SET_ACTIVE_WORKSPACE_ID(wsA)`; assert final `state.room === 'command'` and `state.roomByWorkspace[wsA]` is undefined or `'command'`. |

## Critical gotchas (from helper-verify Phase 1 audit)

1. **The "v1.3.3" tag in `state.reducer.ts` is misleading.** Commit `66b4fa6` only touched `Sidebar.tsx` (+11/-1). The reducer-side per-workspace recall logic at lines 188-198 was a separate later commit also tagged "v1.3.3". Do not assume a single commit owns both surfaces.
2. **DO NOT remove `Sidebar.tsx:62`'s `SET_ROOM: 'command'` dispatch.** It's load-bearing for the `openPersistedWorkspace` path (which goes through `WORKSPACE_OPEN`, not `SET_ACTIVE_WORKSPACE_ID`), so the reducer's `'command'` default at line 192 doesn't apply there. Removing it would break "re-open a previously opened workspace."
3. **`CommandRoom.tsx:182` is a THIRD `SET_ROOM` dispatch site** (`SET_ROOM: 'workspaces'`) that the v1.4.2 audit should be aware of, even though no fix is needed there. If you ever introduce more "global" rooms, make sure all three dispatch paths consistently respect the guard.

## Reusable utilities

None — pure reducer guard extension. Reuse the existing `'workspaces'` filter pattern at line 99 and line 192.

## Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec vitest run src/renderer/app/state.reducer.test.ts
pnpm exec vitest run                    # 368 baseline + 1 = 369
pnpm exec tsc -b --pretty false         # clean
pnpm exec eslint app/src/renderer/app/  # clean
```

**Manual smoke** (`pnpm electron:dev`):
1. Open a workspace; pane grid renders.
2. Click gear → Settings; verify Settings mounts.
3. Click the same workspace row in sidebar.
4. Land on Command Room (NOT Settings). Pane grid renders without intermediate hop.
5. Repeat with **another** open workspace row (cross-workspace switch); same expectation.

## Risks

R-02-1: Future "global" rooms (e.g. a Notifications center) will need the same guard. Suggest pulling `GLOBAL_ROOMS` into a typed const so future additions are a single-line append.

## Doc source

This brief replaces `docs/08-bugs/v1.4.2-workspace-routing-and-session-freeze.md` Bug A section. File deleted in bundle commit.
