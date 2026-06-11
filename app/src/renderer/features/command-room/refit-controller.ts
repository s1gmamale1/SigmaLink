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
  /** OPTIONAL live drag re-wrap: fit.fit() ONLY — xterm re-wraps the buffer
   *  so text tracks the moving box, but the PTY is NOT notified. The single
   *  SIGWINCH still happens at drag end via `fit` (Claude Code's Ink
   *  renderer appends a duplicate transcript frame per SIGWINCH — upstream
   *  anthropics/claude-code#49086 — so the mid-drag storm must never come
   *  back). When absent, mid-drag rects are skipped entirely. */
  dragFit?(): void;
}

export interface RefitControllerOptions {
  /** Trailing debounce for non-drag visible resizes — 60ms, slightly above VS Code's 50ms. */
  debounceMs?: number;
  /** Self-clear for a missed pane-resize-end (release outside the window). */
  dragFailsafeMs?: number;
  /** Leading+trailing throttle for the live drag re-wrap. */
  dragFitThrottleMs?: number;
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
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dragFailsafe: ReturnType<typeof setTimeout> | null = null;
  /** Throttle cooldown for the live drag re-wrap (leading call armed it). */
  private dragFitCooldown: ReturnType<typeof setTimeout> | null = null;
  /** A rect arrived during the cooldown → one trailing dragFit at expiry. */
  private dragFitPending = false;
  private readonly dragFitThrottleMs: number;

  constructor(cb: RefitCallbacks, opts: RefitControllerOptions = {}) {
    this.cb = cb;
    this.debounceMs = opts.debounceMs ?? 60;
    this.dragFailsafeMs = opts.dragFailsafeMs ?? 4000;
    this.dragFitThrottleMs = opts.dragFitThrottleMs ?? 80;
  }

  onContentRect(width: number, height: number): void {
    if (this.disposed) return;
    if (width <= 0 || height <= 0) {
      // A queued fit must never run against a display:none container —
      // proposeDimensions() reads 0/garbage there.
      this.hidden = true;
      this.clearDebounce();
      this.clearDragFit();
      // dragging/failsafe left intact: the drag is still live; reveal ignores it.
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
    if (this.dragging) {
      // Live visual re-wrap: text tracks the moving box (throttled,
      // leading + trailing). PTY notify still waits for drag end.
      if (!this.cb.dragFit) return;
      if (this.dragFitCooldown) {
        this.dragFitPending = true;
        return;
      }
      this.cb.dragFit();
      this.armDragFitCooldown();
      return;
    }
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.cb.fit();
    }, this.debounceMs);
  }

  onDragStart(): void {
    if (this.disposed) return;
    this.dragging = true;
    this.clearDebounce();
    if (this.dragFailsafe) clearTimeout(this.dragFailsafe);
    this.dragFailsafe = setTimeout(() => {
      this.dragging = false;
      this.dragFailsafe = null;
    }, this.dragFailsafeMs);
  }

  onDragEnd(): void {
    if (this.disposed) return;
    this.dragging = false;
    this.clearFailsafe();
    this.clearDebounce();
    // The release `fit` below supersedes any pending trailing re-wrap.
    this.clearDragFit();
    // No fit while hidden: the container is display:none (proposeDimensions
    // garbage) and the hidden→visible reveal will repaint on restore.
    if (this.hidden) return;
    this.cb.fit();
  }

  /** Electron window un-minimize / re-show: the RO never fires (layout is
   *  unchanged) but occlusion throttling may have stalled WebGL frames. */
  onWindowRestored(): void {
    // Skip mid-drag: onDragEnd refits at the final size anyway, and a full
    // reveal (refresh + atlas clear) is too heavy to land between drag frames.
    if (!this.firstFitDone || this.hidden || this.dragging || this.disposed) return;
    this.cb.reveal();
  }

  dispose(): void {
    this.disposed = true;
    this.clearDebounce();
    this.clearFailsafe();
    this.clearDragFit();
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

  private armDragFitCooldown(): void {
    this.dragFitCooldown = setTimeout(() => {
      this.dragFitCooldown = null;
      // Trailing call only while the drag is still live and visible; the
      // dragEnd/hidden/dispose paths clear the timer, this is belt-and-
      // suspenders against any future re-entry.
      if (this.dragFitPending && this.dragging && !this.hidden && !this.disposed) {
        this.dragFitPending = false;
        this.cb.dragFit?.();
        this.armDragFitCooldown();
      } else {
        this.dragFitPending = false;
      }
    }, this.dragFitThrottleMs);
  }

  private clearDragFit(): void {
    if (this.dragFitCooldown) {
      clearTimeout(this.dragFitCooldown);
      this.dragFitCooldown = null;
    }
    this.dragFitPending = false;
  }
}
