// P4.2 NTF-DIGEST — DailyScheduler. Fires a callback once per day at a local
// wall-clock HH:MM (opt-in once-daily summary notification).
//
// PURE Node: no electron, no DB. Dependency-injected `now()` + `setTimer`
// make it deterministic + unit-testable. The scheduler uses a self-re-arming
// `setTimeout` (NOT `setInterval`) so it recomputes the ms-until-next-fire on
// every tick — this stays correct across DST transitions and long sleeps
// (a `setInterval(24h)` would drift an hour at the spring/fall boundary and
// keep firing at the wrong wall-clock). The timer is `unref()`'d so it never
// keeps the process alive on its own; `shutdownRouter()` cancels it explicitly.

import { hhmmToMinutes } from '../../../shared/notification-prefs';

/** A handle that can be `.unref()`'d (Node timer) or a bare object (tests). */
export interface CancelableTimer {
  unref?: () => void;
}

export interface DailySchedulerDeps {
  /** The work to run when the configured local time arrives. May be async;
   *  rejections are swallowed so a failed fire never breaks the re-arm. */
  onFire: () => void | Promise<void>;
  /** Wall-clock source. Defaults to `() => new Date()`. Injected in tests. */
  now?: () => Date;
  /** Timer factory. Defaults to `setTimeout`. Returns a cancel handle that is
   *  passed back to `clearTimer`. Injected in tests to assert delays without
   *  real time. */
  setTimer?: (cb: () => void, ms: number) => CancelableTimer;
  /** Timer canceller. Defaults to `clearTimeout`. */
  clearTimer?: (handle: CancelableTimer) => void;
}

/** Compute ms from `now` until the next occurrence of local `hh:mm`.
 *  Always returns a strictly-positive delay (if the time already passed today,
 *  or is exactly now, it targets tomorrow) so a re-arm can never busy-loop. */
export function msUntilNextLocal(now: Date, hh: number, mm: number): number {
  const target = new Date(now.getTime());
  target.setHours(hh, mm, 0, 0);
  if (target.getTime() <= now.getTime()) {
    // Already passed today (or exactly now) — aim at tomorrow. Using
    // setDate(+1) lets the Date object resolve DST/month-end correctly.
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

export class DailyScheduler {
  private readonly onFire: () => void | Promise<void>;
  private readonly now: () => Date;
  private readonly setTimer: (cb: () => void, ms: number) => CancelableTimer;
  private readonly clearTimer: (handle: CancelableTimer) => void;

  private handle: CancelableTimer | null = null;
  /** The HH:MM currently armed, so a re-arm after a fire reuses it. */
  private armedHhMm: string | null = null;

  constructor(deps: DailySchedulerDeps) {
    this.onFire = deps.onFire;
    this.now = deps.now ?? (() => new Date());
    this.setTimer =
      deps.setTimer ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        t.unref();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Arm (or re-arm) for the next local `hhMm`. Cancels any prior timer first,
   *  so calling `schedule` repeatedly (e.g. when the operator changes the time
   *  in Settings) is safe and idempotent. A malformed `hhMm` cancels the
   *  scheduler (treated as "disabled") rather than throwing. */
  schedule(hhMm: string): void {
    this.cancel();
    const minutes = hhmmToMinutes(hhMm);
    if (minutes === null) {
      this.armedHhMm = null;
      return;
    }
    this.armedHhMm = hhMm;
    this.arm(Math.floor(minutes / 60), minutes % 60);
  }

  /** Cancel the pending timer. Safe to call when nothing is armed. */
  cancel(): void {
    if (this.handle !== null) {
      try {
        this.clearTimer(this.handle);
      } catch {
        /* a stubbed/expired handle must never break shutdown */
      }
      this.handle = null;
    }
    this.armedHhMm = null;
  }

  /** True while a timer is pending. */
  isArmed(): boolean {
    return this.handle !== null;
  }

  private arm(hh: number, mm: number): void {
    const delay = msUntilNextLocal(this.now(), hh, mm);
    this.handle = this.setTimer(() => {
      // Clear the spent handle BEFORE firing so re-entrancy is impossible and
      // an exception in `onFire` still leaves us re-armed below.
      this.handle = null;
      const hhMm = this.armedHhMm;
      try {
        const r = this.onFire();
        if (r && typeof (r as Promise<void>).then === 'function') {
          (r as Promise<void>).catch(() => undefined);
        }
      } catch {
        /* a failed fire must not break the re-arm */
      }
      // Re-arm for tomorrow. Re-read the originally-armed HH:MM and recompute
      // the delay fresh (DST-safe). If the scheduler was cancelled inside
      // `onFire`, `armedHhMm` is null and we stop.
      if (hhMm !== null && this.armedHhMm !== null) {
        this.arm(hh, mm);
      }
    }, delay);
  }
}
