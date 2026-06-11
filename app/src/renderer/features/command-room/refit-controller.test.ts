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
});
