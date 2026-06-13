# Agent-attention notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. CODE-EDITING subagents MUST be dispatched with `isolation: "worktree"`.

**Goal:** When a Claude Code / Codex pane asks a question or finishes a turn and idles, play a sound and make that workspace's sidebar row + the specific pane glow + flicker for ~10s, then settle to a static highlight that clears when the operator looks at it.

**Architecture:** Detect the single underlying state ("agent stopped working, now waiting for you") in the **main process** by scanning each session's sentinel-stripped PTY stream for a real terminal bell (OSC-aware) with an output-inactivity timer fallback (bell-deduped). Emit one transient `agent:attention` IPC event routed to the owning window. The renderer records attention in two `AppState` maps (per-workspace, per-session), drives a CSS glow class, plays a throttled cue, and clears attention on focus/visit. No DB rows, no OS notifications, no toast.

**Tech Stack:** Electron main (node-pty stream), TypeScript, React reducer state, Web-Audio sound engine, Tailwind/CSS keyframes, Vitest (+ jsdom for renderer).

**Spec:** `docs/superpowers/specs/2026-06-14-agent-attention-notifications-design.md`

**Implementation refinement vs spec:** the spec offered two flicker→settle mechanisms; this plan uses the **CSS-only variant** (a 10-iteration animation over a base "settled" box-shadow). After ~10s the animation ends and the element retains the base settled glow until the class is removed on focus-clear. This needs no per-row component extraction and no JS timer, and `prefers-reduced-motion` collapses the flicker to land on the settled glow instantly. (Known minor limitation: a repeat attention on an already-glowing row does not restart the flicker — acceptable for v1.)

