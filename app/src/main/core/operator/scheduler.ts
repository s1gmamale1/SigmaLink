// P1b Task 3 — the wake scheduler: the safety heart of mission autonomy.
// Task 2's watcher (and any future caller — the decomposer, a review agent)
// calls `enqueue('review'|'decompose', missionId, taskId?)`; this module
// decides IF and WHEN a wake actually spends a model turn (`runWake`). Four
// hard caps, checked in order, stop the autonomous loop from draining the
// operator's Claude sub: an enabled flag, the control-plane kill-switch,
// quiet hours, and a per-day wake budget. PURE + DI — no DB/model imports;
// `runWake`, `kvGet`/`kvSet`, `now()`, and `isFrozen` are all injected so
// every gate is deterministically testable (see scheduler.test.ts).
//
// `enabled`/quiet-hours/the budget cap are this module's OWN config
// namespace (`missions.autonomy.*`), so they're read straight off the
// injected `kvGet` — no extra indirection. `isFrozen` stays a DI'd callback
// because it's a FOREIGN subsystem (the External Control MCP kill-switch,
// `control.mcp.frozen` — see `../control/control-config.ts`); this module has
// no business knowing that KV key, and the same DI shape already wires
// `ControlMcpHost.isFrozen` in `rpc-router.ts` (`() => isControlFrozen(controlKv)`).

// P2 Task 7 — 'postmortem' is the third wake kind: fired after a mission
// completes (or a task auto-blocks at MAX_ATTEMPTS) so the brain distills
// the run into a durable memory (see supervisor.ts's runPostmortem +
// directive.ts's buildPostmortemDirective). It rides these exact same four
// gates — no scheduler special-casing — a postmortem wake is just another
// entry in the queue.
export type WakeKind = 'decompose' | 'review' | 'postmortem';

export interface Wake {
  kind: WakeKind;
  missionId: string;
  taskId?: string;
}

export type WakeDropReason = 'disabled' | 'frozen' | 'quiet-hours' | 'budget-exhausted';

export interface WakeSchedulerDeps {
  /** Spend a model turn on a wake. A throw/rejection is swallowed — no budget spent, the lock is released, and the drain loop keeps going. */
  runWake: (wake: Wake) => Promise<void>;
  kvGet: (key: string) => string | null;
  kvSet: (key: string, value: string) => void;
  /** Injected clock — deterministic quiet-hours checks and day-key rollover in tests. */
  now: () => number;
  /** Control-plane kill-switch (foreign KV namespace — DI'd, never read via kvGet here). */
  isFrozen: () => boolean;
  /** Override for the daily cap. Falls back to KV `missions.autonomy.dailyBudget`, then DEFAULT_DAILY_BUDGET. */
  dailyBudget?: number;
  /** Observability hook fired whenever a gate drops a wake. Never throws out of the drain loop. */
  onDropped?: (wake: Wake, reason: WakeDropReason) => void;
}

export interface WakeScheduler {
  enqueue(kind: WakeKind, missionId: string, taskId?: string): void;
  wakesSpentToday(): number;
}

const KV_ENABLED = 'missions.autonomy.enabled';
const KV_QUIET_HOURS = 'missions.autonomy.quietHours';
const KV_DAILY_BUDGET = 'missions.autonomy.dailyBudget';
const KV_SPENT_PREFIX = 'missions.autonomy.wakesSpent.';
const DEFAULT_DAILY_BUDGET = 20;

export function createWakeScheduler(deps: WakeSchedulerDeps): WakeScheduler {
  const { runWake, kvGet, kvSet, now, isFrozen, onDropped } = deps;

  const queue: Wake[] = [];
  let runningWake: Wake | null = null;
  let draining = false;

  function dateKey(): string {
    return new Date(now()).toISOString().slice(0, 10);
  }

  function spentKey(): string {
    return `${KV_SPENT_PREFIX}${dateKey()}`;
  }

  function wakesSpentToday(): number {
    const raw = kvGet(spentKey());
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function effectiveDailyBudget(): number {
    if (typeof deps.dailyBudget === 'number' && Number.isFinite(deps.dailyBudget) && deps.dailyBudget >= 0) {
      return deps.dailyBudget;
    }
    const raw = kvGet(KV_DAILY_BUDGET);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
  }

  function isEnabled(): boolean {
    return kvGet(KV_ENABLED) === '1';
  }

  // "22-8" → active when hour >= 22 OR hour < 8 (wraps midnight).
  // "1-5"  → active when hour >= 1 AND hour < 5 (same-day range).
  // Malformed/empty/degenerate (start === end) → never quiet — a bad KV
  // value must fail open, not silently wedge autonomy shut.
  function isQuietHours(): boolean {
    const raw = kvGet(KV_QUIET_HOURS);
    if (!raw) return false;
    const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw);
    if (!m) return false;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 0 || start > 23 || end < 0 || end > 23 || start === end) return false;
    const hour = new Date(now()).getHours();
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  function checkGates(): WakeDropReason | null {
    if (!isEnabled()) return 'disabled';
    if (isFrozen()) return 'frozen';
    if (isQuietHours()) return 'quiet-hours';
    if (wakesSpentToday() >= effectiveDailyBudget()) return 'budget-exhausted';
    return null;
  }

  function isDuplicateReview(kind: WakeKind, taskId?: string): boolean {
    if (kind !== 'review' || !taskId) return false;
    if (runningWake?.kind === 'review' && runningWake.taskId === taskId) return true;
    return queue.some((w) => w.kind === 'review' && w.taskId === taskId);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const wake = queue.shift()!;
        const dropReason = checkGates();
        if (dropReason) {
          onDropped?.(wake, dropReason);
          continue;
        }
        runningWake = wake;
        try {
          await runWake(wake);
          kvSet(spentKey(), String(wakesSpentToday() + 1));
        } catch {
          // A throwing/rejecting runWake must never crash the drain loop or
          // wedge the global lock — treat it like a dropped wake (no budget
          // spent) and keep draining the rest of the queue.
        } finally {
          runningWake = null;
        }
      }
    } finally {
      draining = false;
    }
  }

  function enqueue(kind: WakeKind, missionId: string, taskId?: string): void {
    if (isDuplicateReview(kind, taskId)) return;
    queue.push({ kind, missionId, taskId });
    void drain();
  }

  return { enqueue, wakesSpentToday };
}
