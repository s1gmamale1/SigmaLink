// app/src/renderer/features/command-room/refit-controller.test.ts
//
// Pane-refit spec 2026-06-11 — unit coverage for the RefitController state
// machine. Pure logic: no DOM, no xterm. Fake timers drive the debounce and
// drag-failsafe windows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefitController } from './refit-controller';

describe('RefitController', () => {
  let fit: ReturnType<typeof vi.fn<() => void>>;
  let reveal: ReturnType<typeof vi.fn<() => void>>;
  let ctrl: RefitController;

  beforeEach(() => {
    vi.useFakeTimers();
    fit = vi.fn<() => void>();
    reveal = vi.fn<() => void>();
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

  it('window-restored is suppressed during a drag (drag end refits instead)', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart();
    ctrl.onWindowRestored();
    expect(reveal).not.toHaveBeenCalled();
    ctrl.onDragEnd();
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it('goes inert after dispose — no callbacks from any input', () => {
    ctrl.onContentRect(800, 600);
    ctrl.dispose();
    ctrl.onContentRect(700, 600);
    ctrl.onDragStart();
    ctrl.onDragEnd();
    ctrl.onWindowRestored();
    vi.advanceTimersByTime(5000);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('drag end while hidden does not fit; the later restore reveals', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart();
    ctrl.onContentRect(0, 0);   // hidden mid-drag
    ctrl.onDragEnd();           // must NOT fit against display:none
    expect(fit).toHaveBeenCalledTimes(1);
    ctrl.onContentRect(800, 600);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('reveal-on-restore still works when the drag ended while hidden', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(0, 0);
    ctrl.onDragStart();
    ctrl.onDragEnd();
    expect(fit).toHaveBeenCalledTimes(1); // suppressed: hidden
    ctrl.onContentRect(800, 600);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1);
  });
});

// Live visual re-wrap during a drag (pane-refit follow-up 2026-06-11 #2):
// when a `dragFit` callback is provided, mid-drag rects drive a THROTTLED
// visual-only fit (xterm re-wraps, text tracks the box) while the full
// `fit` (which notifies the PTY) still waits for drag end — the app inside
// gets exactly one SIGWINCH per gesture (Ink dup budget unchanged).
// Without `dragFit`, mid-drag rects are skipped entirely (legacy behavior,
// covered by the suite above).
describe('RefitController — live drag re-wrap (dragFit)', () => {
  let fit: ReturnType<typeof vi.fn<() => void>>;
  let reveal: ReturnType<typeof vi.fn<() => void>>;
  let dragFit: ReturnType<typeof vi.fn<() => void>>;
  let ctrl: RefitController;

  beforeEach(() => {
    vi.useFakeTimers();
    fit = vi.fn<() => void>();
    reveal = vi.fn<() => void>();
    dragFit = vi.fn<() => void>();
    ctrl = new RefitController({ fit, reveal, dragFit });
  });

  afterEach(() => {
    ctrl.dispose();
    vi.useRealTimers();
  });

  it('calls dragFit immediately (leading) on the first mid-drag rect, not fit', () => {
    ctrl.onContentRect(800, 600); // first fit
    ctrl.onDragStart();
    ctrl.onContentRect(750, 600);
    expect(dragFit).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1); // only the first fit
  });

  it('throttles rapid mid-drag rects to leading + one trailing per cooldown', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart();
    ctrl.onContentRect(790, 600); // leading
    ctrl.onContentRect(780, 600); // within cooldown → pending
    ctrl.onContentRect(770, 600); // still pending
    expect(dragFit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(80); // cooldown expiry → trailing
    expect(dragFit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(200); // no further rects → no further calls
    expect(dragFit).toHaveBeenCalledTimes(2);
  });

  it('drag end cancels a pending trailing dragFit and performs the single full fit', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart();
    ctrl.onContentRect(790, 600); // leading
    ctrl.onContentRect(780, 600); // pending
    ctrl.onDragEnd();
    expect(fit).toHaveBeenCalledTimes(2); // first + release
    vi.advanceTimersByTime(500);
    expect(dragFit).toHaveBeenCalledTimes(1); // trailing never fired
  });

  it('going hidden mid-drag cancels pending dragFit; restore still reveals', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onDragStart();
    ctrl.onContentRect(790, 600); // leading
    ctrl.onContentRect(780, 600); // pending
    ctrl.onContentRect(0, 0);     // hidden
    vi.advanceTimersByTime(500);
    expect(dragFit).toHaveBeenCalledTimes(1);
    ctrl.onContentRect(780, 600); // restore mid-drag
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('never calls dragFit outside a drag or after dispose', () => {
    ctrl.onContentRect(800, 600);
    ctrl.onContentRect(700, 600); // visible resize → debounce path
    vi.advanceTimersByTime(120);
    expect(dragFit).not.toHaveBeenCalled();
    ctrl.onDragStart();
    ctrl.dispose();
    ctrl.onContentRect(650, 600);
    vi.advanceTimersByTime(500);
    expect(dragFit).not.toHaveBeenCalled();
  });
});