**Detection feasibility:** the bell is the primary signal but unverified live (operator's no-local-app rule). Task 0 is an optional operator-run spike. **The code tasks do not depend on its outcome** — the idle timer is the guaranteed backstop and the bell scanner is harmless if a CLI never rings.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `app/src/main/core/pty/bell-scanner.ts` (new) | Count real BEL in a byte stream, ignore OSC-terminator BEL | 1 |
| `app/src/main/core/pty/idle-detector.ts` (new) | Per-session inactivity timer, bell-deduped, injected clock | 2 |
| `app/src/shared/rpc-channels.ts` | Add `agent:attention` to the `EVENTS` allowlist | 3 |
| `app/src/main/core/pty/attention-detector.ts` (new) | Compose bell + idle → one `emit(sessionId, reason)` per event | 4 |
| `app/src/main/rpc-router.ts` | Feed detector from `onData`, route `agent:attention`, cleanup on exit | 5 |
| `app/src/shared/notification-prefs.ts` | New `agent-attention` sound cue | 6 |
| `app/src/renderer/app/state.types.ts` + `state.reducer.ts` | Attention maps, `SET_ATTENTION`, clear-on-focus | 7 |
| `app/src/renderer/app/state-hooks/use-live-events.ts` | Subscribe `agent:attention`, dispatch, throttled sound | 8 |
| `app/src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts` | Remove spurious per-spawn ding | 9 |
| `app/src/index.css` | `.sl-attention` + `@keyframes sl-attention-flicker` | 10 |
| `app/src/renderer/features/sidebar/WorkspacesPanel.tsx` + `Sidebar.tsx` | Sidebar row glow | 11 |
| `app/src/renderer/features/command-room/PaneShell.tsx` | Pane glow | 12 |

All commands below assume cwd `app/` unless noted. Per-task gate: `npx vitest run <file>` then `npx tsc -b`. Final whole-branch gate (Task 13).

---

## Task 0 (OPTIONAL, operator-run): Confirm Claude/Codex emit a terminal bell

**Not run by code subagents** (it runs the real CLIs and burns usage). Informational only — does not block any code task.

- [ ] **Step 1: Write a throwaway PTY capture harness** (does NOT launch the SigmaLink app)

Create `app/scripts/bell-spike.mjs`:

```js
// Throwaway: spawn a CLI in a PTY, log whenever a real BEL (\x07) appears.
// Usage: node scripts/bell-spike.mjs claude   (or: codex)
import pty from 'node-pty';
const cmd = process.argv[2] ?? 'claude';
const p = pty.spawn(cmd, [], { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env });
let inOsc = false, prevEsc = false;
p.onData((d) => {
  process.stdout.write(d);
  for (const ch of d) {
    if (prevEsc) { prevEsc = false; if (ch === ']') { inOsc = true; continue; } if (ch === '\\') { inOsc = false; continue; } }
    if (ch === '\x1b') { prevEsc = true; continue; }
    if (ch === '\x07') { if (inOsc) inOsc = false; else process.stderr.write('\n>>> REAL BELL <<<\n'); }
  }
});
process.stdin.setRawMode?.(true);
process.stdin.on('data', (b) => p.write(b.toString()));
p.onExit(() => process.exit(0));
```

- [ ] **Step 2: Run it and exercise both transitions**

Run: `node scripts/bell-spike.mjs claude` — ask it a question that triggers a permission prompt, and let a turn finish. Watch for `>>> REAL BELL <<<`. Repeat with `codex`.
Expected: a real bell at turn-end and/or permission prompt. Record the result in the task notes.

- [ ] **Step 3: Delete the harness**

Run: `rm scripts/bell-spike.mjs`
Note the finding: if neither CLI rings, the idle timer (default 4s) is the sole signal — still correct, just slightly less precise.

---

## Task 1: BellScanner (pure, OSC-aware bell counter)

**Files:**
- Create: `app/src/main/core/pty/bell-scanner.ts`
- Test: `app/src/main/core/pty/bell-scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/main/core/pty/bell-scanner.test.ts
import { describe, expect, it } from 'vitest';
import { BellScanner } from './bell-scanner';

describe('BellScanner', () => {
  it('counts a lone BEL', () => {
    expect(new BellScanner().feed('\x07')).toBe(1);
  });

  it('counts a BEL embedded in text', () => {
    expect(new BellScanner().feed('done\x07next')).toBe(1);
  });

  it('ignores a BEL that terminates an OSC title sequence', () => {
    // ESC ] 0 ; title BEL  → the BEL is a String Terminator, not a bell
    expect(new BellScanner().feed('\x1b]0;my title\x07')).toBe(0);
  });

  it('counts a real BEL after an OSC sequence ends', () => {
    expect(new BellScanner().feed('\x1b]0;title\x07hey\x07')).toBe(1);
  });

  it('ignores an OSC terminator split across chunks', () => {
    const s = new BellScanner();
    expect(s.feed('\x1b]0;ti')).toBe(0);
    expect(s.feed('tle\x07')).toBe(0);
  });

  it('counts a real BEL that arrives in a later chunk after the OSC closed', () => {
    const s = new BellScanner();
    expect(s.feed('\x1b]0;t')).toBe(0);
    expect(s.feed('\x07\x07')).toBe(1); // first BEL closes OSC, second is real
  });

  it('handles OSC-8 hyperlink terminated by ST (ESC backslash) then a real BEL', () => {
    expect(new BellScanner().feed('\x1b]8;;http://x\x1b\\link\x07')).toBe(1);
  });

  it('returns 0 for plain text', () => {
    expect(new BellScanner().feed('no bells here')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/pty/bell-scanner.test.ts`
Expected: FAIL — cannot find module `./bell-scanner`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/main/core/pty/bell-scanner.ts
const ESC = '\x1b';
const BEL = '\x07';

/**
 * Counts REAL terminal bells (BEL, 0x07) in a PTY byte stream, ignoring any BEL
 * that terminates an OSC string (e.g. `ESC ] 0 ; title BEL` sets the window
 * title — that BEL is a String Terminator, not a bell). One instance per
 * session; state persists across chunks (an OSC string can split a chunk).
 */
export class BellScanner {
  private inOsc = false; // inside an `ESC ]` … string
  private prevEsc = false; // previous char was a bare ESC

  /** Feed one chunk; returns the number of real bells it contained. */
  feed(chunk: string): number {
    let bells = 0;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.prevEsc) {
        this.prevEsc = false;
        if (ch === ']') {
          this.inOsc = true;
          continue;
        }
        if (ch === '\\') {
          this.inOsc = false; // ST (ESC \) ends an OSC/string
          continue;
        }
        // any other ESC-x: not an OSC introducer — fall through
      }
      if (ch === ESC) {
        this.prevEsc = true;
        continue;
      }
      if (ch === BEL) {
        if (this.inOsc) this.inOsc = false; // BEL terminates the OSC string
        else bells++; // standalone BEL = real bell
        continue;
      }
    }
    return bells;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/pty/bell-scanner.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/core/pty/bell-scanner.ts app/src/main/core/pty/bell-scanner.test.ts
git commit -m "feat(notifications): OSC-aware terminal-bell scanner for agent-attention"
```

---

## Task 2: IdleDetector (per-session inactivity timer, bell-deduped)

**Files:**
- Create: `app/src/main/core/pty/idle-detector.ts`
- Test: `app/src/main/core/pty/idle-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/main/core/pty/idle-detector.test.ts
import { describe, expect, it, vi } from 'vitest';
import { IdleDetector } from './idle-detector';

function harness(idleMs = 4000) {
  let nowVal = 0;
  let pending: { fn: () => void; id: number } | null = null;
  let nextId = 1;
  const onIdle = vi.fn<(id: string) => void>();
  const det = new IdleDetector({
    idleMs: () => idleMs,
    dedupeMs: 6000,
    onIdle,
    now: () => nowVal,
    setTimer: (fn) => {
      const id = nextId++;
      pending = { fn, id };
      return id;
    },
    clearTimer: (h) => {
      if (pending?.id === h) pending = null;
    },
  });
  return {
    det,
    onIdle,
    advance: (ms: number) => {
      nowVal += ms;
    },
    fire: () => {
      const p = pending;
      pending = null;
      p?.fn();
    },
    hasPending: () => pending !== null,
  };
}

describe('IdleDetector', () => {
  it('fires onIdle after the idle timer elapses', () => {
    const h = harness();
    h.det.onData('s1');
    expect(h.hasPending()).toBe(true);
    h.advance(4000);
    h.fire();
    expect(h.onIdle).toHaveBeenCalledWith('s1');
  });

  it('re-arms on new data (only the latest timer fires)', () => {
    const h = harness();
    h.det.onData('s1');
    h.det.onData('s1'); // cancels the first, arms a fresh one
    h.advance(4000);
    h.fire();
    expect(h.onIdle).toHaveBeenCalledTimes(1);
  });

  it('a bell cancels the pending idle fire', () => {
    const h = harness();
    h.det.onData('s1');
    h.det.noteBell('s1');
    expect(h.hasPending()).toBe(false);
    h.fire(); // nothing pending
    expect(h.onIdle).not.toHaveBeenCalled();
  });

  it('suppresses idle within the dedupe window after a bell', () => {
    const h = harness();
    h.det.noteBell('s1'); // bell at now=0
    h.det.onData('s1'); // more data → re-arm
    h.advance(4000); // now=4000 (< 6000 dedupe)
    h.fire();
    expect(h.onIdle).not.toHaveBeenCalled();
  });

  it('fires idle once the dedupe window has passed since the last bell', () => {
    const h = harness();
    h.det.noteBell('s1'); // bell at now=0
    h.advance(7000); // now=7000
    h.det.onData('s1'); // arm
    h.advance(4000); // now=11000 (> 6000 since bell)
    h.fire();
    expect(h.onIdle).toHaveBeenCalledWith('s1');
  });

  it('forget() clears pending timers', () => {
    const h = harness();
    h.det.onData('s1');
    h.det.forget('s1');
    expect(h.hasPending()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/pty/idle-detector.test.ts`
Expected: FAIL — cannot find module `./idle-detector`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/main/core/pty/idle-detector.ts

export interface IdleDetectorOptions {
  /** Idle threshold in ms, read fresh each arm (so a KV change takes effect). */
  idleMs: () => number;
  /** Suppress an idle fire if a bell fired within this window (default 6000). */
  dedupeMs?: number;
  onIdle: (sessionId: string) => void;
  /** Injectable for tests. Defaults to setTimeout/clearTimeout/Date.now. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Per-session output-inactivity timer. `onData(id)` (re)arms; when a session
 * that was producing output goes silent for `idleMs`, `onIdle(id)` fires —
 * UNLESS a bell fired for that session within `dedupeMs` (the bell already
 * signalled attention). `noteBell(id)` records the bell and cancels the pending
 * idle fire.
 */
export class IdleDetector {
  private readonly timers = new Map<string, unknown>();
  private readonly lastBellAt = new Map<string, number>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private readonly dedupeMs: number;
  private readonly opts: IdleDetectorOptions;

  // NOTE: this project has TS `erasableSyntaxOnly` enabled — constructor
  // PARAMETER PROPERTIES (`constructor(private readonly opts…)`) are forbidden.
  // Declare the field above and assign it in the body.
  constructor(opts: IdleDetectorOptions) {
    this.opts = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? (() => Date.now());
    this.dedupeMs = opts.dedupeMs ?? 6000;
  }

  onData(sessionId: string): void {
    this.cancel(sessionId);
    const handle = this.setTimer(() => {
      this.timers.delete(sessionId);
      const bellAt = this.lastBellAt.get(sessionId) ?? Number.NEGATIVE_INFINITY;
      if (this.now() - bellAt > this.dedupeMs) this.opts.onIdle(sessionId);
    }, this.opts.idleMs());
    this.timers.set(sessionId, handle);
  }

  noteBell(sessionId: string): void {
    this.lastBellAt.set(sessionId, this.now());
    this.cancel(sessionId); // the bell already signalled — don't also idle-fire
  }

  forget(sessionId: string): void {
    this.cancel(sessionId);
    this.lastBellAt.delete(sessionId);
  }

  private cancel(sessionId: string): void {
    const handle = this.timers.get(sessionId);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.timers.delete(sessionId);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/pty/idle-detector.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/core/pty/idle-detector.ts app/src/main/core/pty/idle-detector.test.ts
git commit -m "feat(notifications): per-session idle detector with bell dedupe"
```

---

## Task 3: Add `agent:attention` to the EVENTS allowlist

**Files:**
- Modify: `app/src/shared/rpc-channels.ts` (the `EVENTS` set, ~L381–446)
- Test: `app/src/shared/rpc-channels.test.ts` (~L555 pattern)

- [ ] **Step 1: Write the failing test**

Add to `app/src/shared/rpc-channels.test.ts` (near the other EVENTS-allowlist guards, ~L555):

```ts
  /**
   * Agent-attention spec 2026-06-14 — 'agent:attention' must be in EVENTS or the
   * preload's isAllowedEvent() guard drops it and the renderer subscriber is a
   * silent no-op (no glow, no sound).
   */
  it('agent:attention is in EVENTS allowlist', () => {
    expect(EVENTS.has('agent:attention')).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/rpc-channels.test.ts -t "agent:attention"`
Expected: FAIL — `EVENTS.has('agent:attention')` is `false`.

- [ ] **Step 3: Add the event to the allowlist**

In `app/src/shared/rpc-channels.ts`, inside the `EVENTS` set (after `'pty:link-detected'`, ~L392), add:

```ts
  // Agent-attention spec 2026-06-14 — emitted when a pane's agent stops working
  // and is now waiting for the user (real terminal bell OR output-inactivity).
  // Routed to the owning window (session-scoped). Payload:
  // { sessionId, reason: 'bell' | 'idle', ts }.
  'agent:attention',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/rpc-channels.test.ts -t "agent:attention"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/rpc-channels.ts app/src/shared/rpc-channels.test.ts
git commit -m "feat(notifications): allowlist agent:attention IPC event"
```

---

## Task 4: AttentionDetector (compose bell + idle → emit)

**Files:**
- Create: `app/src/main/core/pty/attention-detector.ts`
- Test: `app/src/main/core/pty/attention-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/main/core/pty/attention-detector.test.ts
import { describe, expect, it, vi } from 'vitest';
import { AttentionDetector } from './attention-detector';

function harness(idleMs = 4000) {
  let nowVal = 0;
  let pending: { fn: () => void; id: number } | null = null;
  let nextId = 1;
  const emit = vi.fn<(id: string, reason: 'bell' | 'idle') => void>();
  const det = new AttentionDetector({
    idleMs: () => idleMs,
    dedupeMs: 6000,
    emit,
    now: () => nowVal,
    setTimer: (fn) => {
      const id = nextId++;
      pending = { fn, id };
      return id;
    },
    clearTimer: (h) => {
      if (pending?.id === h) pending = null;
    },
  });
  return {
    det,
    emit,
    advance: (ms: number) => {
      nowVal += ms;
    },
    fire: () => {
      const p = pending;
      pending = null;
      p?.fn();
    },
  };
}

describe('AttentionDetector', () => {
  it('emits a bell event on a real BEL', () => {
    const h = harness();
    h.det.feed('s1', 'done\x07');
    expect(h.emit).toHaveBeenCalledWith('s1', 'bell');
  });

  it('does NOT emit a bell for an OSC title terminator', () => {
    const h = harness();
    h.det.feed('s1', '\x1b]0;title\x07');
    expect(h.emit).not.toHaveBeenCalledWith('s1', 'bell');
  });

  it('emits an idle event after silence with no bell', () => {
    const h = harness();
    h.det.feed('s1', 'some output');
    h.advance(4000);
    h.fire();
    expect(h.emit).toHaveBeenCalledWith('s1', 'idle');
  });

  it('does not double-fire idle right after a bell (dedupe)', () => {
    const h = harness();
    h.det.feed('s1', 'output\x07'); // bell → emit('bell'), re-arms idle timer
    h.advance(4000); // now 4000 < 6000 dedupe
    h.fire();
    expect(h.emit).toHaveBeenCalledTimes(1); // only the bell
    expect(h.emit).toHaveBeenCalledWith('s1', 'bell');
  });

  it('forget() stops further events for a session', () => {
    const h = harness();
    h.det.feed('s1', 'output');
    h.det.forget('s1');
    h.fire();
    expect(h.emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/pty/attention-detector.test.ts`
Expected: FAIL — cannot find module `./attention-detector`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/src/main/core/pty/attention-detector.ts
import { BellScanner } from './bell-scanner';
import { IdleDetector } from './idle-detector';

export type AttentionReason = 'bell' | 'idle';

export interface AttentionDetectorOptions {
  idleMs: () => number;
  emit: (sessionId: string, reason: AttentionReason) => void;
  dedupeMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Per-session bell + idle attention detection. Feed the (sentinel-stripped) PTY
 * data stream; `emit` fires once per detected "agent is now waiting" event.
 */
export class AttentionDetector {
  private readonly scanners = new Map<string, BellScanner>();
  private readonly idle: IdleDetector;
  private readonly opts: AttentionDetectorOptions;

  // NOTE: TS `erasableSyntaxOnly` — no constructor parameter properties.
  constructor(opts: AttentionDetectorOptions) {
    this.opts = opts;
    this.idle = new IdleDetector({
      idleMs: opts.idleMs,
      dedupeMs: opts.dedupeMs,
      onIdle: (sessionId) => opts.emit(sessionId, 'idle'),
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      now: opts.now,
    });
  }

  feed(sessionId: string, data: string): void {
    let scanner = this.scanners.get(sessionId);
    if (!scanner) {
      scanner = new BellScanner();
      this.scanners.set(sessionId, scanner);
    }
    const bells = scanner.feed(data);
    if (bells > 0) {
      this.idle.noteBell(sessionId);
      this.opts.emit(sessionId, 'bell');
    }
    this.idle.onData(sessionId);
  }

  forget(sessionId: string): void {
    this.scanners.delete(sessionId);
    this.idle.forget(sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/pty/attention-detector.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/main/core/pty/attention-detector.ts app/src/main/core/pty/attention-detector.test.ts
git commit -m "feat(notifications): compose bell+idle into AttentionDetector"
```

---

## Task 5: Wire the detector into rpc-router and route `agent:attention`

**Files:**
- Modify: `app/src/main/rpc-router.ts` (the `SESSION_ROUTED_EVENTS` set ~L237; the `PtyRegistry` construction ~L519–549)

No new unit test: `rpc-router.ts` is DB-bound and not vitest-loadable (better-sqlite3 Electron ABI rule). Logic is covered by Task 4's tests; this task is verified by `tsc -b` + build.

- [ ] **Step 1: Add the event to `SESSION_ROUTED_EVENTS`**

In `app/src/main/rpc-router.ts` change (~L237):

```ts
const SESSION_ROUTED_EVENTS = new Set(['pty:data', 'pty:exit', 'pty:error', 'pty:link-detected']);
```
to:
```ts
const SESSION_ROUTED_EVENTS = new Set([
  'pty:data',
  'pty:exit',
  'pty:error',
  'pty:link-detected',
  'agent:attention', // route to the owning window (detached-window safe)
]);
```

- [ ] **Step 2: Import AttentionDetector**

Add with the other `./core/pty/...` imports near the top of `app/src/main/rpc-router.ts`:

```ts
import { AttentionDetector } from './core/pty/attention-detector';
```

- [ ] **Step 3: Construct the detector + idle-ms gate before `const pty = new PtyRegistry(`**

Insert immediately above the `const pty = new PtyRegistry(` line (~L541), mirroring the existing 2s-cached `shouldDetectLinks` gate:

```ts
  // Agent-attention (spec 2026-06-14) — bell + idle detection on the
  // sentinel-stripped data stream. Idle threshold is KV-tunable
  // (`notifications.idleMs`, default 4000ms), 2s-cached like the link gate.
  let idleMsGate = { value: 4000, at: 0 };
  const idleMs = (): number => {
    const now = Date.now();
    if (now - idleMsGate.at < 2_000) return idleMsGate.value;
    let value = 4000;
    try {
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get('notifications.idleMs') as { value?: string } | undefined;
      const n = row?.value == null ? Number.NaN : Number(row.value);
      if (Number.isFinite(n) && n >= 500) value = n;
    } catch {
      value = 4000;
    }
    idleMsGate = { value, at: now };
    return value;
  };
  const attentionDetector = new AttentionDetector({
    idleMs,
    emit: (sessionId, reason) =>
      broadcast('agent:attention', { sessionId, reason, ts: Date.now() }),
  });
```

- [ ] **Step 4: Feed the detector from `onData` and clean up on exit**

Change the `PtyRegistry` constructor's first two args. The `onData` arg (~L542):

```ts
    (sessionId, data) => ptyDataCoalescer.push(sessionId, data),
```
to:
```ts
    (sessionId, data) => {
      attentionDetector.feed(sessionId, data); // sentinel already stripped
      ptyDataCoalescer.push(sessionId, data);
    },
```

The `onExit` arg (~L543–549) — add `attentionDetector.forget(sessionId)` alongside the existing `forgetSession`:

```ts
    (sessionId, exitCode, signal) => {
      ptyDataCoalescer.flush(sessionId);
      broadcast('pty:exit', { sessionId, exitCode, signal });
      attentionDetector.forget(sessionId);
      // Multi-window A2 — evict the session→workspace routing cache AFTER the
      // exit event routes to the owner, so the final event still lands.
      getWindowRegistry().forgetSession(sessionId);
    },
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc -b`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/rpc-router.ts
git commit -m "feat(notifications): emit agent:attention from PTY stream, routed to owning window"
```

---

## Task 6: Add the `agent-attention` sound cue

**Files:**
- Modify: `app/src/shared/notification-prefs.ts` (`SoundCue` union ~L201, `SOUND_CATALOG` ~L248)
- Test: `app/src/shared/notification-prefs.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `app/src/shared/notification-prefs.test.ts`:

```ts
  it('includes the agent-attention alert cue', () => {
    const def = cueDef('agent-attention');
    expect(def).toBeDefined();
    expect(def?.category).toBe('alert');
    expect((def?.tones.length ?? 0)).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/notification-prefs.test.ts -t "agent-attention"`
Expected: FAIL — `cueDef('agent-attention')` is `undefined` (and a TS error on the literal until Step 3).

- [ ] **Step 3: Add the cue type + catalog entry**

In the `SoundCue` union (~L201), add the member:

```ts
export type SoundCue =
  | 'agent-done'
  | 'agent-attention'
  | 'agent-crash'
```

In `SOUND_CATALOG` (~L248), add a new entry after the `agent-done` block:

```ts
  {
    cue: 'agent-attention',
    label: 'Agent needs you',
    category: 'alert',
    // Soft two-note prompt (D5→G5) — gentler & distinct from the brighter
    // agent-done completion chime. Fires when an agent is waiting for input.
    tones: [
      { freq: 587.33, start: 0, duration: 0.12, peak: 0.14 },
      { freq: 783.99, start: 0.09, duration: 0.16, peak: 0.14 },
    ],
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/notification-prefs.test.ts`
Expected: PASS (the new test + the existing "every cue has a tone and category" iteration test still green).

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/notification-prefs.ts app/src/shared/notification-prefs.test.ts
git commit -m "feat(notifications): add agent-attention sound cue"
```

---

## Task 7: Renderer state — attention maps, SET_ATTENTION, clear-on-focus

**Files:**
- Modify: `app/src/renderer/app/state.types.ts` (AppState ~L73, Action ~L160, `initialAppState` ~L272)
- Modify: `app/src/renderer/app/state.reducer.ts` (new helper + `SET_ATTENTION`, `SET_ACTIVE_SESSION` ~L428, `SET_ACTIVE_WORKSPACE_ID` ~L346, `SET_ACTIVE_WORKSPACE` ~L402)
- Test: `app/src/renderer/app/state.reducer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `app/src/renderer/app/state.reducer.test.ts` (import `initialAppState` from `./state.types` if not already; the file already imports the reducer + state — match existing imports):

```ts
describe('agent-attention', () => {
  const wsId = 'ws-1';
  const sid = 'sess-1';
  function seeded(): AppState {
    // a session so SET_ATTENTION can derive the workspace
    return appStateReducer(
      { ...initialAppState, openWorkspaces: [{ id: wsId, name: 'W', rootPath: '/w' } as any] },
      { type: 'ADD_SESSIONS', sessions: [{ id: sid, workspaceId: wsId, providerId: 'claude', status: 'running' } as any] },
    );
  }

  it('SET_ATTENTION marks both the session and its workspace', () => {
    const s = appStateReducer(seeded(), { type: 'SET_ATTENTION', sessionId: sid, ts: 1000 });
    expect(s.attentionSessions[sid]).toBe(1000);
    expect(s.attentionWorkspaces[wsId]).toBe(1000);
  });

  it('SET_ACTIVE_SESSION clears that session\'s attention', () => {
    let s = appStateReducer(seeded(), { type: 'SET_ATTENTION', sessionId: sid, ts: 1000 });
    s = appStateReducer(s, { type: 'SET_ACTIVE_SESSION', id: sid });
    expect(s.attentionSessions[sid]).toBeUndefined();
  });

  it('SET_ACTIVE_WORKSPACE_ID clears that workspace\'s attention', () => {
    let s = appStateReducer(seeded(), { type: 'SET_ATTENTION', sessionId: sid, ts: 1000 });
    s = appStateReducer(s, { type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: wsId });
    expect(s.attentionWorkspaces[wsId]).toBeUndefined();
  });
});
```

(Use the same `appStateReducer`/`initialAppState`/`AppState` import names already present at the top of the test file; `as any` keeps the fixtures terse — match the file's existing fixture style if it differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/app/state.reducer.test.ts -t "agent-attention"`
Expected: FAIL — `attentionSessions`/`attentionWorkspaces` undefined, `SET_ATTENTION` not handled.

- [ ] **Step 3a: Add the state fields + action + initial state**

In `app/src/renderer/app/state.types.ts`, add to `AppState` (after `activeSessionId` ~L93):

```ts
  /**
   * Agent-attention (spec 2026-06-14). Maps keyed by id → the attention
   * timestamp. Presence drives the glow; cleared on focus/visit. A workspace
   * glows if it is a key here; a pane glows if its sessionId is a key.
   */
  attentionWorkspaces: Record<string, number>;
  attentionSessions: Record<string, number>;
```

Add to the `Action` union (after `SET_ACTIVE_SESSION` ~L187):

```ts
  | { type: 'SET_ATTENTION'; sessionId: string; ts: number }
```

Add to `initialAppState` (near `activeSessionId: null` ~L276):

```ts
  attentionWorkspaces: {},
  attentionSessions: {},
```

- [ ] **Step 3b: Add the reducer helper + cases**

In `app/src/renderer/app/state.reducer.ts`, add a module-level helper near the top (after imports):

```ts
/** Immutably drop a key from a record (returns the same ref if absent). */
function omitKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _drop, ...rest } = rec;
  return rest;
}
```

Add the `SET_ATTENTION` case (anywhere in the switch, e.g. right after `SET_ACTIVE_SESSION`):

```ts
    case 'SET_ATTENTION': {
      const ws = state.sessions.find((s) => s.id === action.sessionId)?.workspaceId ?? null;
      return {
        ...state,
        attentionSessions: { ...state.attentionSessions, [action.sessionId]: action.ts },
        attentionWorkspaces: ws
          ? { ...state.attentionWorkspaces, [ws]: action.ts }
          : state.attentionWorkspaces,
      };
    }
```

Replace the `SET_ACTIVE_SESSION` case (~L428):

```ts
    case 'SET_ACTIVE_SESSION':
      return {
        ...state,
        activeSessionId: action.id,
        attentionSessions: action.id ? omitKey(state.attentionSessions, action.id) : state.attentionSessions,
      };
```

In `SET_ACTIVE_WORKSPACE_ID` (the workspace-found branch, the final `return deriveActiveWorkspace({ ... })` at ~L346), add the clear to the object literal:

```ts
      return deriveActiveWorkspace({
        ...state,
        activeWorkspaceId: action.workspaceId,
        room,
        focusedPaneId,
        attentionWorkspaces: omitKey(state.attentionWorkspaces, action.workspaceId),
      });
```

In `SET_ACTIVE_WORKSPACE` (~L402), add the clear (guard for null workspace):

```ts
    case 'SET_ACTIVE_WORKSPACE':
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces: action.workspace
          ? upsertOpenWorkspace(state.openWorkspaces, action.workspace)
          : state.openWorkspaces,
        activeWorkspaceId: action.workspace?.id ?? null,
        room: action.workspace ? state.room : 'workspaces',
        attentionWorkspaces: action.workspace
          ? omitKey(state.attentionWorkspaces, action.workspace.id)
          : state.attentionWorkspaces,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/app/state.reducer.test.ts`
Expected: PASS (new attention tests + existing reducer tests green).

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/app/state.types.ts app/src/renderer/app/state.reducer.ts app/src/renderer/app/state.reducer.test.ts
git commit -m "feat(notifications): attention state maps + SET_ATTENTION + clear-on-focus"
```

---

## Task 8: use-live-events subscriber + throttled sound

**Files:**
- Modify: `app/src/renderer/app/state-hooks/use-live-events.ts` (imports ~L26; add a `useEffect` near the `pty:exit` subscriber ~L41)
- Test: `app/src/renderer/app/state-hooks/use-live-events.test.ts`

- [ ] **Step 1: Write the failing test**

In `app/src/renderer/app/state-hooks/use-live-events.test.ts`, add a `vi.mock` for the sounds module near the existing `playNotificationTone` mock (top of file), and a test. Mirror the file's existing `installSigmaStub()` + `renderHook` pattern:

```ts
// near the other vi.mock calls at top of file
const playCueMock = vi.fn();
vi.mock('../../lib/sounds', () => ({ playCue: (...a: unknown[]) => playCueMock(...a) }));
```

```ts
// new test (inside the top-level describe, mirroring existing tests' setup)
it('agent:attention dispatches SET_ATTENTION and plays the throttled cue', () => {
  const sigma = installSigmaStub();
  const dispatch = vi.fn<(a: Action) => void>();
  renderHook(() => useLiveEvents(dispatch, baseState())); // use this file's existing hook-render helper/args

  act(() => sigma.emit('agent:attention', { sessionId: 's1', reason: 'bell', ts: 1000 }));
  expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ATTENTION', sessionId: 's1', ts: 1000 });
  expect(playCueMock).toHaveBeenCalledWith('agent-attention');

  // a second event within the 2s throttle does NOT replay the sound
  playCueMock.mockClear();
  act(() => sigma.emit('agent:attention', { sessionId: 's2', reason: 'idle', ts: 1500 }));
  expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ATTENTION', sessionId: 's2', ts: 1500 });
  expect(playCueMock).not.toHaveBeenCalled();
});
```

> Match the exact hook signature/render helper this test file already uses for `useLiveEvents` (it renders the hook elsewhere — copy that call). `baseState()` = whatever initial-state helper the file uses (or `initialAppState`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/app/state-hooks/use-live-events.test.ts -t "agent:attention"`
Expected: FAIL — no `agent:attention` subscriber, `playCue` not called.

- [ ] **Step 3: Implement the subscriber + throttle**

In `app/src/renderer/app/state-hooks/use-live-events.ts`, add the import (near L26):

```ts
import { playCue } from '../../lib/sounds';
```

Add module-scope throttle state (top level of the file, after imports — module scope deliberately survives remounts):

```ts
// Agent-attention sound throttle. Module scope so a 20-agent swarm finishing
// together plays ONE sound, and the throttle survives hook remounts.
const ATTENTION_SOUND_THROTTLE_MS = 2000;
let lastAttentionSoundAt = 0;
```

Add the subscriber `useEffect` right after the `pty:exit` effect (~L50):

```ts
  // Agent-attention (spec 2026-06-14) — "agent is now waiting for you" (bell or
  // idle). Light up the workspace row + pane and play the throttled cue.
  useEffect(() => {
    const off = window.sigma.eventOn('agent:attention', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown; ts?: unknown };
      if (typeof p.sessionId !== 'string') return;
      const ts = typeof p.ts === 'number' ? p.ts : Date.now();
      dispatch({ type: 'SET_ATTENTION', sessionId: p.sessionId, ts });
      if (ts - lastAttentionSoundAt > ATTENTION_SOUND_THROTTLE_MS) {
        lastAttentionSoundAt = ts;
        void playCue('agent-attention');
      }
    });
    return off;
  }, [dispatch]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/app/state-hooks/use-live-events.test.ts`
Expected: PASS (new test + existing tests green).

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/app/state-hooks/use-live-events.ts app/src/renderer/app/state-hooks/use-live-events.test.ts
git commit -m "feat(notifications): subscribe agent:attention, throttled cue + SET_ATTENTION"
```

---

## Task 9: Remove the spurious per-spawn dispatch ding

**Files:**
- Modify: `app/src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts` (L4 import, L105 call)

The ding currently fires on Jorvis *dispatch* (pane spawn) — the "20-ding storm". Attention sound now fires correctly on agent-waiting. Remove the spurious ding. (The "Jump to pane" toast at L98 is unchanged — only the audio is removed.)

- [ ] **Step 1: Remove the call**

Delete L105:

```ts
        void playDing();
```

- [ ] **Step 2: Remove the now-unused import**

Delete L4:

```ts
import { playDing } from '@/renderer/lib/notifications';
```

- [ ] **Step 3: Typecheck (catches an accidentally-still-used import or vice-versa)**

Run: `npx tsc -b`
Expected: no errors (no "playDing is not defined", no "unused import").

- [ ] **Step 4: Run the file's tests if present, else the suite area**

Run: `npx vitest run src/renderer/features/jorvis-assistant/`
Expected: PASS (no test asserted the ding; if one does, update it to assert the toast only).

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts
git commit -m "fix(notifications): stop the spurious per-spawn dispatch ding"
```

---

## Task 10: CSS — `.sl-attention` glow + flicker keyframe

**Files:**
- Modify: `app/src/index.css` (after the `sl-bell-pulse` block, ~L670)

No unit test (CSS). Verified by the component tests in Tasks 11–12 (which assert the class is applied) + `npm run build`.

- [ ] **Step 1: Add the class + keyframe**

Insert after the `@keyframes sl-bell-pulse { … }` block (~L670):

```css
/* Agent-attention (spec 2026-06-14) — flicker for ~10s then settle to a static
   glow. The base box-shadow IS the settled glow; the 10-iteration animation
   overlays the flicker on top. After ~10s the animation ends and the element
   keeps the base glow until the class is removed (cleared on focus/visit).
   Under prefers-reduced-motion the global safety-net collapses the duration so
   reduced-motion users land on the settled glow instantly (no flicker). */
.sl-attention {
  border-radius: 0.375rem; /* rounded-md, matches workspace rows + panes */
  box-shadow: 0 0 0 1px hsl(var(--ring) / 0.4), 0 0 6px 1px hsl(var(--ring) / 0.15);
  animation: sl-attention-flicker 1s ease-in-out 10;
}
@keyframes sl-attention-flicker {
  0%, 100% { box-shadow: 0 0 0 1px hsl(var(--ring) / 0.6), 0 0 10px 3px hsl(var(--ring) / 0.35); }
  50% { box-shadow: 0 0 0 1px hsl(var(--ring) / 0.2), 0 0 2px 0 hsl(var(--ring) / 0.08); }
}
```

- [ ] **Step 2: Build to confirm the CSS compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/src/index.css
git commit -m "feat(notifications): sl-attention glow + flicker keyframe"
```

---

## Task 11: Sidebar workspace-row glow

**Files:**
- Modify: `app/src/renderer/features/sidebar/WorkspacesPanel.tsx` (props ~L57, row className ~L426)
- Modify: `app/src/renderer/features/sidebar/Sidebar.tsx` (selector + `<WorkspacesPanel …>` ~L372)
- Test: `app/src/renderer/features/sidebar/WorkspacesPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `app/src/renderer/features/sidebar/WorkspacesPanel.test.tsx` (mirror the file's existing render helper — it already renders `<WorkspacesPanel …>` with `workspaces`/`sessions`/`activeId`; copy that and add the new prop):

```ts
it('applies sl-attention to a workspace row that needs attention', () => {
  const ws = { id: 'ws-1', name: 'Alpha', rootPath: '/a' } as any;
  renderPanel({ workspaces: [ws], sessions: [], activeId: null, attentionWorkspaces: { 'ws-1': 123 } });
  const row = screen.getByTestId('workspace-row');
  expect(row.className).toContain('sl-attention');
});

it('does not apply sl-attention without attention', () => {
  const ws = { id: 'ws-1', name: 'Alpha', rootPath: '/a' } as any;
  renderPanel({ workspaces: [ws], sessions: [], activeId: null, attentionWorkspaces: {} });
  expect(screen.getByTestId('workspace-row').className).not.toContain('sl-attention');
});
```

> `renderPanel(props)` = the file's existing helper that renders `<WorkspacesPanel {...defaults} {...props} />`. Add `attentionWorkspaces` to its defaults as `{}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/sidebar/WorkspacesPanel.test.tsx -t "sl-attention"`
Expected: FAIL — `attentionWorkspaces` not a prop; class never applied.

- [ ] **Step 3a: Add the prop to `WorkspacesPanelProps`**

In `app/src/renderer/features/sidebar/WorkspacesPanel.tsx`, add to the props interface (~L57, near `sessions`/`activeId`):

```ts
  /** Agent-attention: workspaceId → ts. A row glows while its id is present. */
  attentionWorkspaces?: Record<string, number>;
```

Destructure it in the component signature (`export function WorkspacesPanel({ … })` ~L114) with a default:

```ts
  attentionWorkspaces = {},
```

- [ ] **Step 3b: Apply the class on the row**

In the row body (~L385, near `const isActive = ws.id === activeId;`), add:

```ts
            const needsAttention = attentionWorkspaces[ws.id] !== undefined;
```

Add `needsAttention && 'sl-attention'` to the row `cn(...)` className (~L426–435), e.g. as the last argument before the closing paren:

```ts
                    className={cn(
                      'group flex min-h-9 items-center rounded-md text-sm transition',
                      canDrag && 'cursor-grab active:cursor-grabbing',
                      isDragging && 'opacity-50',
                      showDropAbove && 'shadow-[inset_0_2px_0_0_hsl(var(--ring))]',
                      showDropBelow && 'shadow-[inset_0_-2px_0_0_hsl(var(--ring))]',
                      isActive
                        ? 'sl-nav-active bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                      needsAttention && 'sl-attention',
                    )}
```

- [ ] **Step 3c: Pass the prop from Sidebar**

In `app/src/renderer/features/sidebar/Sidebar.tsx`, add a selector near where `sessions` is selected (~L50):

```ts
  const attentionWorkspaces = useAppStateSelector((s) => s.attentionWorkspaces);
```

Pass it in the `<WorkspacesPanel …>` JSX (~L372, alongside `sessions={sessions}`):

```tsx
          attentionWorkspaces={attentionWorkspaces}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/sidebar/WorkspacesPanel.test.tsx`
Expected: PASS (new tests + existing WorkspacesPanel tests green).

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/features/sidebar/WorkspacesPanel.tsx app/src/renderer/features/sidebar/Sidebar.tsx app/src/renderer/features/sidebar/WorkspacesPanel.test.tsx
git commit -m "feat(notifications): sidebar workspace-row attention glow"
```

---

## Task 12: Pane glow

**Files:**
- Modify: `app/src/renderer/features/command-room/PaneShell.tsx` (selector + root div ~L433)
- Test: `app/src/renderer/features/command-room/PaneShell.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `app/src/renderer/features/command-room/PaneShell.test.tsx`, mirroring the file's existing render helper (it already renders `<PaneShell session=… />` inside the app-state provider). Drive attention by seeding `attentionSessions`:

```ts
it('applies sl-attention to the pane root when its session needs attention', () => {
  // render PaneShell for session 'sess-1' with provider state seeded so that
  // attentionSessions = { 'sess-1': 123 } (use the file's existing provider/render helper).
  renderPaneShell({ session: { id: 'sess-1', /* …existing fixture fields… */ } as any,
                     stateOverrides: { attentionSessions: { 'sess-1': 123 } } });
  const root = screen.getByTestId('pane-shell'); // see Step 3 — add this testid if absent
  expect(root.className).toContain('sl-attention');
});
```

> If the existing render helper doesn't accept `stateOverrides`, extend it (the provider used in this test file wraps an `AppState`; spread the override into it). If a `pane-shell` testid is absent on the root div, add it in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx -t "sl-attention"`
Expected: FAIL — class not applied.

- [ ] **Step 3: Implement the pane glow**

In `app/src/renderer/features/command-room/PaneShell.tsx`, add a selector (near the top of the component body, after the existing hooks). Use the existing state-selector hook (the file likely already imports it; if not, add `import { useAppStateSelector } from '@/renderer/app/state';`):

```ts
  const needsAttention = useAppStateSelector((s) => s.attentionSessions[session.id] !== undefined);
```

Change the root div (~L433) — add the conditional class via a template literal (no `cn` import needed) and a stable testid:

```tsx
      data-testid="pane-shell"
      className={`sl-pane-enter flex h-full min-h-0 min-w-0 flex-col overflow-hidden${
        needsAttention ? ' sl-attention' : ''
      }`}
```

(If the root `<div>` already has a `data-testid`, keep that one and adjust the test's selector instead of adding a duplicate.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/PaneShell.test.tsx`
Expected: PASS (new test + existing PaneShell tests green).

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer/features/command-room/PaneShell.tsx app/src/renderer/features/command-room/PaneShell.test.tsx
git commit -m "feat(notifications): pane attention glow"
```

---

## Task 13: Whole-branch gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole project (incl. test files)**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all green. (Watch for broken sibling mocks — a new member access on a mocked dep can break a hand-written mock that scoped tests miss. See `[[feedback_full_suite_catches_mock_breakage]]`.)

- [ ] **Step 3: Lint + build**

Run: `npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 4: Manual smoke note (deferred to operator / CI e2e)**

Do NOT launch the app locally (operator rule). The two transitions need a live Claude/Codex pane; verify in CI e2e or operator smoke:
1. Agent finishes a turn → its pane border glows + flickers ~10s → static; the workspace row glows if you're elsewhere.
2. Focusing the pane clears the pane glow; switching to the workspace clears the row glow.
3. A swarm finishing together produces ONE sound, many glows.

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| OSC-aware bell scanner | 1 |
| Idle timer (4s default, KV `notifications.idleMs`), bell-deduped | 2, 5 |
| `agent:attention` IPC, routed to owning window (detached-safe) | 3, 5 |
| Composition + dedupe | 4 |
| `agent-attention` cue (alert) | 6 |
| Attention state maps; clear workspace-on-switch + session-on-focus (independent) | 7 |
| Subscriber + sound throttle (≤1/2s, swarm-storm fix) | 8 |
| Remove spurious per-spawn ding | 9 |
| Flicker→settle CSS, reduced-motion safe | 10 |
| Sidebar workspace-row glow | 11 |
| Pane glow | 12 |
| Gate (tsc + full vitest + lint + build; e2e deferred) | 13 |

No spec requirement is unmapped. Out-of-scope items (OS dock/taskbar, toast, question-vs-done distinction, DB rows) are correctly absent.

**2. Placeholder scan:** No "TBD"/"add error handling"/"write tests for the above". Every code step shows the code; every test step shows the assertions. The few "match the file's existing helper" notes (Tasks 8, 11, 12) point at concrete, named existing harnesses rather than leaving content blank.

**3. Type consistency:** `AttentionReason = 'bell' | 'idle'` (Task 4) matches the IPC `reason` (Task 5) and the renderer ignores `reason` (Task 8) — same cue regardless, consistent with the spec. `attentionSessions` / `attentionWorkspaces: Record<string, number>` are defined once (Task 7) and read with `[id] !== undefined` everywhere (Tasks 11, 12). `SET_ATTENTION { sessionId, ts }` is defined (Task 7), dispatched (Task 8), and tested (Tasks 7, 8) with identical shape. `playCue('agent-attention')` (Task 8) matches the `SoundCue` member added in Task 6. `omitKey` is defined once (Task 7) and reused in three reducer cases. `'agent:attention'` string is identical across EVENTS (Task 3), `SESSION_ROUTED_EVENTS` + emit (Task 5), and the subscriber (Task 8).
