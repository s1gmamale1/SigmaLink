# Pane Content-Reflow Keystone Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop pane terminal text from ghosting/duplicating on resize by restoring the renderer clear that `runFit` dropped.

**Architecture:** Revert one function body in `Terminal.tsx` — swap the `proposeDimensions()+term.resize()` split back to xterm's atomic `fit.fit()`, which calls `_renderService.clear()` before resizing. Keep a PTY-IPC dedup guard so we only forward an actually-changed grid to the PTY. Everything else (ResizeObserver, 60ms debounce, `sigma:pane-resize-end` listener, CSS-var drag, WebGL renderer) is unchanged.

**Tech Stack:** React 19 + TypeScript, `@xterm/xterm@^6`, `@xterm/addon-fit@^0.11`, `@xterm/addon-webgl@0.19.0`, Vitest + jsdom, Electron.

**Branch:** `feat/bsp-pane-tiling` (= held PR #133; already contains the WebGL renderer `201659c`). Commit here — do NOT branch off main.

---

## Root Cause (Phase 1 — confirmed, do not re-investigate)

Commit `0805a6b` rewrote `Terminal.tsx`'s `runFit` from xterm's atomic `fit.fit()` to a manual `fit.proposeDimensions()` + `term.resize()`. `fit.fit()` internally does `_renderService.clear()` **before** `term.resize()`; the manual split **omitted that clear**. Without it, `term.resize()` leaves the renderer holding stale cells from the old geometry — with the WebGL renderer (added later in `201659c`) these are stale GPU glyph textures — and new content paints on top → **ghost / duplicated rows**.

- **Worst with Claude Code** because its full-screen TUI repaints only changed cells, so stale cells linger as ghosts.
- **Appears instantly on any resize** (operator-confirmed) → renderer-level, not buffer/streaming-specific → the clear is the keystone and is robust regardless of which xterm buffer is active.
- The split's stated justification ("skip fit()'s redundant `getBoundingClientRect`") is **false** — `proposeDimensions()` uses `getComputedStyle`, the same call `fit.fit()` makes. **Zero perf was gained by dropping the clear.**
- **Why 5 prior commits missed it:** `01f2194`/`3433fd8`/`5c3d1bb` all kept the broken `runFit` body; they tuned divider *feel*, never the buffer/render. `201659c` added WebGL for speed — "a bit better but not enough" — because the missing clear still ghosted.

**Scope decision (operator):** keystone only, then verify live. Secondary contributors (transient mid-drag refit, coalescer flush-on-resize, `reflowCursorLine`) are **out of scope for this pass** — layered only if ghosting survives the keystone (see Task 4 contingency).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/renderer/features/command-room/Terminal.tsx` | xterm host; `runFit` keeps the cell grid + PTY in sync on resize | Modify the `runFit` body + its lead comment + add `lastCols`/`lastRows` (lines ~128–150) |
| `src/renderer/features/command-room/Terminal.test.tsx` | Host-contract unit tests | Add one regression test asserting `fit.fit()` is the refit path |

No other files change. No new files.

---

## Task 1: Failing regression test — `fit.fit()` is the refit path

**Files:**
- Test: `src/renderer/features/command-room/Terminal.test.tsx` (append a new `describe` block at end of file, before the final closing — i.e. after line 281)

- [ ] **Step 1: Write the failing test**

Append this block to the end of `src/renderer/features/command-room/Terminal.test.tsx`:

```tsx
// Keystone regression guard (2026-06-09): the resize refit MUST go through
// xterm's atomic fit.fit(), which calls _renderService.clear() before resizing.
// A regression back to proposeDimensions()+term.resize() (no clear) re-introduces
// the resize "ghost / duplicated text" bug. See docs/superpowers/plans/
// 2026-06-09-pane-content-reflow-keystone.md.
describe('resize refit — renderer-clear regression guard', () => {
  it('refits via the atomic fit.fit() on sigma:pane-resize-end', async () => {
    const entry = fakeEntry('sess-R');
    getOrCreateTerminalMock.mockReturnValue(entry);

    const { rpc } = await import('@/renderer/lib/rpc');
    vi.mocked(rpc.pty.resize).mockClear();

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-R" />);

    // jsdom's ResizeObserver polyfill is a no-op, so no fit fires on mount.
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('sigma:pane-resize-end'));
    });

    // The release refit MUST call fit.fit() (clears the renderer, then resizes).
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(1);
    // First fit propagates the real grid to the PTY (lastCols/lastRows start -1).
    expect(rpc.pty.resize).toHaveBeenCalledWith('sess-R', 80, 24);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npx vitest run src/renderer/features/command-room/Terminal.test.tsx -t "atomic fit.fit"`

Expected: **FAIL.** The current `runFit` calls `fit.proposeDimensions()` (undefined on the mock → TypeError → caught → early return), so `fit.fit()` is never called and `rpc.pty.resize` is never called. Assertion error: `expected "spy" to be called 1 times, but got 0 times`.

---

## Task 2: Restore the renderer clear in `runFit`

**Files:**
- Modify: `src/renderer/features/command-room/Terminal.tsx:128-150`

- [ ] **Step 1: Replace the `runFit` block**

Find this exact block (lines ~128–150):

```tsx
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let didFirstFit = false;
    // Apply the container's proposed cols/rows to the terminal. Uses
    // proposeDimensions()+resize() instead of fit() to skip fit()'s redundant
    // getBoundingClientRect, and only resizes (the expensive buffer reflow +
    // pty IPC) when the char grid actually changed.
    const runFit = () => {
      if (entry.ptyExited) return;
      let dims: { cols: number; rows: number } | undefined;
      try {
        dims = fit.proposeDimensions();
      } catch {
        return;
      }
      if (!dims || !dims.cols || !dims.rows) return;
      if (dims.cols === term.cols && dims.rows === term.rows) return;
      try {
        term.resize(dims.cols, dims.rows);
      } catch {
        return;
      }
      void rpc.pty.resize(sessionId, dims.cols, dims.rows).catch(() => undefined);
    };
```

Replace it with:

```tsx
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let didFirstFit = false;
    // PTY-IPC dedup: only forward a resize to the PTY when the cell grid
    // actually changed. -1 sentinels guarantee the first fit propagates.
    let lastCols = -1;
    let lastRows = -1;
    // Refit via xterm's ATOMIC fit.fit(): it calls _renderService.clear()
    // BEFORE term.resize(), so the (WebGL) renderer drops the old-geometry
    // glyph cells instead of leaving them painted under the new frame. The
    // earlier proposeDimensions()+resize() split dropped that clear (commit
    // 0805a6b) and caused the resize "ghost / duplicated text" bug — worst
    // with full-screen TUIs like Claude Code that only repaint changed cells.
    // (The split's claimed win — "skip fit()'s redundant getBoundingClientRect"
    // — was false: proposeDimensions() uses getComputedStyle, same as fit().)
    const runFit = () => {
      if (entry.ptyExited) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const { cols, rows } = term;
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        void rpc.pty.resize(sessionId, cols, rows).catch(() => undefined);
      }
    };
```

- [ ] **Step 2: Run the test to verify it PASSES**

Run: `npx vitest run src/renderer/features/command-room/Terminal.test.tsx -t "atomic fit.fit"`
Expected: **PASS.**

- [ ] **Step 3: Run the whole Terminal test file (no other host test regressed)**

Run: `npx vitest run src/renderer/features/command-room/Terminal.test.tsx`
Expected: **PASS** — all host-contract + C-8 routeLinkClick tests still green.

---

## Task 3: Gate and commit

**Files:** none (verification + commit only)

- [ ] **Step 1: Typecheck + build (tsc covers the test file too)**

Run: `npm run build`
Expected: `tsc -b` clean, `vite build` succeeds, no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new eslint errors in `Terminal.tsx` / `Terminal.test.tsx`.

- [ ] **Step 3: Full unit suite (catch any cross-file fallout)**

Run: `npm run test`
Expected: green (modulo known under-load flakes — re-run a flagged file in isolation, do not react).

> DO NOT run `npx playwright test tests/e2e/` or `electron:dev` locally — it launches competing Electron windows that steal the operator's focus. e2e runs in CI (the PR e2e-matrix).

- [ ] **Step 4: Commit on the current branch (`feat/bsp-pane-tiling`)**

```bash
git add src/renderer/features/command-room/Terminal.tsx \
        src/renderer/features/command-room/Terminal.test.tsx \
        docs/superpowers/plans/2026-06-09-pane-content-reflow-keystone.md
git commit -m "fix(command-room): restore renderer clear on resize — kill ghost/duplicated terminal text

runFit dropped fit.fit()'s _renderService.clear() in 0805a6b (proposeDimensions+
term.resize split), leaving stale (WebGL) glyph cells painted under the new frame
on every resize. Revert to xterm's atomic fit.fit(); keep PTY-IPC dedup. The split's
claimed perf win was a no-op (proposeDimensions uses getComputedStyle, like fit())."
```

---

## Task 4: Live verification (operator) + contingency

**This is the keystone-first gate — do not layer further fixes until this is observed.**

- [ ] **Step 1: Operator drag-test (manual, real app)**

Operator: pull the branch, run a Claude Code session in a pane, drag the divider (slow + fast), resize the window, split/close panes. Confirm the terminal text no longer ghosts/duplicates.

- [ ] **Step 2A: If ghosting is GONE** → done. Update WISHLIST/memory: content-reflow RESOLVED via renderer-clear restore; un-hold PR #133 and merge (box-resize + WebGL + this keystone together).

- [ ] **Step 2B: If ghosting SURVIVES (any residual)** → return to systematic-debugging Phase 1 with the new observation, then layer ONE contributor at a time, each with its own failing test first:
  - **Transient mid-drag refit** (`grid-refit-timing`): gate the RO/debounce `runFit` behind a `sigma:pane-resize-start`→`-end` drag flag (with a self-clearing failsafe so a missed pointerup can't freeze refits). Files: `PaneGrid.tsx` (dispatch start), `Terminal.tsx` (skip RO refit while flagged).
  - **Coalescer flush-on-resize / before snapshot** (`pty-backend` H3 / `xterm-fit` H1): call `ptyDataCoalescer.flush(sessionId)` before `pty.resize` (`rpc-router.ts:989`) and before `pty.snapshot` (first-mount double-write). One-liners, low risk.
  - **`reflowCursorLine: true`** (`xterm-fit` H2): only if garble correlates with active streaming; has known side-effects on cursor-redraw programs — test against Claude Code's prompt explicitly. File: `terminal-cache.ts` `buildTerminalOptions`.

---

## Self-Review

- **Spec coverage:** the approved design (restore clear via `fit.fit()`, keep dedup, add regression test, on #133 branch, verify-then-layer) maps to Tasks 1–4. ✔
- **Placeholder scan:** all code blocks complete; commands exact with expected output. ✔
- **Type consistency:** `lastCols`/`lastRows` (number, init `-1`); `fit.fit()` exists on `FitAddon`; test uses existing `fakeEntry` (`fitAddon.fit` is a `vi.fn()`, `terminal.cols=80`/`rows=24`) and the existing `rpc.pty.resize` mock. ✔
