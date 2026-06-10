# Pane refit controller — kill the restore-from-hidden render glitch

**Date:** 2026-06-11 · **Status:** approved approach (B), spec under operator review
**Symptom:** pane re-adjust / minimize → glitchy text, broken render, duplicated text (operator repro: pane minimise `–`, fullscreen `⤢`, divider drag, AND app-window minimize).

## Root cause (4-agent investigation, two independent traces converged)

1. **Restore-from-hidden no-op.** All three hide affordances (`PaneShell.tsx:532` minimise body, `PaneGrid.tsx:306-312` fullscreen siblings, scratch-tab switch) hide via `display:none`. On restore the pane returns at its exact pre-hide size, so `fit.fit()` hits FitAddon's internal guard (`rows===e.rows && cols===e.cols || (renderService.clear(), resize(...))`) → **no-op: no renderer clear, no resize, no SIGWINCH**. The PTY kept streaming into the buffer while hidden; the WebGL frame is stale; xterm repaints only dirty rows; full-screen TUIs repaint only on SIGWINCH → stale frame over diverged buffer = duplicated/garbled text. PR #133 only protected dimension-*changing* paths.
2. **Window-minimize variant.** ResizeObserver never fires (no layout change); Electron occlusion throttling stales the WebGL frame; nothing forces a repaint on restore.
3. **Mid-drag restore.** Un-hide while a divider drag is in flight → `inDividerDrag` suppresses the RO refit for up to 4 s.
4. **Documented #133 residuals** (WISHLIST.md:33-37, deferred with trigger "build when resize text-rendering roughness is reported again"): (a) `rpc-router.ts:985` resize handler never calls `ptyDataCoalescer.flush(sessionId)` before `pty.resize` → old-width bytes land after SIGWINCH; (b) `reflowCursorLine` unset in `buildTerminalOptions` → cursor line skipped during shrink-reflow while a TUI streams.
5. **Upstream (out of our control):** Claude Code CLI Ink renderer duplicates scrollback per resize (anthropics/claude-code #49086/#51828). Mitigated by settle-debounce + the user-side `"tui":"fullscreen"` CC setting. Documentation note only.

Verified NOT the cause: #133 mechanisms intact at HEAD (zero post-fix diffs to Terminal.tsx/PaneGrid.tsx); WebGL `onContextLoss` correctly wired since P7; no code bypasses `fit.fit()`.

## Design

### 1. `RefitController` — pure, unit-testable state machine (new file `src/renderer/features/command-room/refit-controller.ts`)

Extracts the 6-flag refit logic currently inlined in `Terminal.tsx`'s mount effect (`didFirstFit`, `debounceTimer`, `inDividerDrag`, `dragFailsafe`, `lastCols/lastRows` stay in the fit callback). No DOM, no xterm imports — effects injected:

```ts
interface RefitCallbacks {
  fit(): void;     // normal refit (fit.fit() + deduped pty.resize)
  reveal(): void;  // forced repaint: fit() + term.refresh(0, rows-1) + webgl.clearTextureAtlas()
}
class RefitController {
  constructor(cb: RefitCallbacks, opts?: { debounceMs?: number; dragFailsafeMs?: number });
  onContentRect(width: number, height: number): void;
  onDragStart(): void;
  onDragEnd(): void;
  onWindowRestored(): void;
  dispose(): void;
}
```

Internal state: `hidden` (last rect 0×0), `firstFitDone`, `dragging` (+failsafe timer), `debounceTimer`.

Transitions (existing behavior preserved exactly; NEW behavior marked):

| Input | State | Action |
|---|---|---|
| `onContentRect(0,0)` | any | mark hidden; cancel pending debounce |
| `onContentRect(w,h>0)` | `!firstFitDone` | `firstFitDone=true`; immediate `fit()` (sync first fit — unchanged) |
| `onContentRect(w,h>0)` | `hidden` | **NEW:** clear hidden; immediate `reveal()` — even while `dragging` (a reveal is not drag geometry; one call, no storm; fixes the mid-drag-restore hole) |
| `onContentRect(w,h>0)` | `dragging` | skip (refit on drag end — unchanged) |
| `onContentRect(w,h>0)` | visible | 60 ms trailing debounce → `fit()` (unchanged) |
| `onDragStart` | — | `dragging=true`; cancel debounce; arm 4 s failsafe (unchanged) |
| `onDragEnd` | — | clear dragging/failsafe/debounce; immediate `fit()` (unchanged) |
| `onWindowRestored` | visible | **NEW:** immediate `reveal()` (covers app-window minimize/occlusion — RO never fires) |
| `onWindowRestored` | hidden | no-op (pane-level restore will reveal) |
| failsafe fires | — | `dragging=false` (unchanged) |

`reveal()` runs refresh + `clearTextureAtlas()` unconditionally after `fit()`: if dims changed, fit already cleared (extra refresh is a cheap one-time op); if unchanged, the refresh/atlas-clear is the entire fix. Atlas re-rasterization happens once per reveal, never per-frame.

### 2. `Terminal.tsx` becomes a thin binding

- RO callback → `controller.onContentRect(w,h)` (keep the `entry.ptyExited` early-return in the callbacks, not the controller).
- `sigma:pane-resize-start/end` → `onDragStart/End` (event contract with PaneGrid unchanged).
- NEW `sigma:window-restored` window event → `onWindowRestored()`.
- `fit` callback = current `runFit` body verbatim (atomic `fit.fit()` + cols/rows-deduped `rpc.pty.resize`).
- `reveal` callback = `runFit()` then `term.refresh(0, term.rows - 1)` + `entry.webglAddon?.clearTextureAtlas()` (addon already exposed on the cache entry; null-safe for the DOM-renderer fallback).

### 3. Window-restored signal (main → renderer)

Main process: on `BrowserWindow` `'restore'` and `'show'`, send one IPC event; preload/renderer bridge dispatches `window.dispatchEvent(new CustomEvent('sigma:window-restored'))`. Wired through the existing main→renderer event channel (implementation locates the window-creation module; follow the existing push-event pattern — no new channel scheme).

### 4. Main-side residual fixes (the "re-adjust" half)

- `src/main/rpc-router.ts:985` (pty resize handler): `ptyDataCoalescer.flush(sessionId)` **before** `pty.resize(...)` — exact mirror of the snapshot-path flush added in P7 (both wishlist-named call sites now covered; sibling rule satisfied).
- `src/renderer/lib/terminal-cache.ts` `buildTerminalOptions`: add `reflowCursorLine: true`. One-line revert if the operator smoke against Claude Code's prompt misbehaves.

### 5. Explicitly out of scope (don't break others)

- Drag suppression design, CSS-var grid (`--pg-cols`), parking/attach/detach, WebGL load-at-attach timing — all verified working; untouched.
- Claude Code Ink upstream dup bug → WISHLIST note + recommend `"tui":"fullscreen"` in CC settings if residual dup remains after our fixes.
- Snapshot dedup 64 KiB overlap-scan cap (first-attach path, different symptom) → WISHLIST note.
- Unmount-on-hide (Approach C) rejected: remount churn risks known overlay/focus/scroll regressions.

## Error handling

- `reveal()` wraps `refresh`/`clearTextureAtlas` in try/catch (terminal may be mid-dispose); `fit()` keeps its existing try/catch.
- Controller `dispose()` cancels both timers; binding calls it in the effect cleanup (replaces today's manual timer cleanup).
- Failsafe semantics unchanged: a missed `pane-resize-end` can never freeze refits.

## Testing

- **NEW `refit-controller.test.ts`** (fake timers, pure unit): first-fit immediate · hide cancels debounce · reveal immediate on restore, including mid-drag · drag suppress + end-refit · failsafe expiry · window-restored visible vs hidden · dispose cancels timers · debounce coalescing.
- **`Terminal.test.tsx`** (existing, extended): RO 0×0 → no fit; hide→restore → `refresh` + `clearTextureAtlas` called; `sigma:window-restored` → reveal; `ptyExited` guard preserved; event-listener cleanup.
- **Main-side:** rpc-router test asserting coalescer flush ordered before `pty.resize` (existing mock patterns; no real better-sqlite3/PTY).
- **Gate:** `tsc -b` + eslint + vitest + build in MAIN; e2e via CI e2e-matrix (no local e2e — operator rule).
- **Operator smoke:** minimise→restore, fullscreen→restore, window-minimize→restore, divider drag while Claude Code streams; plus `reflowCursorLine` behavior on the CC prompt.

## Files touched

| File | Change |
|---|---|
| `src/renderer/features/command-room/refit-controller.ts` | NEW — state machine |
| `src/renderer/features/command-room/refit-controller.test.ts` | NEW — unit tests |
| `src/renderer/features/command-room/Terminal.tsx` | slim mount effect to a binding |
| `src/renderer/features/command-room/Terminal.test.tsx` | extend |
| `src/renderer/lib/terminal-cache.ts` | `reflowCursorLine: true` |
| `src/main/rpc-router.ts` | coalescer flush before resize |
| main window module + preload bridge | `sigma:window-restored` signal |
| `WISHLIST.md` | clear resolved residuals; add CC-Ink + 64 KiB-cap notes |
