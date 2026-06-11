# Pane Refit Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the restore-from-hidden terminal render glitch (duplicated/garbled text on pane minimise, fullscreen-restore, scratch-tab switch, and app-window minimize) plus the two documented #133 resize residuals.

**Architecture:** Extract `Terminal.tsx`'s 6-flag inline refit logic into a pure `RefitController` state machine (no DOM/xterm imports; effects injected). Two new transitions fix the bug: an immediate *reveal* (fit + `term.refresh` + `clearTextureAtlas`) when the observed rect goes 0×0 → non-zero (bypasses FitAddon's same-cols/rows no-op guard, which skips `_renderService.clear()` on every restore-at-same-size), and a `window:restored` main→renderer signal for app-window un-minimize (ResizeObserver never fires; occlusion throttling stales the WebGL frame). Main-side: flush the PTY coalescer before `pty.resize` (mirror of the P7 snapshot flush) and enable `reflowCursorLine`.

**Spec:** `docs/superpowers/specs/2026-06-11-pane-refit-controller-design.md` (committed `98905b2`). Two plan-time refinements: (1) Terminal.tsx subscribes to `window:restored` directly via `window.sigma.eventOn` — no use-live-events CustomEvent hop; (2) the controller cancels any pending debounce when the rect goes 0×0, fixing a latent footgun where a queued `fit.fit()` could run against a `display:none` container.

**Tech Stack:** TypeScript, React 18, xterm 6 (+fit 0.11, +webgl 0.19), Electron, vitest (+jsdom, fake timers).

