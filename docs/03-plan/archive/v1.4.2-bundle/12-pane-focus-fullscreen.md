# 12 — Pane Focus → true fullscreen

**Severity**: Feature
**Effort**: M (~1d)
**Cluster**: Pane-grid Cluster A (after #03)
**Suggested delegate**: Opus (composes with #03 architecture)
**Depends on**: #03 (xterm preservation) MUST land first

## Context

Pane Focus icon is currently honest-labeled "Pin focus ring" (per `v1.2.5` commit `e193943`). The user wants real fullscreen: focused pane fills the Command Room viewport, other panes hidden but PTYs running, exit on Esc / icon click again.

## Why this depends on #03

If the focused pane unmounts on transition (current Approach 1), the user loses all output during the transition + has to wait for snapshot replay on un-focus. After #03's xterm preservation lands, the focused pane can transition in/out without remount cost.

If #03 ships Approach A (React 19 `<Activity>`), then #12 is implemented as: "fullscreen mode hides all non-focused panes via `<Activity mode='hidden'>` and gives the focused pane a different parent." If #03 ships Approach B (terminal-cache), #12 reuses the cache's reattach semantics with a different DOM parent.

## Implementation

### State

Add to `state.tsx`:
- `focusedPaneId: PaneId | null` in AppState
- Action: `FOCUS_PANE { paneId: PaneId }` / `UNFOCUS_PANE`
- Reducer toggles state. Persist? No — fullscreen is per-session, not per-workspace.

### Rendering

`GridLayout.tsx`:
- If `state.focusedPaneId === null`, render grid as today.
- If non-null, render ONLY the focused pane filling the viewport. All other panes: their containers stay mounted (via #03's mechanism) but `display: none` OR moved to an offscreen hidden parent.

### Triggers

- `PaneHeader.tsx` focus icon click → dispatch `FOCUS_PANE`.
- `Esc` keypress while focused → dispatch `UNFOCUS_PANE`. Use a global keydown listener gated by `focusedPaneId !== null`.
- Click outside the focused pane (e.g. workspace bar) → unfocus.

### Transitions

Optional CSS transition (e.g. 200ms scale-in). The focused pane's xterm must `fit()` to the new viewport size after the transition completes — reuse existing `Terminal.tsx:174-217` ResizeObserver.

## File:line targets

| File | Operation |
|---|---|
| `app/src/renderer/app/state.types.ts` | Add `focusedPaneId: PaneId \| null` |
| `app/src/renderer/app/state.reducer.ts` | Handle `FOCUS_PANE` / `UNFOCUS_PANE` |
| `app/src/renderer/features/command-room/GridLayout.tsx` | Branch on `focusedPaneId` for layout |
| `app/src/renderer/features/command-room/PaneHeader.tsx` | Wire focus icon onClick |
| `app/src/renderer/features/command-room/CommandRoom.tsx` | Global Esc keydown listener |
| `app/src/renderer/features/command-room/GridLayout.test.tsx` | New test: fullscreen mode renders only one pane |
| `tests/e2e/pane-focus.spec.ts` (NEW) | E2E: focus → no PTY loss → unfocus → grid restored |

## Verification

- Vitest: GridLayout test covers branch.
- Playwright: focus a streaming pane, verify other PTYs keep running (their session pids unchanged), unfocus, all panes show all output.
- Manual: focus while a swarm is mid-broadcast; non-focused panes' PTYs continue receiving the broadcast.

## Reusable utilities

- #03's terminal-preservation mechanism (Activity OR cache) — DO NOT bypass; the fullscreen transition must reuse it.
- Native `keydown` listener; cleanup on dispatch.

## Risks

- R-12-1: If a pane is fullscreen and the user closes the workspace, must auto-unfocus on workspace teardown. Handle in `WORKSPACE_CLOSE` reducer.
- R-12-2: Focus + Split (with #13) — what does "focus a split sub-pane" mean? Defer: focus operates on top-level panes only in v1.4.2; sub-pane focus is post-v1.5.

## Cross-references

- BACKLOG.md "Pane Focus → true fullscreen" (lines 354-359)
- WISHLIST line 76
- Original v1.2.5 honest-label commit `e193943`

## Pairs with

- #03 (depends on)
- #13 (don't merge until #13 is also done; they share `GridLayout.tsx` and `PaneHeader.tsx`)