**Verified context facts (don't re-derive):**
- `fit()` in `@xterm/addon-fit` no-ops (no `_renderService.clear()`, no resize) when proposed cols/rows equal current — verbatim from `node_modules/@xterm/addon-fit/lib/addon-fit.js`.
- All three pane-hide affordances apply `display:none` (`PaneShell.tsx:532` minimise body, `PaneGrid.tsx:306-312` fullscreen siblings, scratch-tab wrappers in `PaneShell.tsx:580,588`); the grid track sizes do not change, so restore always returns at the same pixel size.
- `sigma:pane-resize-start`/`-end` window events fire only from PaneGrid divider drags (`PaneGrid.tsx:215,244`) — keyboard nudge and mid-drag-unmount included. Do NOT touch PaneGrid/PaneDivider.
- `CacheEntry.webglAddon: WebglAddon | null` (`terminal-cache.ts:135`), held only while attached; `WebglAddon` has `clearTextureAtlas(): void`.
- Renderer event bridge: `window.sigma.eventOn(name, cb)` → preload validates against the `EVENTS` allowlist in `src/shared/rpc-channels.ts:366`.
- Main→renderer push from `electron/main.ts` uses `mainWindow.webContents.send(...)` (see the `app:session-restore` pattern at `electron/main.ts:633`).
- `rpc-router.ts:990-999` snapshot handler already flushes the coalescer; the resize handler at `:984-986` does not — that's the residual.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/src/renderer/features/command-room/refit-controller.ts` | Create | Pure refit state machine (hidden/first-fit/drag/debounce/reveal decisions) |
| `app/src/renderer/features/command-room/refit-controller.test.ts` | Create | Unit tests, fake timers, every transition |
| `app/src/renderer/features/command-room/Terminal.tsx` | Modify | Becomes a thin binding: RO + window events + sigma.eventOn → controller; `runFit`/`runReveal` callbacks |
| `app/src/renderer/features/command-room/Terminal.test.tsx` | Modify | sigma.eventOn registry stub; reveal/window-restored tests; existing guards must keep passing |
| `app/src/shared/rpc-channels.ts` | Modify | Add `'window:restored'` to `EVENTS` |
| `app/electron/main.ts` | Modify | Emit `window:restored` on BrowserWindow `restore`/`show` |
| `app/src/renderer/lib/terminal-cache.ts` | Modify | `reflowCursorLine: true` in `buildTerminalOptions` |
| `app/src/renderer/lib/terminal-cache.test.ts` | Modify | Assert the option via the existing `__ctorArg` capture |
| `app/src/main/rpc-router.ts` | Modify | Coalescer flush before `pty.resize` |
| `WISHLIST.md` (repo root) | Modify | Mark the two residuals shipped; add CC-Ink + 64KiB-cap notes |

All commands run from `app/` unless stated. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: RefitController state machine

**Files:**
- Create: `app/src/renderer/features/command-room/refit-controller.ts`
- Test: `app/src/renderer/features/command-room/refit-controller.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// app/src/renderer/features/command-room/refit-controller.test.ts
//
// Pane-refit spec 2026-06-11 — unit coverage for the RefitController state
// machine. Pure logic: no DOM, no xterm. Fake timers drive the debounce and
// drag-failsafe windows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefitController } from './refit-controller';

describe('RefitController', () => {
  let fit: ReturnType<typeof vi.fn>;
  let reveal: ReturnType<typeof vi.fn>;
  let ctrl: RefitController;

  beforeEach(() => {
    vi.useFakeTimers();
    fit = vi.fn();
    reveal = vi.fn();
    ctrl = new RefitController({ fit, reveal });
  });

  afterEach(() => {
    ctrl.dispose();
    vi.useRealTimers();
  });

  it('fits immediately and synchronously on the first non-zero rect', () => {
    ctrl.onContentRect(800, 600);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('ignores zero-size rects before the first fit (layout still settling)', () => {
    ctrl.onContentRect(0, 0);
    expect(fit).not.toHaveBeenCalled();
    ctrl.onContentRect(800, 600);
    expect(fit).toHaveBeenCalledTimes(1); // first fit, not a reveal
    expect(reveal).not.toHaveBeenCalled();
  });

  it('debounces subsequent visible resizes by 60ms (trailing)', () => {
    ctrl.onContentRect(800, 600); // first fit
    ctrl.onContentRect(700, 600);
    expect(fit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(59);
    expect(fit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it('coalesces rapid resizes into one trailing fit', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(790, 600);
    vi.advanceTimersByTime(30);
    ctrl.onContentRect(780, 600);
    vi.advanceTimersByTime(30);
    ctrl.onContentRect(770, 600);
    vi.advanceTimersByTime(60);
    expect(fit).toHaveBeenCalledTimes(2); // first + one trailing
  });

  it('going hidden (0×0) cancels a pending debounced fit', () => {
    // Latent footgun fix: a queued fit must never run against a
    // display:none container (proposeDimensions garbage).
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(700, 600); // schedules debounce
    ctrl.onContentRect(0, 0);     // hidden — must cancel it
    vi.advanceTimersByTime(120);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('reveals IMMEDIATELY (no debounce) on hidden → visible', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(0, 0);
    ctrl.onContentRect(800, 600); // restore at the SAME size
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1); // reveal is not a plain fit
  });

  it('reveals even while a divider drag is in flight', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart();
    ctrl.onContentRect(0, 0);
    ctrl.onContentRect(800, 600);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('suppresses visible-resize fits during a drag and fits once on drag end', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart();
    ctrl.onContentRect(750, 600);
    ctrl.onContentRect(720, 600);
    vi.advanceTimersByTime(120);
    expect(fit).toHaveBeenCalledTimes(1); // nothing mid-drag
    ctrl.onDragEnd();
    expect(fit).toHaveBeenCalledTimes(2); // exactly one, immediate
  });

  it('drag failsafe self-clears after 4s so refits can never freeze', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart(); // matching end never arrives
    vi.advanceTimersByTime(4000);
    ctrl.onContentRect(700, 600);
    vi.advanceTimersByTime(60);
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it('onDragStart cancels a pending debounced fit', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(700, 600); // schedules debounce
    ctrl.onDragStart();
    vi.advanceTimersByTime(120);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('window-restored reveals when visible', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onWindowRestored();
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('window-restored is a no-op while hidden or before the first fit', () => {
    ctrl.onWindowRestored(); // before first fit
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(0, 0);
    ctrl.onWindowRestored(); // hidden
    expect(reveal).not.toHaveBeenCalled();
  });

  it('dispose cancels all pending timers', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(700, 600); // pending debounce
    ctrl.onDragStart();           // pending failsafe
    ctrl.dispose();
    vi.advanceTimersByTime(5000);
    expect(fit).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/renderer/features/command-room/refit-controller.test.ts`
Expected: FAIL — `Cannot find module './refit-controller'` (or equivalent resolve error).

- [ ] **Step 3: Implement the controller**

```ts
// app/src/renderer/features/command-room/refit-controller.ts
//
// Pane-refit spec 2026-06-11 — the refit decision logic for a terminal pane,
// extracted from Terminal.tsx's mount effect so every transition is unit-
// testable without DOM/xterm. Terminal.tsx feeds it ResizeObserver rects and
// the divider-drag / window-restored signals; it decides WHEN to refit and
// whether a plain `fit` suffices or a forced `reveal` repaint is needed.
//
// Why `reveal` exists: @xterm/addon-fit's fit() no-ops entirely (no
// _renderService.clear(), no resize, no SIGWINCH) when the proposed cols/rows
// equal the current ones. Every pane-hide affordance (minimise, fullscreen
// siblings, scratch tabs) uses display:none and restores at the SAME pixel
// size, so a plain fit never repaints the stale WebGL frame over the buffer
// that kept receiving PTY bytes while hidden — the "duplicated/garbled text
// on restore" bug. A reveal = fit + full-viewport refresh + texture-atlas
// clear, bypassing the no-op guard.

export interface RefitCallbacks {
  /** Normal refit: atomic fit.fit() + deduped pty.resize (see Terminal.tsx). */
  fit(): void;
  /** Forced repaint for restore-from-hidden / window-restore: fit() PLUS
   *  term.refresh(0, rows-1) + webgl clearTextureAtlas(). */
  reveal(): void;
}

export interface RefitControllerOptions {
  /** Trailing debounce for non-drag visible resizes (VS Code uses 50ms). */
  debounceMs?: number;
  /** Self-clear for a missed pane-resize-end (release outside the window). */
  dragFailsafeMs?: number;
}

export class RefitController {
  private readonly cb: RefitCallbacks;
  private readonly debounceMs: number;
  private readonly dragFailsafeMs: number;

  private firstFitDone = false;
  /** True while the observed rect is 0×0 (pane display:none'd somewhere up
   *  the tree). The next non-zero rect is a restore → forced reveal. */
  private hidden = false;
  private dragging = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dragFailsafe: ReturnType<typeof setTimeout> | null = null;

  constructor(cb: RefitCallbacks, opts: RefitControllerOptions = {}) {
    this.cb = cb;
    this.debounceMs = opts.debounceMs ?? 60;
    this.dragFailsafeMs = opts.dragFailsafeMs ?? 4000;
  }

  onContentRect(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      // A queued fit must never run against a display:none container —
      // proposeDimensions() reads 0/garbage there.
      this.hidden = true;
      this.clearDebounce();
      return;
    }
    if (!this.firstFitDone) {
      this.firstFitDone = true;
      this.hidden = false;
      this.cb.fit();
      return;
    }
    if (this.hidden) {
      this.hidden = false;
      this.clearDebounce();
      // Immediate, even mid-drag: the un-hide is not drag geometry, and the
      // drag suppression would otherwise leave a stale frame visible for up
      // to the failsafe window.
      this.cb.reveal();
      return;
    }
    if (this.dragging) return;
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.cb.fit();
    }, this.debounceMs);
  }

  onDragStart(): void {
    this.dragging = true;
    this.clearDebounce();
    if (this.dragFailsafe) clearTimeout(this.dragFailsafe);
    this.dragFailsafe = setTimeout(() => {
      this.dragging = false;
      this.dragFailsafe = null;
    }, this.dragFailsafeMs);
  }

  onDragEnd(): void {
    this.dragging = false;
    this.clearFailsafe();
    this.clearDebounce();
    this.cb.fit();
  }

  /** Electron window un-minimize / re-show: the RO never fires (layout is
   *  unchanged) but occlusion throttling may have stalled WebGL frames. */
  onWindowRestored(): void {
    if (!this.firstFitDone || this.hidden) return;
    this.cb.reveal();
  }

  dispose(): void {
    this.clearDebounce();
    this.clearFailsafe();
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearFailsafe(): void {
    if (this.dragFailsafe) {
      clearTimeout(this.dragFailsafe);
      this.dragFailsafe = null;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/features/command-room/refit-controller.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/refit-controller.ts src/renderer/features/command-room/refit-controller.test.ts
git commit -m "feat(command-room): RefitController — testable refit state machine w/ reveal transition

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rewire Terminal.tsx through the controller (+ reveal repaint)

**Files:**
- Modify: `app/src/renderer/features/command-room/Terminal.tsx` (the mount `useEffect`, currently lines 111–265)
- Modify: `app/src/renderer/features/command-room/Terminal.test.tsx`

- [ ] **Step 1: Upgrade the sigma stub and fakeEntry in Terminal.test.tsx**

Replace the no-op `window.sigma` stub inside the existing `beforeEach` (currently lines 89–93) with a registry, and add an emit helper at module scope:

```ts
// At module scope, above beforeEach:
type SigmaCb = (payload: unknown) => void;
let sigmaHandlers: Map<string, Set<SigmaCb>>;
const emitSigma = (name: string, payload: unknown = {}) =>
  sigmaHandlers.get(name)?.forEach((fn) => fn(payload));
```

```ts
// Inside beforeEach, replacing the old no-op sigma stub:
  // window.sigma.eventOn registry — terminal-cache loads against it, and the
  // host now subscribes to 'window:restored' through it (pane-refit spec
  // 2026-06-11). emitSigma() drives those subscriptions in tests.
  sigmaHandlers = new Map();
  (globalThis as unknown as { sigma: unknown }).sigma = {
    eventOn: (name: string, cb: SigmaCb) => {
      let set = sigmaHandlers.get(name);
      if (!set) {
        set = new Set();
        sigmaHandlers.set(name, set);
      }
      set.add(cb);
      return () => {
        sigmaHandlers.get(name)?.delete(cb);
      };
    },
  };
```

Extend `fakeEntry` (currently lines 118–129) so reveal assertions are possible:

```ts
function fakeEntry(sessionId: string) {
  return {
    sessionId,
    terminal: {
      cols: 80,
      rows: 24,
      focus: vi.fn(),
      refresh: vi.fn(),
    },
    fitAddon: { fit: vi.fn() },
    ptyExited: false,
    webglAddon: null as null | { clearTextureAtlas: ReturnType<typeof vi.fn> },
  };
}
```

- [ ] **Step 2: Add the failing reveal tests to Terminal.test.tsx**

Append a new describe block (reuse the capturing-ResizeObserver pattern from the drag-suppression test at lines 318–368):

```ts
// Restore-from-hidden reveal (pane-refit spec 2026-06-11): every pane-hide
// affordance (minimise, fullscreen siblings, scratch tabs) is display:none and
// restores at the SAME pixel size, where fit.fit() no-ops (no renderer clear).
// The host must force a full repaint: fit + refresh(0, rows-1) + atlas clear.
describe('resize refit — restore-from-hidden reveal', () => {
  function captureRo() {
    let roCb: ResizeObserverCallback | null = null;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        roCb = cb;
      }
      observe(): void {/* no-op */}
      unobserve(): void {/* no-op */}
      disconnect(): void {/* no-op */}
    } as unknown as typeof ResizeObserver;
    return (width: number, height: number) =>
      roCb?.(
        [{ contentRect: { width, height } }] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
  }

  it('forces fit + refresh + atlas clear immediately when restored at the same size', async () => {
    const entry = fakeEntry('sess-RV');
    entry.webglAddon = { clearTextureAtlas: vi.fn() };
    getOrCreateTerminalMock.mockReturnValue(entry);
    const fireRo = captureRo();

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-RV" />);

    await act(async () => {
      fireRo(800, 600); // first fit
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireRo(0, 0);     // hidden (display:none)
      fireRo(800, 600); // restored at the SAME size
    });
    // Reveal is immediate — no 60ms debounce window with a stale frame.
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(entry.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(entry.webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it('reveals even while a divider drag is in flight', async () => {
    const entry = fakeEntry('sess-RV2');
    getOrCreateTerminalMock.mockReturnValue(entry);
    const fireRo = captureRo();

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-RV2" />);

    await act(async () => {
      fireRo(800, 600);
    });
    await act(async () => {
      window.dispatchEvent(new Event('sigma:pane-resize-start'));
    });
    await act(async () => {
      fireRo(0, 0);
      fireRo(800, 600);
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(entry.terminal.refresh).toHaveBeenCalledTimes(1);
  });

  it('repaints on window:restored while visible, ignores it while hidden', async () => {
    const entry = fakeEntry('sess-WR');
    getOrCreateTerminalMock.mockReturnValue(entry);
    const fireRo = captureRo();

    const { SessionTerminal } = await import('./Terminal');
    render(<SessionTerminal sessionId="sess-WR" />);

    await act(async () => {
      fireRo(800, 600);
    });
    await act(async () => {
      emitSigma('window:restored');
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(entry.terminal.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireRo(0, 0);
      emitSigma('window:restored'); // hidden pane — pane-level restore will handle it
    });
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run to verify the new tests fail (and old ones still pass)**

Run: `npx vitest run src/renderer/features/command-room/Terminal.test.tsx`
Expected: the 3 new tests FAIL (no reveal path yet); all pre-existing tests PASS (the stub upgrade is behavior-compatible).

- [ ] **Step 4: Rewrite the Terminal.tsx mount effect**

Add the import:

```ts
import { RefitController } from './refit-controller';
```

Replace the body of the mount `useEffect` (everything from `let debounceTimer` at line 128 through the `window.addEventListener('sigma:pane-resize-end', onResizeEndRefit);` at line 221 — keep the `ctx`/`getOrCreateTerminal`/`attachToHost` block above it and the `onFocusReq` block below it) with:

```ts
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
    // Forced repaint for restore-from-hidden / window-restore. fit.fit()
    // no-ops when cols/rows are unchanged — exactly the restore-at-same-size
    // case — so refresh the full viewport and drop the WebGL glyph atlas to
    // repaint the buffer that kept receiving PTY bytes while hidden.
    const runReveal = () => {
      if (entry.ptyExited) return;
      runFit();
      try {
        term.refresh(0, term.rows - 1);
        entry.webglAddon?.clearTextureAtlas();
      } catch {
        /* terminal may be mid-dispose */
      }
    };
    // WHEN to refit (hidden/first-fit/drag/debounce/reveal) lives in the
    // controller — see refit-controller.ts for the full rationale.
    const controller = new RefitController({ fit: runFit, reveal: runReveal });

    const ro = new ResizeObserver((entries) => {
      if (entry.ptyExited) return;
      const e = entries[0];
      if (!e) return;
      controller.onContentRect(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(container);

    // PaneGrid fires `sigma:pane-resize-start` on divider grab and
    // `sigma:pane-resize-end` on release (or keyboard nudge / mid-drag
    // unmount). Between them the controller suppresses per-frame refits and
    // refits exactly ONCE on release — one clean SIGWINCH at the final size.
    const onResizeStart = () => controller.onDragStart();
    const onResizeEnd = () => controller.onDragEnd();
    window.addEventListener('sigma:pane-resize-start', onResizeStart);
    window.addEventListener('sigma:pane-resize-end', onResizeEnd);

    // Pane-refit spec 2026-06-11 — app-window un-minimize / re-show never
    // fires the ResizeObserver (layout unchanged) while Chromium occlusion
    // throttling may have stalled WebGL frames; main emits this so every
    // visible terminal force-repaints.
    const offWindowRestored = window.sigma.eventOn('window:restored', () =>
      controller.onWindowRestored(),
    );
```

Update the effect cleanup: replace the two `clearTimeout` lines and the two resize-listener removals with:

```ts
    return () => {
      controller.dispose();
      try {
        ro.disconnect();
      } catch {
        /* observer may already be disconnected — ignore */
      }
      window.removeEventListener('sigma:pane-resize-start', onResizeStart);
      window.removeEventListener('sigma:pane-resize-end', onResizeEnd);
      offWindowRestored();
      window.removeEventListener('sigma:pty-focus', onFocusReq);
      // V1.4.2 packet-03 (Layer 2) — DO NOT dispose the cached terminal.
      // Park its DOM in the cache's offscreen container so the next mount
      // (room switch, workspace switch, or grid reshuffle) finds an intact
      // terminal with full scrollback and an uninterrupted live data
      // stream. Permanent disposal happens via `destroy(sessionId)` when
      // the user explicitly removes the pane (REMOVE_SESSION dispatch).
      detachFromHost(entry);
    };
```

Type note: `entry.webglAddon` and `term.refresh` come from the real `CacheEntry`/`Terminal` types — no type changes needed. If `window.sigma`'s type rejects `'window:restored'`, the global is declared with a `string` event name (check `rg -n "eventOn" src/renderer/types* src/renderer/*.d.ts`); it does not need widening.

- [ ] **Step 5: Run the full Terminal + controller suites**

Run: `npx vitest run src/renderer/features/command-room/`
Expected: ALL PASS — including the pre-existing renderer-clear regression guard (`fit.fit()` on `sigma:pane-resize-end`) and drag-suppression tests, unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/features/command-room/Terminal.tsx src/renderer/features/command-room/Terminal.test.tsx
git commit -m "fix(command-room): reveal repaint on restore-from-hidden — kill stale-frame dup text (minimise/fullscreen/scratch-tab)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `window:restored` signal (main → renderer)

**Files:**
- Modify: `app/src/shared/rpc-channels.ts` (EVENTS set, line ~366)
- Modify: `app/electron/main.ts` (`createWindow()`, after `setBroadcastTarget(mainWindow);` at line ~617)

No new unit test: this is 6 lines of Electron event glue with no logic to isolate (the receiving side is covered by Task 2's `window:restored` tests; `electron/main.ts` has no unit harness — verified by tsc + CI e2e + the operator smoke in Task 6).

- [ ] **Step 1: Add the event to the allowlist**

In `app/src/shared/rpc-channels.ts`, inside the `EVENTS` set, after the `'pty:link-detected'` entry add:

```ts
  // Pane-refit spec 2026-06-11 — emitted on BrowserWindow restore/show so
  // visible terminals force-repaint (the RO never fires for an un-minimize,
  // and occlusion throttling can stall WebGL frames while minimized).
  'window:restored',
```

- [ ] **Step 2: Emit from createWindow()**

In `app/electron/main.ts`, directly after `setBroadcastTarget(mainWindow);`:

```ts
  // Pane-refit spec 2026-06-11 — un-minimizing ('restore') or re-showing
  // ('show', e.g. macOS cmd+H un-hide) never fires the renderer's
  // ResizeObservers, while Chromium occlusion throttling may have stalled
  // WebGL frames; emit an explicit signal so terminals force a repaint.
  const emitWindowRestored = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:restored', {});
    }
  };
  mainWindow.on('restore', emitWindowRestored);
  mainWindow.on('show', emitWindowRestored);
```

- [ ] **Step 3: Typecheck + full renderer suite still green**

Run: `npx tsc -b && npx vitest run src/renderer/features/command-room/`
Expected: clean build, all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/rpc-channels.ts electron/main.ts
git commit -m "feat(electron): window:restored event on un-minimize/show — terminals repaint after occlusion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `reflowCursorLine: true` (#133 residual b)

**Files:**
- Modify: `app/src/renderer/lib/terminal-cache.ts` (`buildTerminalOptions`, line ~189)
- Modify: `app/src/renderer/lib/terminal-cache.test.ts`

- [ ] **Step 1: Write the failing assertion**

`terminal-cache.test.ts` already captures constructor options on the mocked XTerm as `__ctorArg` (see the mock at the top of the file). Add to the existing describe block that asserts cache-miss creation (locate the first test that inspects `createdTerms[0]`):

```ts
  it('enables reflowCursorLine so a column-shrink reflow includes the cursor line (#133 residual)', () => {
    // Use the same getOrCreateTerminal call pattern as the surrounding tests.
    const opts = createdTerms[0].__ctorArg as { reflowCursorLine?: boolean };
    expect(opts.reflowCursorLine).toBe(true);
  });
```

(Place it inside an existing test context where `createdTerms[0]` exists after a `getOrCreateTerminal` call — mirror the adjacent test's setup lines exactly.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: FAIL — `expected undefined to be true`.

- [ ] **Step 3: Add the option**

In `buildTerminalOptions` in `app/src/renderer/lib/terminal-cache.ts`, after `convertEol: true,`:

```ts
    // #133 residual (WISHLIST pane-rendering) — include the cursor line when
    // reflowing on a column shrink; the xterm default (false) skips it and
    // desyncs/overlaps the cursor row while a TUI streams. Watch Claude
    // Code's prompt redraw in the Task-6 operator smoke; one-line revert if
    // it misbehaves.
    reflowCursorLine: true,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/lib/terminal-cache.test.ts`
Expected: PASS. (If tsc rejects the key, the installed xterm 6 typings don't expose it yet — use `reflowCursorLine: true as ITerminalOptions['reflowCursorLine']` is NOT the fix; instead check `node_modules/@xterm/xterm/typings/xterm.d.ts` for the exact option name and report back rather than casting blindly.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/terminal-cache.ts src/renderer/lib/terminal-cache.test.ts
git commit -m "fix(terminal): reflowCursorLine — cursor row included in shrink reflow (#133 residual)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Coalescer flush before `pty.resize` (#133 residual a)

**Files:**
- Modify: `app/src/main/rpc-router.ts` (resize handler, lines 984–986)

No new unit test: `rpc-router.ts` has no unit harness (registering the router needs the full deps graph), and the change is a 1-line mirror of the adjacent, already-shipped snapshot-handler flush at lines 990–999. Verified by tsc + the full gate + CI.

- [ ] **Step 1: Apply the edit**

Replace:

```ts
    resize: async (sessionId: string, cols: number, rows: number) => {
      pty.resize(sessionId, cols, rows);
    },
```

with:

```ts
    resize: async (sessionId: string, cols: number, rows: number) => {
      // #133 residual (WISHLIST pane-rendering) — broadcast coalesced-but-
      // unsent bytes BEFORE the PTY learns the new size. Main→renderer IPC is
      // ordered, so every byte produced at the OLD width lands in the
      // renderer before the first byte the app paints at the NEW width — no
      // mixed-width interleave around a resize. Twin of the snapshot-handler
      // flush below (2026-06-10 finding 5b).
      ptyDataCoalescer.flush(sessionId);
      pty.resize(sessionId, cols, rows);
    },
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/main/rpc-router.ts
git commit -m "fix(pty): flush data coalescer before resize — no mixed-width bytes around SIGWINCH (#133 residual)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full gate, WISHLIST update, operator smoke list

**Files:**
- Modify: `WISHLIST.md` (repo root — the `[pane-rendering]` entry)

- [ ] **Step 1: Full gate in main checkout**

Run (from `app/`): `npx tsc -b && npx eslint . && npx vitest run && npm run build`
Expected: all green. Do NOT run `npx playwright test` locally (operator rule — e2e runs in CI).

- [ ] **Step 2: Rewrite the WISHLIST `[pane-rendering]` entry**

Replace the entire `- **[pane-rendering] pane terminal text-reflow on resize — still not fully finished**` bullet (with its three sub-bullets) with:

```markdown
- **[pane-rendering] residual polish after the 2026-06-11 refit-controller fix** — the restore-from-hidden stale-frame bug (minimise/fullscreen/scratch-tab/window-minimize duplicated text) and both #133 residuals (coalescer flush before `pty.resize`; `reflowCursorLine: true`) SHIPPED via `docs/superpowers/specs/2026-06-11-pane-refit-controller-design.md`. Still open, all low:
  - **1-frame repaint flicker at drag release for a full-screen TUI** — the CLI's own redraw after SIGWINCH; likely NOT fixable our side.
  - **Upstream: Claude Code CLI duplicates scrollback frames on resize** (anthropics/claude-code #49086/#51828 — Ink cursor-up saturation). Our settle-debounce limits it to one SIGWINCH per gesture; if residual duplication is reported, recommend the user-side `"tui": "fullscreen"` Claude Code setting.
  - **Snapshot/live overlap dedup caps its scan at 64 KiB** (`terminal-cache.ts` MAX_OVERLAP_SCAN) — a >64 KiB pending burst at first-attach can double-write the overlap window. Bump or chunk-hash if duplicated text is ever reported ON FIRST ATTACH (not on resize).
  Trigger: only if re-reported after dogfooding the refit controller. Severity: low. Effort: S.
```

- [ ] **Step 3: Commit**

```bash
git -C .. add WISHLIST.md
git -C .. commit -m "docs(wishlist): pane-rendering — refit-controller fix shipped; remaining = upstream Ink dup + 64KiB dedup cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Operator smoke checklist (manual, post-merge — list in the PR body)**

With Claude Code streaming in a pane: ① minimise `–` → wait 10s → expand: text intact, no dup. ② fullscreen `⤢` another pane → wait → restore: hidden sibling intact. ③ scratch-tab away/back: intact. ④ minimize the APP window → wait → restore: intact. ⑤ divider drag while streaming: smooth, one settle. ⑥ `reflowCursorLine`: shrink columns while the Claude Code prompt is on screen — no cursor-row overlap.

---

## Self-Review (done at plan time)

- **Spec coverage:** controller+reveal (T1/T2), window-restored signal (T3), reflowCursorLine (T4), coalescer flush (T5), WISHLIST notes + smoke (T6). Spec's use-live-events bridge replaced by direct `sigma.eventOn` in Terminal — recorded as plan refinement in the header.
- **Type consistency:** `RefitCallbacks{fit,reveal}`, `onContentRect/onDragStart/onDragEnd/onWindowRestored/dispose` used identically in T1 tests, T1 impl, and T2 binding. `fakeEntry` adds `terminal.refresh` + `webglAddon` used by T2 tests.
- **No placeholders:** every code step carries the full code; the two untested glue changes (T3 main.ts, T5 router) explicitly state why and what covers them.
