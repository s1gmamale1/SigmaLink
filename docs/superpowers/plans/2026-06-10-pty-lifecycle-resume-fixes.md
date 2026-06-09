# PTY Lifecycle & Resume Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four evidence-verified PTY lifecycle/resume bugs (2026-06-10 audit): the stale graceful-exit timer that kills a freshly-resumed pane, the resumed-pane crash misclassification that lets the exited-session GC reap crashed panes, the respawn-fresh path that resumes the PRE-crash conversation on the next reopen, and the cross-chunk CLI-exit sentinel miss in shell-first mode (the DEFAULT mode).

**Architecture:** All fixes are surgical, additive changes inside `app/src/main/core/pty/` plus a 3-call-site deps thread in `rpc-router.ts`. Each fix reuses an existing sibling pattern already in the codebase: record-identity guards (Task 1), the shared `isPtyCrash` classifier + `broadcastPtyError` dep (Task 2, mirroring `workspaces/launcher.ts:646-676` and `swarms/factory-spawn.ts:534-552`), the GHOST-HEAL pre-assign gate (Task 3, mirroring `resume-launcher.ts:651-706`), and a bounded carry buffer in the spirit of `swarms/protocol.ts` `ProtocolLineBuffer` (Task 4, detection-only — never rewrites forwarded data).

**Tech Stack:** TypeScript (Electron main process), vitest with `vi.useFakeTimers()` for the timer races. **better-sqlite3 cannot load under vitest** (built for Electron's ABI) — every DB dependency is faked the way the neighboring specs do it: `resume-launcher.test.ts` has a hand-rolled `setupDb()` SQL-regex mock; registry tests mock `./local-pty` and `../process/process-tree` entirely.

**Findings verification (2026-06-10, against HEAD of the working tree):** all five findings CONFIRMED in code — none refuted.
- F1 (HIGH): `registry.ts:326` schedules `setTimeout(() => this.forget(id), gracefulExitDelayMs)` capturing only the **id**; `registry.ts:342` `this.sessions.set(id, rec)` has no existing-record check; `rpc-router.ts:491` sets `gracefulExitDelayMs: 3_000`; `resume-launcher.ts:564-571` already-running guard checks `live?.alive` (passes for exited-but-unforgotten records).
- F2 (MED): `resume-launcher.ts:273-294` `attachExitPersistence` writes `earlyDeath ? 'error' : 'exited'` — time-only; siblings use `isPtyCrash` (`workspaces/launcher.ts:646-676`, `swarms/factory-spawn.ts:534-552`) and broadcast `pty:error`.
- F3 (MED): `resume-launcher.ts:477-522` `respawnFailedWorkspacePanes` spawns `sessionId: row.id, isResume: true, extraArgs: []` for ALL providers — `shouldPreAssign` (`providers/launcher.ts:239-254`) returns false and `onPostSpawnCapture` is suppressed (`registry.ts:346`), and the stale `external_session_id` is never nulled/replaced.
- F4 (MED): `registry.ts:261-271` calls `extractSentinel(rawData)` per chunk with no carry (`sentinel.ts:58-76` is stateless); shell-first is the default (`local-pty.ts:172-175`).
- F5 (mention): `registry.ts:311` derives the exit pane-event kind from `rec?.exitCode === 0` — a forgotten record yields kind `'error'` with `exitCode` undefined.

**Working directory for ALL commands:** `/Users/aisigma/projects/SigmaLink/app`

---

## File Structure

```
app/src/main/core/pty/
  registry.ts                    (modify) Task 1: duplicate-id guard in create() + record-identity
                                          guard on the graceful-exit timer + pane-event kind from
                                          exit args (F5). Task 4: per-session sentinel carry.
                                          (525 lines today; +~45 — already over the 500 guideline,
                                          do NOT split in this plan: behavior-fix scope only.)
  sentinel.ts                    (modify) Task 4: SENTINEL_CARRY_MAX + sliceSentinelCarry()
                                          (pure, anchor-safe tail helper).
  resume-launcher.ts             (modify) Task 2: isPtyCrash + broadcastPtyError in
                                          attachExitPersistence (+ deps field, 2 call sites).
                                          Task 3: ghost-heal parity in respawnFailedWorkspacePanes.
  registry-lifecycle.test.ts     (create)  Tasks 1+4 (+F5) registry tests. NEW focused file
                                          (~280 lines) — registry.test.ts is already ~1300 lines.
  sentinel.test.ts               (modify) Task 4: sliceSentinelCarry unit tests.
  resume-launcher.test.ts        (modify) Tasks 2+3 tests — reuses the file's existing
                                          setupDb()/insertSession()/makeSession() fakes.
app/src/main/rpc-router.ts       (modify) Task 2: thread broadcastPtyError into the 3 panesCtl
                                          call sites (resume / respawnFailed / resumeSelected).
```

NOT modified: `core/pty/crash.ts` (shared classifier reused as-is), `core/providers/launcher.ts` (`providerPreAssignsSession` reused as-is), `core/pty/local-pty.ts` (only mocked in tests — the win32-spawn plan owns it).

Production `PtyRegistry.create()` call-site survey (for the Task 1 duplicate guard): `providers/launcher.ts:329` (resolveAndSpawn — the only id-reusing path, via resume-launcher's guard) and `rpc-router.ts:961/1035/1334` (pty.create / spawnScratch / spawnInstall — all mint random UUIDs, the guard can never fire there). No caller relies on silent same-id overwrite.

---

### Task 1: Registry — stale graceful-exit timer race + duplicate-id create() (F1, folds in F5)

The bug chain: a pane's PTY exits → `registry.ts:326` arms a 3s forget timer keyed only by **id**. The operator (or boot auto-resume) resumes that DB row id inside the window — `resume-launcher.ts:566` `live?.alive` is `false` for the exited-but-unforgotten record, so the resume proceeds and `create()` blindly overwrites the map entry. At t+3s the STALE timer's `forget(id)` fetches the **new** record, unsubscribes its listeners, and kills the freshly-resumed pane. The blind overwrite also lets two concurrent `resumeWorkspacePanes` calls (per-row `await`s yield between alive-check and spawn) double-spawn: the second `sessions.set` orphans the first live PTY as an untracked zombie.

Fix decisions:
- **Timer:** capture the record at scheduling time; the timer bails if `this.sessions.get(id)` is no longer that exact record.
- **create() on duplicate id:** existing record **alive** → `throw` BEFORE `spawnLocalPty` (no orphan child is ever created; the resume caller's `catch` marks the row failed → it stays in the respawn bucket). Existing record **dead** (graceful-exit window) → clean-replace via `this.forget(id)` first, so the old listeners/buffer are torn down instead of leaked. Kill-old was rejected for the alive case: silently killing a pane another concurrent resume just brought up trades a zombie for operator-visible churn; throwing keeps the first winner intact.
- **F5 fold-in:** derive the exit pane-event `kind`/`exitCode` from the exit callback args, not the (possibly forgotten) map record.

**Files:**
- Modify: `src/main/core/pty/registry.ts:232` (create() id resolution), `src/main/core/pty/registry.ts:309-313` (pane-event kind), `src/main/core/pty/registry.ts:324-326` (forget timer)
- Test (create): `src/main/core/pty/registry-lifecycle.test.ts`

- [ ] **Task 1 / Step 1: Write the failing tests** — create `src/main/core/pty/registry-lifecycle.test.ts` with exactly this content:

```typescript
// 2026-06-10 PTY lifecycle audit — registry lifecycle races (findings 1, 4, 5).
//
// Finding 1 (HIGH): the graceful-exit timer captured only the session ID. When
// resume/respawn re-created the same DB row id inside the grace window
// (rpc-router passes gracefulExitDelayMs: 3_000), the STALE timer's forget(id)
// fetched the NEW record, unsubscribed its listeners, and killed the freshly
// resumed pane ~3s in. create() also blindly overwrote an existing map entry,
// which (a) enabled that race and (b) let concurrent resumeWorkspacePanes
// calls double-spawn an untracked zombie PTY.
//
// Finding 4: extractSentinel() is per-chunk; a sentinel split across two PTY
// reads never matched, so onCliExited never fired in shell-first mode (the
// DEFAULT since Phase 7). The registry carries a small per-session tail —
// scan-only; forwarded data is never rewritten (Task 4 adds those tests).
//
// Finding 5: the exit pane-event derived kind from `rec?.exitCode === 0`; a
// forgotten-record race reported a clean exit as 'error' with exitCode
// undefined.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty entirely (mirrors registry.test.ts). resolveEffectiveSpawnMode
// is reproduced as the real pure logic so shell-first resolution is genuine.
vi.mock('./local-pty', () => {
  return {
    spawnLocalPty: vi.fn(),
    resolveEffectiveSpawnMode: (
      spawnMode: 'direct' | 'shell-first' | undefined,
      command: string,
    ): 'direct' | 'shell-first' =>
      spawnMode === 'shell-first' && command !== '' && process.platform !== 'win32'
        ? 'shell-first'
        : 'direct',
  };
});

const processTreeMock = vi.hoisted(() => ({
  inspectProcessTree: vi.fn(),
  stopProcessTree: vi.fn(),
  stopProcessTrees: vi.fn(),
}));
vi.mock('../process/process-tree', () => processTreeMock);

import { spawnLocalPty } from './local-pty';
import { PtyRegistry } from './registry';
import type { PtyHandle } from './local-pty';
import { SENTINEL_PREFIX, SENTINEL_SUFFIX } from './sentinel';

interface FakePty extends PtyHandle {
  killCalls: number;
}

const FAKE_PID = 999_999_999; // way outside any real PID range
const realKill = process.kill.bind(process);

beforeEach(() => {
  processTreeMock.stopProcessTree.mockImplementation((rootPid: number) => ({
    rootPid,
    supported: false,
    nodes: [],
    descendantPids: [],
    rssBytes: 0,
  }));
  processTreeMock.stopProcessTrees.mockImplementation((rootPids: number[]) => ({
    snapshots: rootPids.map((rootPid) => ({
      rootPid,
      supported: false,
      nodes: [],
      descendantPids: [],
      rssBytes: 0,
    })),
    stoppedPids: [],
  }));
  // Intercept process.kill so isProcessAlive(FAKE_PID) reports "alive" and a
  // fallback SIGKILL never escapes to a real process (mirrors registry.test.ts).
  process.kill = ((pid: number, signal?: number | string) => {
    if (pid === FAKE_PID) return true;
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.kill = realKill;
  vi.clearAllMocks();
});

/**
 * Fake PTY with manually-fireable data/exit events.
 * `disconnectOnUnsub: true` (default) models a REAL unsubscribe (handler
 * detached) — used to assert that forget()/clean-replace tears listeners down.
 * `disconnectOnUnsub: false` models an event already in flight when the
 * unsubscribe ran (node-pty exit callbacks can race forget()).
 */
function makeLifecyclePty(opts: { disconnectOnUnsub?: boolean } = {}) {
  const disconnect = opts.disconnectOnUnsub ?? true;
  let dataHandler: ((d: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  const pty: FakePty = {
    pid: FAKE_PID,
    killCalls: 0,
    write: () => undefined,
    resize: () => undefined,
    kill: function (this: FakePty) {
      this.killCalls += 1;
    },
    onData: (cb) => {
      dataHandler = cb;
      return () => {
        if (disconnect) dataHandler = null;
      };
    },
    onExit: (cb) => {
      exitHandler = cb;
      return () => {
        if (disconnect) exitHandler = null;
      };
    },
  } as FakePty;
  return {
    pty,
    fireData: (d: string) => dataHandler?.(d),
    fireExit: (code: number, signal?: number) => exitHandler?.({ exitCode: code, signal }),
    hasDataHandler: () => dataHandler !== null,
  };
}

const baseInput = {
  providerId: 'claude',
  command: 'claude',
  args: [] as string[],
  cwd: '/tmp',
  cols: 80,
  rows: 24,
};

describe('graceful-exit timer vs resume-overwrite race (finding 1)', () => {
  it('a stale graceful-exit timer does NOT forget a record re-created inside the grace window', () => {
    const first = makeLifecyclePty();
    const second = makeLifecyclePty();
    const handles = [first, second];
    let i = 0;
    vi.mocked(spawnLocalPty).mockImplementation(() => handles[i++]!.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined, {
      gracefulExitDelayMs: 3_000, // mirrors rpc-router.ts:491
    });

    registry.create({ ...baseInput, sessionId: 'pane-1', isResume: true });
    // PTY exits → the 3s graceful-exit timer is armed for THIS record.
    first.fireExit(0);
    expect(registry.get('pane-1')?.alive).toBe(false);

    // 1s later the resume path re-creates the SAME DB row id. The
    // already-running guard (resume-launcher.ts `live?.alive`) passes for
    // exited-but-unforgotten records, so this IS the live production path.
    vi.advanceTimersByTime(1_000);
    const resumed = registry.create({ ...baseInput, sessionId: 'pane-1', isResume: true });
    expect(resumed.alive).toBe(true);

    // t=3s: the STALE timer fires. It must bail — not unsubscribe listeners /
    // kill the freshly resumed record.
    vi.advanceTimersByTime(2_100);
    expect(registry.get('pane-1')).toBe(resumed);
    expect(registry.get('pane-1')?.alive).toBe(true);
    expect(second.pty.killCalls).toBe(0);
  });

  it('create() throws on a duplicate id whose record is still ALIVE and does not spawn a second PTY', () => {
    const first = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(first.pty);
    const registry = new PtyRegistry(() => undefined, () => undefined);
    const original = registry.create({ ...baseInput, sessionId: 'pane-dup' });
    expect(original.alive).toBe(true);

    vi.mocked(spawnLocalPty).mockClear();
    expect(() => registry.create({ ...baseInput, sessionId: 'pane-dup' })).toThrow(
      /already has a live PTY/,
    );
    // The guard must run BEFORE spawnLocalPty — no orphan child process.
    expect(spawnLocalPty).not.toHaveBeenCalled();
    // The original record is untouched.
    expect(registry.get('pane-dup')).toBe(original);
  });

  it('create() over an EXITED-but-unforgotten record clean-replaces it (old listeners detached)', () => {
    const first = makeLifecyclePty();
    const second = makeLifecyclePty();
    const handles = [first, second];
    let i = 0;
    vi.mocked(spawnLocalPty).mockImplementation(() => handles[i++]!.pty);
    const forwarded: string[] = [];
    const registry = new PtyRegistry(
      (_sid, data) => forwarded.push(data),
      () => undefined,
      { gracefulExitDelayMs: 3_000 },
    );

    registry.create({ ...baseInput, sessionId: 'pane-2', isResume: true });
    first.fireExit(1); // dead, inside the grace window
    const replacement = registry.create({ ...baseInput, sessionId: 'pane-2', isResume: true });

    expect(registry.get('pane-2')).toBe(replacement);
    // The OLD record's data listener was unsubscribed by the clean-replace.
    expect(first.hasDataHandler()).toBe(false);
    // Late data from the old PTY no longer reaches the data sink.
    first.fireData('ghost bytes');
    expect(forwarded).not.toContain('ghost bytes');
  });
});

describe('exit pane-event kind hardening (finding 5)', () => {
  it("reports kind 'exited' + exitCode 0 even when the record was already forgotten", () => {
    // disconnectOnUnsub:false models node-pty's exit event already in flight
    // when forget() unsubscribed (e.g. stop({forget:true}) racing the exit).
    const fake = makeLifecyclePty({ disconnectOnUnsub: false });
    vi.mocked(spawnLocalPty).mockReturnValue(fake.pty);
    const events: Array<{ kind: string; exitCode?: number }> = [];
    const registry = new PtyRegistry(() => undefined, () => undefined, {
      onPaneEvent: (e) => events.push({ kind: e.kind, exitCode: e.exitCode }),
    });
    const sess = registry.create({ ...baseInput, sessionId: 'pane-evt' });
    sess.alive = false; // keep forget() off the kill path — exit raced it
    registry.forget('pane-evt');
    fake.fireExit(0);

    const exitEvent = events.find((e) => e.kind === 'exited' || e.kind === 'error');
    expect(exitEvent?.kind).toBe('exited'); // a clean exit must not read as a crash
    expect(exitEvent?.exitCode).toBe(0);
  });
});
```

(The `SENTINEL_PREFIX`/`SENTINEL_SUFFIX` imports are used by Task 4's tests in this same file; eslint may flag them as unused until Task 4 — if `npx eslint` complains in this intermediate state, leave the import line off until Task 4 adds it. tsc does not error on unused imports here.)

- [ ] **Task 1 / Step 2: Run the new tests — verify they FAIL**

Run: `npx vitest run src/main/core/pty/registry-lifecycle.test.ts`
Expected: FAIL —
- `a stale graceful-exit timer…` fails at `expect(registry.get('pane-1')).toBe(resumed)` (received `undefined` — the stale timer forgot the new record) and/or `expect(second.pty.killCalls).toBe(0)` (received `1`).
- `create() throws on a duplicate id…` fails at `.toThrow(/already has a live PTY/)` (no error thrown — blind overwrite).
- `create() over an EXITED-but-unforgotten…` fails at `expect(first.hasDataHandler()).toBe(false)` (received `true` — old listeners leaked).
- `reports kind 'exited'…` fails at `expect(exitEvent?.kind).toBe('exited')` (received `'error'`).

- [ ] **Task 1 / Step 3: Implement the registry fixes** — three edits in `src/main/core/pty/registry.ts`.

**Edit A** — duplicate-id guard at the top of `create()`. Replace (registry.ts:232-233):

```typescript
    const id = input.sessionId ?? input.preassignedSessionId ?? randomUUID();
    const isResume = input.isResume ?? (input.sessionId !== undefined);
```

with:

```typescript
    const id = input.sessionId ?? input.preassignedSessionId ?? randomUUID();
    // 2026-06-10 lifecycle audit (finding 1) — duplicate-id guard. Resume and
    // respawn reuse DB row ids, and the resume already-running guard passes
    // for EXITED-but-unforgotten records (alive=false inside the graceful-exit
    // window). A blind sessions.set() overwrite leaked the old record's
    // listeners and let its pending graceful-exit timer reap the NEW record
    // (see the recAtExit guard in the onExit handler below).
    //   - existing LIVE record → concurrent double-spawn (two overlapping
    //     resumeWorkspacePanes calls yielding between alive-check and spawn):
    //     throw BEFORE spawnLocalPty so no untracked zombie PTY is created;
    //     the caller's catch marks the row failed and it stays respawnable.
    //   - existing DEAD record → graceful-exit window: clean-replace via
    //     forget() so the old listeners/buffer are torn down first.
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.alive) {
        throw new Error(
          `PtyRegistry.create: session "${id}" already has a live PTY (pid ${existing.pid}) — refusing duplicate spawn`,
        );
      }
      this.forget(id);
    }
    const isResume = input.isResume ?? (input.sessionId !== undefined);
```

**Edit B** — pane-event kind from exit args (finding 5). Replace (registry.ts:309-313, inside the `pty.onExit` handler):

```typescript
      if (this.onPaneEvent) {
        try {
          this.onPaneEvent({ sessionId: id, kind: rec?.exitCode === 0 ? 'exited' : 'error', exitCode: rec?.exitCode });
        } catch { /* ignore */ }
      }
```

with:

```typescript
      if (this.onPaneEvent) {
        try {
          // Finding 5 — derive kind/exitCode from the exit callback args, not
          // the map record: when the record was already forgotten (an exit
          // event in flight while stop({forget:true}) ran) `rec` is undefined
          // and the old `rec?.exitCode === 0` check mis-reported a clean exit
          // as 'error' with exitCode undefined.
          this.onPaneEvent({ sessionId: id, kind: exitCode === 0 ? 'exited' : 'error', exitCode });
        } catch { /* ignore */ }
      }
```

**Edit C** — record-identity guard on the graceful-exit timer. Replace (registry.ts:324-326, the tail of the same `pty.onExit` handler):

```typescript
      // Forget after a short grace period so the renderer's last data drain is
      // not lost and a late subscribe() can still pull the snapshot.
      setTimeout(() => this.forget(id), this.gracefulExitDelayMs);
```

with:

```typescript
      // Forget after a short grace period so the renderer's last data drain is
      // not lost and a late subscribe() can still pull the snapshot.
      //
      // 2026-06-10 lifecycle audit (finding 1) — capture the record THIS exit
      // belongs to and bail if the map entry has been replaced by the time the
      // timer fires (resume/respawn re-created the id inside the grace
      // window). Without the guard the stale timer forgot the FRESH record:
      // it unsubscribed the new listeners and killed the just-resumed pane.
      const recAtExit = rec;
      setTimeout(() => {
        if (this.sessions.get(id) !== recAtExit) return;
        this.forget(id);
      }, this.gracefulExitDelayMs);
```

(Note: when `rec` was already undefined at exit time, `sessions.get(id) !== undefined` is false only if the map entry is also absent, in which case `forget(id)` no-ops — and if a NEW record exists, the `!==` guard bails. All cases covered without an extra branch.)

- [ ] **Task 1 / Step 4: Run the new tests — verify they PASS, then run the whole pty suite for fallout**

Run: `npx vitest run src/main/core/pty/registry-lifecycle.test.ts`
Expected: PASS (4 tests).

Run: `npx vitest run src/main/core/pty/`
Expected: PASS — no existing test creates the same session id twice (verified by call-site survey: registry.test.ts uses distinct ids `s0-s3`/`alive`/`dead`/etc.; registry-scrollback.test.ts uses distinct `resume-*` ids). If any test fails here, STOP and re-read it — do not weaken the guard.

- [ ] **Task 1 / Step 5: Commit**

```bash
git add src/main/core/pty/registry.ts src/main/core/pty/registry-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
fix(pty): guard graceful-exit forget timer against resume-overwrite + duplicate-id create()

Finding 1 (HIGH, 2026-06-10 audit): the 3s graceful-exit timer captured only
the session id; a resume re-creating the same DB row id inside the window had
its fresh record forgotten (listeners unsubscribed, pane killed) when the
stale timer fired. create() now refuses a duplicate spawn over a LIVE record
(pre-spawn throw — no zombie) and clean-replaces a DEAD one via forget().
Also folds finding 5: exit pane-event kind derives from the exit callback
args, not the possibly-forgotten map record.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Resume exit-persistence — shared `isPtyCrash` classification + `pty:error` broadcast (F2)

`attachExitPersistence` (resume-launcher.ts:273-294) is the THIRD exit-classification site, and the only one not using the shared classifier: a resumed pane that crashes with a non-zero code or a signal after the 1.5s grace window is written `'exited'` — so the exited-session GC reaps it on restore and it never re-enters the `exited`/`-1` respawn bucket. The siblings (`workspaces/launcher.ts:646-676`, `swarms/factory-spawn.ts:534-552`) use `isPtyCrash(earlyDeath, exitCode, signal)` from `core/pty/crash.ts` and broadcast `pty:error` so the renderer keeps the pane visible with an error banner.

**Files:**
- Modify: `src/main/core/pty/resume-launcher.ts:134-153` (ResumeLauncherDeps), `src/main/core/pty/resume-launcher.ts:273-294` (attachExitPersistence), `src/main/core/pty/resume-launcher.ts:515` and `:699` (the two call sites)
- Modify: `src/main/rpc-router.ts:1070`, `src/main/rpc-router.ts:1076-1077`, `src/main/rpc-router.ts:1100` (panesCtl deps)
- Test (modify): `src/main/core/pty/resume-launcher.test.ts` (append at end of file)

- [ ] **Task 2 / Step 1: Write the failing tests** — append to the END of `src/main/core/pty/resume-launcher.test.ts`:

```typescript
// ── 2026-06-10 audit finding 2: attachExitPersistence crash classification ──
// The resume/respawn exit hook used a TIME-ONLY earlyDeath test, while the two
// sibling exit-classification sites (workspaces/launcher.ts and
// swarms/factory-spawn.ts) share isPtyCrash(earlyDeath, exitCode, signal). A
// resumed pane crashing non-zero / by signal after 1.5s was recorded 'exited'
// → reaped by the exited-session GC on restore, never re-entering the
// exited/-1 respawn bucket. It must be recorded 'error' and broadcast
// pty:error exactly like the siblings.

function makeExitCapturePty(): {
  pty: SessionRecord['pty'];
  fireExit: (exitCode: number, signal?: number) => void;
} {
  let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  return {
    pty: {
      pid: 4321,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => () => undefined,
      onExit: (cb) => {
        exitHandler = cb;
        return () => undefined;
      },
    },
    fireExit: (exitCode, signal) => exitHandler?.({ exitCode, signal }),
  };
}

function makeResolveWithPty(
  pty: SessionRecord['pty'],
): NonNullable<ResumeLauncherDeps['resolve']> {
  return (_deps, opts) => {
    const id = opts.sessionId ?? opts.preassignedSessionId ?? 'new-id';
    return {
      // makeSession's default startedAt=1234 is far in the past relative to
      // real Date.now() → these exits are NEVER earlyDeath.
      ptySession: { ...makeSession(id, opts.providerId, 1234), pty },
      providerRequested: opts.providerId,
      providerEffective: opts.providerId,
      commandUsed: opts.providerId,
      argsUsed: opts.extraArgs ?? [],
      fallbackOccurred: false,
    };
  };
}

describe('attachExitPersistence — shared isPtyCrash classification (audit finding 2)', () => {
  it("records 'error' + broadcasts pty:error for a NON-ZERO exit after the 1.5s grace window", async () => {
    const { db, rows } = setupDb();
    // null external id → fresh-fallback path; no JSONL seeding required.
    insertSession(rows, { id: 'sess-crash', external_session_id: null });
    const { pty: fakePty, fireExit } = makeExitCapturePty();
    const broadcasts: Array<{
      sessionId: string;
      exitCode: number | null;
      signal?: string | null;
    }> = [];

    const result = await resumeWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve: makeResolveWithPty(fakePty),
      broadcastPtyError: (payload) => broadcasts.push(payload),
    });
    expect(result.resumed).toHaveLength(1);

    fireExit(1);

    expect(rows[0]?.status).toBe('error'); // was 'exited' before the fix
    expect(rows[0]?.exit_code).toBe(1);
    expect(broadcasts).toEqual([{ sessionId: 'sess-crash', exitCode: 1, signal: null }]);
  });

  it("records 'error' + broadcasts for a SIGNAL-killed exit (code 0, signal 15) after the grace window", async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-sig', external_session_id: null });
    const { pty: fakePty, fireExit } = makeExitCapturePty();
    const broadcasts: Array<{
      sessionId: string;
      exitCode: number | null;
      signal?: string | null;
    }> = [];

    await resumeWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve: makeResolveWithPty(fakePty),
      broadcastPtyError: (payload) => broadcasts.push(payload),
    });

    fireExit(0, 15);

    expect(rows[0]?.status).toBe('error');
    expect(broadcasts).toEqual([{ sessionId: 'sess-sig', exitCode: 0, signal: '15' }]);
  });

  it("keeps a clean late exit as 'exited' with NO broadcast (regression guard)", async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-clean', external_session_id: null });
    const { pty: fakePty, fireExit } = makeExitCapturePty();
    const broadcasts: unknown[] = [];

    await resumeWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve: makeResolveWithPty(fakePty),
      broadcastPtyError: (payload) => broadcasts.push(payload),
    });

    fireExit(0);

    expect(rows[0]?.status).toBe('exited');
    expect(rows[0]?.exit_code).toBe(0);
    expect(broadcasts).toHaveLength(0);
  });

  it('threads broadcastPtyError through the respawnFailedWorkspacePanes sibling too', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-respawn-crash',
      external_session_id: null,
      status: 'exited',
      exit_code: -1,
      exited_at: 111,
    });
    const { pty: fakePty, fireExit } = makeExitCapturePty();
    const broadcasts: Array<{ sessionId: string }> = [];

    const result = await respawnFailedWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      resolve: makeResolveWithPty(fakePty),
      broadcastPtyError: (payload) => broadcasts.push(payload),
    });
    expect(result.spawned).toBe(1);

    fireExit(137);

    expect(rows[0]?.status).toBe('error');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.sessionId).toBe('sess-respawn-crash');
  });
});
```

- [ ] **Task 2 / Step 2: Run the new tests — verify they FAIL**

Run: `npx vitest run src/main/core/pty/resume-launcher.test.ts -t "attachExitPersistence"`
Expected: FAIL — tsc/vitest first reports `broadcastPtyError` is not a known property of `ResumeLauncherDeps` (object-literal excess property error), which IS the failing signal for the deps field. (If running with `--typecheck` off it instead fails at `expect(rows[0]?.status).toBe('error')` receiving `'exited'`, and `broadcasts` staying empty.) The clean-exit regression guard may already pass — that is expected.

- [ ] **Task 2 / Step 3: Implement** — four edits in `src/main/core/pty/resume-launcher.ts`, then the rpc-router wiring.

**Edit A** — import the shared classifier. Change (resume-launcher.ts:19):

```typescript
import { KV_PTY_SPAWN_MODE, parseSpawnMode } from './local-pty';
```

to:

```typescript
import { KV_PTY_SPAWN_MODE, parseSpawnMode } from './local-pty';
import { isPtyCrash } from './crash';
```

**Edit B** — add the dep. In `interface ResumeLauncherDeps` (resume-launcher.ts:134-153), after the `loadScrollbackForSession?` member, add:

```typescript
  /**
   * crash-classification IPC (2026-06-10 audit, finding 2) — when provided, a
   * crash exit (isPtyCrash: earlyDeath OR non-zero code OR non-zero signal) on
   * a resumed/respawned pane broadcasts `pty:error` so the renderer keeps the
   * pane visible with an error banner instead of GC-removing it. Mirrors
   * LaunchDeps.broadcastPtyError in workspaces/launcher.ts. Optional: absent →
   * DB status write only, no broadcast (existing tests unchanged).
   */
  broadcastPtyError?: (payload: {
    sessionId: string;
    exitCode: number | null;
    signal?: string | null;
  }) => void;
```

**Edit C** — rewrite `attachExitPersistence` (resume-launcher.ts:273-294). Replace the whole function with:

```typescript
function attachExitPersistence(
  db: Database.Database,
  sessionId: string,
  rec: SessionRecord,
  broadcastPtyError?: ResumeLauncherDeps['broadcastPtyError'],
): void {
  const startedMs = rec.startedAt;
  rec.pty.onExit(({ exitCode, signal }) => {
    // Treat any exit within 1.5s of spawn as a launch failure, and ALSO any
    // non-zero exit code / signal as a crash — via the SHARED classifier so
    // this third exit-classification site finally matches its two siblings
    // (workspaces/launcher.ts, swarms/factory-spawn.ts). 2026-06-10 audit,
    // finding 2: the previous time-only test recorded a post-1.5s non-zero /
    // signal-killed exit as 'exited', so the exited-session GC reaped the
    // crashed pane on restore and it never entered the exited/-1 respawn
    // bucket.
    const earlyDeath = Date.now() - startedMs < 1500;
    const isCrash = isPtyCrash(earlyDeath, exitCode, signal);
    try {
      db.prepare(
        `UPDATE agent_sessions
         SET status = ?, exit_code = ?, exited_at = ?
         WHERE id = ?`,
      ).run(isCrash ? 'error' : 'exited', exitCode, Date.now(), sessionId);
    } catch {
      /* db may be closing during shutdown */
    }
    if (isCrash) {
      try {
        broadcastPtyError?.({
          sessionId,
          exitCode: exitCode ?? null,
          signal: signal != null ? String(signal) : null,
        });
      } catch {
        /* broadcast is best-effort */
      }
    }
  });
}
```

**Edit D** — thread the dep at BOTH call sites (grep-the-siblings: this function has exactly two callers). Change resume-launcher.ts:515 (inside `respawnFailedWorkspacePanes`) and resume-launcher.ts:699 (inside `resumeWorkspacePanes`) from:

```typescript
      attachExitPersistence(db, row.id, rec);
```

to:

```typescript
      attachExitPersistence(db, row.id, rec, deps.broadcastPtyError);
```

**Edit E** — wire the live broadcast in `src/main/rpc-router.ts` (three sibling call sites in `panesCtl`; the payload shape matches the existing `pty:error` broadcast at rpc-router.ts:1470). Change line 1070:

```typescript
      return resumeWorkspacePanes(workspaceId, { pty, loadScrollbackForSession });
```

to:

```typescript
      return resumeWorkspacePanes(workspaceId, {
        pty,
        loadScrollbackForSession,
        // finding 2 — resumed panes get the same crash-classification IPC as
        // fresh launches (executeLaunchPlan already threads this below).
        broadcastPtyError: (payload) => broadcast('pty:error', payload),
      });
```

Change lines 1076-1077:

```typescript
    respawnFailed: async (workspaceId: string) =>
      respawnFailedWorkspacePanes(workspaceId, { pty }),
```

to:

```typescript
    respawnFailed: async (workspaceId: string) =>
      respawnFailedWorkspacePanes(workspaceId, {
        pty,
        broadcastPtyError: (payload) => broadcast('pty:error', payload),
      }),
```

Change line 1100:

```typescript
      return resumeWorkspacePanes(workspaceId, { pty, loadScrollbackForSession }, ids);
```

to:

```typescript
      return resumeWorkspacePanes(
        workspaceId,
        {
          pty,
          loadScrollbackForSession,
          broadcastPtyError: (payload) => broadcast('pty:error', payload),
        },
        ids,
      );
```

- [ ] **Task 2 / Step 4: Grep the siblings + run**

Run: `grep -n "attachExitPersistence(" src/main/core/pty/resume-launcher.ts`
Expected: 1 definition + exactly 2 call sites, both passing `deps.broadcastPtyError`.

Run: `grep -n "resumeWorkspacePanes(\|respawnFailedWorkspacePanes(" src/main/rpc-router.ts`
Expected: the import line + exactly 3 call sites, all passing `broadcastPtyError`.

Run: `npx vitest run src/main/core/pty/resume-launcher.test.ts`
Expected: PASS (whole file — the pre-existing resume/respawn tests must stay green; they omit `broadcastPtyError`, which is optional).

Run: `npx tsc -b`
Expected: clean — this is the only check covering the rpc-router wiring (rpc-router cannot load under vitest: better-sqlite3 Electron ABI).

- [ ] **Task 2 / Step 5: Commit**

```bash
git add src/main/core/pty/resume-launcher.ts src/main/core/pty/resume-launcher.test.ts src/main/rpc-router.ts
git commit -m "$(cat <<'EOF'
fix(pty): classify resumed-pane exits with shared isPtyCrash + broadcast pty:error

Finding 2 (2026-06-10 audit): attachExitPersistence used a TIME-ONLY earlyDeath
test while its two siblings (workspaces/launcher, swarms/factory-spawn) share
isPtyCrash(earlyDeath, exitCode, signal). A resumed pane crashing non-zero or
by signal after 1.5s was recorded 'exited' → reaped by the exited-session GC on
restore, never re-entering the exited/-1 respawn bucket. Now records 'error'
and broadcasts pty:error like the siblings (wired at all 3 panesCtl sites).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: respawnFailedWorkspacePanes — ghost-heal parity (F3)

The "Respawn fresh" path spawns with `sessionId: row.id, isResume: true, extraArgs: []` — exactly the "fresh spawn down the RESUME path" failure mode the GHOST-HEAL comment (resume-launcher.ts:651-667) documents: `shouldPreAssign` returns false (providers/launcher.ts:243 — `opts.sessionId` set), `onPostSpawnCapture` is suppressed (registry.ts:346), and unlike `resumeWorkspacePanes`'s fresh-fallback (resume-launcher.ts:668-706) it neither nulls the stale `external_session_id` nor stamps the new pre-assigned one. Result: the NEXT reopen resumes the PRE-crash conversation even though the operator explicitly respawned fresh.

Fix (mirrors the existing heal gate): null the stale `external_session_id` for EVERY provider (a fresh respawn must never point at the pre-crash session); for providers that mint a deterministic `--session-id` (`providerPreAssignsSession` — claude only) spawn with FRESH semantics (`preassignedSessionId` + `isResume: false`) and stamp the returned `preassignedExternalSessionId` back. Non-pre-assign providers (codex/gemini/kimi/opencode) keep `sessionId` + `isResume: true` so the disk-scan capture stays suppressed — in the shared in-place cwd it races siblings/the operator (the session-collapse class of bug). The null-before-spawn ordering is REQUIRED for claude: the router's `persistExternalSessionId` (fired via `onPostSpawnCapture` during `resolve()`) only writes into a NULL/empty column.

**Files:**
- Modify: `src/main/core/pty/resume-launcher.ts:477-522` (the respawn loop body)
- Test (modify): `src/main/core/pty/resume-launcher.test.ts` (append at end of file)

- [ ] **Task 3 / Step 1: Write the failing tests** — append to the END of `src/main/core/pty/resume-launcher.test.ts`:

```typescript
// ── 2026-06-10 audit finding 3: respawnFailedWorkspacePanes ghost-heal parity ──
// "Respawn fresh" spawned sessionId+isResume:true with extraArgs [] for ALL
// providers — the exact "fresh spawn down the RESUME path" failure mode the
// GHOST-HEAL comment in resumeWorkspacePanes documents (no --session-id
// pre-assign, capture suppressed) — and never touched the stale
// external_session_id, so the NEXT reopen resumed the PRE-crash conversation.

describe('respawnFailedWorkspacePanes — ghost-heal parity (audit finding 3)', () => {
  const NEW_RESPAWN_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

  function makeCaptureResolve(
    calls: Array<{
      preassignedSessionId?: string;
      sessionId?: string;
      isResume?: boolean;
      args: string[];
    }>,
    preassignedExternalSessionId?: string,
  ): NonNullable<ResumeLauncherDeps['resolve']> {
    return (_deps, opts) => {
      calls.push({
        preassignedSessionId: opts.preassignedSessionId,
        sessionId: opts.sessionId,
        isResume: opts.isResume,
        args: opts.extraArgs ?? [],
      });
      return {
        ptySession: makeSession(
          opts.preassignedSessionId ?? opts.sessionId ?? 'new',
          opts.providerId,
        ),
        providerRequested: opts.providerId,
        providerEffective: opts.providerId,
        commandUsed: opts.providerId,
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
        preassignedExternalSessionId,
      };
    };
  }

  it('claude respawn uses FRESH semantics (preassignedSessionId + isResume:false) and stamps the new pre-assigned id', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-respawn-claude',
      status: 'exited',
      exit_code: -1,
      exited_at: 111,
      external_session_id: VALID_CLAUDE_SESSION_ID, // stale PRE-crash conversation id
    });
    const calls: Array<{
      preassignedSessionId?: string;
      sessionId?: string;
      isResume?: boolean;
      args: string[];
    }> = [];

    const result = await respawnFailedWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      resolve: makeCaptureResolve(calls, NEW_RESPAWN_ID),
    });

    expect(result).toEqual({ workspaceId: 'ws-1', spawned: 1, failed: 0 });
    // FRESH semantics — shouldPreAssign must inject --session-id and the
    // post-spawn capture must not be suppressed.
    expect(calls[0]?.preassignedSessionId).toBe('sess-respawn-claude');
    expect(calls[0]?.sessionId).toBeUndefined();
    expect(calls[0]?.isResume).toBe(false);
    expect(calls[0]?.args).toEqual([]);
    // The NEW session id is persisted → the next reopen resumes the
    // POST-respawn conversation, not the pre-crash one.
    expect(rows[0]?.external_session_id).toBe(NEW_RESPAWN_ID);
    expect(rows[0]?.status).toBe('running');
  });

  it('codex respawn keeps resume-path semantics (no disk-scan race) but NULLS the stale external id', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-respawn-codex',
      provider_id: 'codex',
      provider_effective: 'codex',
      status: 'exited',
      exit_code: -1,
      exited_at: 111,
      external_session_id: 'stale-codex-session',
    });
    const calls: Array<{
      preassignedSessionId?: string;
      sessionId?: string;
      isResume?: boolean;
      args: string[];
    }> = [];

    const result = await respawnFailedWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      resolve: makeCaptureResolve(calls),
    });

    expect(result.spawned).toBe(1);
    // codex has no deterministic --session-id; its disk-scan capture races
    // siblings/the operator in the shared in-place cwd → keep the suppressed
    // resume-path semantics…
    expect(calls[0]?.sessionId).toBe('sess-respawn-codex');
    expect(calls[0]?.preassignedSessionId).toBeUndefined();
    expect(calls[0]?.isResume).toBe(true);
    // …but the stale PRE-crash id must be cleared so the next reopen spawns
    // fresh (safe per the session-collapse policy) instead of resuming the
    // pre-crash conversation.
    expect(rows[0]?.external_session_id).toBeNull();
  });

  it('claude respawn without a minted pre-assign id leaves the column cleared (never re-stamps the stale id)', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-respawn-nopre',
      status: 'exited',
      exit_code: -1,
      exited_at: 111,
      external_session_id: VALID_CLAUDE_SESSION_ID,
    });
    const calls: Array<{
      preassignedSessionId?: string;
      sessionId?: string;
      isResume?: boolean;
      args: string[];
    }> = [];

    await respawnFailedWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      resolve: makeCaptureResolve(calls /* no preassignedExternalSessionId */),
    });

    expect(rows[0]?.external_session_id).toBeNull();
  });
});
```

- [ ] **Task 3 / Step 2: Run the new tests — verify they FAIL**

Run: `npx vitest run src/main/core/pty/resume-launcher.test.ts -t "ghost-heal parity"`
Expected: FAIL —
- claude test fails at `expect(calls[0]?.preassignedSessionId).toBe('sess-respawn-claude')` (received `undefined` — current code passes `sessionId`).
- codex test fails at `expect(rows[0]?.external_session_id).toBeNull()` (received `'stale-codex-session'`).
- no-pre-assign test fails at `toBeNull()` (received the stale UUID).

- [ ] **Task 3 / Step 3: Implement** — rewrite the respawn loop body in `src/main/core/pty/resume-launcher.ts:477-522`. Replace:

```typescript
  for (const row of rows) {
    const providerId = row.providerEffective ?? row.providerId;
    const cwd = await resolveResumeCwd(row);
    try {
      if (providerId === 'claude') {
        await prepareClaudeWorkspaceContext(row.workspaceRoot, cwd, {
          homeDir: deps.claudeHomeDir,
        });
        await ensureClaudeProjectDir(cwd, { homeDir: deps.claudeHomeDir });
      }
      // v1.4.3-01 — ensure gemini project dir exists before a fresh respawn
      // so the first write to the chats dir succeeds.
      if (providerId === 'gemini') {
        await ensureGeminiProjectDir(cwd, row.workspaceRoot, {
          homeDir: deps.claudeHomeDir,
        });
      }
      const result: ResolveAndSpawnResult = resolve(
        { ptyRegistry: deps.pty },
        {
          providerId,
          sessionId: row.id,
          cwd,
          cols: deps.cols ?? 120,
          rows: deps.rows ?? 32,
          showLegacy: deps.showLegacy ?? readShowLegacy(db),
          // No resumeArgs — this is a fresh spawn in the same worktree.
          extraArgs: [],
          // v1.5.5 — explicit resume flag: sessionId reuses the existing DB
          // row, so this IS a resume even though no --resume/--continue arg
          // is passed. Suppresses the redundant onPostSpawnCapture disk-scan.
          isResume: true,
          spawnMode,
        },
      );
      const rec = result.ptySession;
      markResumeRunning(db, row.id, rec.startedAt);
      writeProviderEffective(db, row.id, result.providerEffective);
      attachExitPersistence(db, row.id, rec, deps.broadcastPtyError);
      spawned += 1;
    } catch {
      // Re-mark failure so the row stays in the bucket for a future retry.
      markResumeFailed(db, row.id, now());
      failed += 1;
    }
  }
```

with:

```typescript
  for (const row of rows) {
    const providerId = row.providerEffective ?? row.providerId;
    const cwd = await resolveResumeCwd(row);
    // GHOST-HEAL parity (2026-06-10 audit, finding 3) — this is a FRESH spawn
    // (no resume args): the row's external_session_id points at the PRE-crash
    // conversation, so leaving it in place made the NEXT reopen resume the
    // pre-crash session even though the operator explicitly respawned fresh.
    // Null it for EVERY provider BEFORE spawning (the router's
    // persistExternalSessionId capture sink only writes into a NULL column).
    // Providers that mint a deterministic --session-id (claude) additionally
    // spawn with FRESH semantics (preassignedSessionId + isResume:false →
    // shouldPreAssign injects --session-id, capture is not suppressed) and the
    // new id is stamped back below — mirroring resumeWorkspacePanes' heal
    // gate. Other providers keep sessionId + isResume:true so the cwd
    // disk-scan stays suppressed (it races siblings/the operator in the
    // shared in-place cwd — the session-collapse class of bug).
    const healViaPreAssign = providerPreAssignsSession(providerId);
    setExternalSessionId(db, row.id, null);
    try {
      if (providerId === 'claude') {
        await prepareClaudeWorkspaceContext(row.workspaceRoot, cwd, {
          homeDir: deps.claudeHomeDir,
        });
        await ensureClaudeProjectDir(cwd, { homeDir: deps.claudeHomeDir });
      }
      // v1.4.3-01 — ensure gemini project dir exists before a fresh respawn
      // so the first write to the chats dir succeeds.
      if (providerId === 'gemini') {
        await ensureGeminiProjectDir(cwd, row.workspaceRoot, {
          homeDir: deps.claudeHomeDir,
        });
      }
      const result: ResolveAndSpawnResult = resolve(
        { ptyRegistry: deps.pty },
        {
          providerId,
          ...(healViaPreAssign
            ? { preassignedSessionId: row.id, isResume: false as const }
            : { sessionId: row.id, isResume: true as const }),
          cwd,
          cols: deps.cols ?? 120,
          rows: deps.rows ?? 32,
          showLegacy: deps.showLegacy ?? readShowLegacy(db),
          // No resumeArgs — this is a fresh spawn in the same worktree.
          extraArgs: [],
          spawnMode,
        },
      );
      const rec = result.ptySession;
      markResumeRunning(db, row.id, rec.startedAt);
      writeProviderEffective(db, row.id, result.providerEffective);
      attachExitPersistence(db, row.id, rec, deps.broadcastPtyError);
      // GHOST-HEAL — persist the freshly pre-assigned id so the NEXT reopen
      // resumes the post-respawn conversation by a REAL id.
      if (healViaPreAssign && result.preassignedExternalSessionId) {
        setExternalSessionId(db, row.id, result.preassignedExternalSessionId);
      }
      spawned += 1;
    } catch {
      // Re-mark failure so the row stays in the bucket for a future retry.
      markResumeFailed(db, row.id, now());
      failed += 1;
    }
  }
```

(`providerPreAssignsSession` and `setExternalSessionId` are already imported/defined in this file — resume-launcher.ts:6 and :232-243. No import changes needed.)

- [ ] **Task 3 / Step 4: Run — new tests pass, siblings stay green**

Run: `npx vitest run src/main/core/pty/resume-launcher.test.ts`
Expected: PASS (whole file). Pay attention to the pre-existing `respawnFailedWorkspacePanes` spawn-mode test (`provider 'shell'` → `providerPreAssignsSession('shell')` is false → still spawns `sessionId + spawnMode`, unchanged) and the GHOST-HEAL tests for `resumeWorkspacePanes` (untouched code path).

Grep the heal-gate siblings (the two fresh-fallback sites must now BOTH heal):
Run: `grep -n "providerPreAssignsSession(" src/main/core/pty/resume-launcher.ts src/main/core/providers/launcher.ts`
Expected: the definition in providers/launcher.ts + exactly 2 uses in resume-launcher.ts (resumeWorkspacePanes' heal gate and the new respawn gate).

- [ ] **Task 3 / Step 5: Commit**

```bash
git add src/main/core/pty/resume-launcher.ts src/main/core/pty/resume-launcher.test.ts
git commit -m "$(cat <<'EOF'
fix(pty): mirror the ghost-heal gate in respawnFailed — preassign claude, null stale external ids

Finding 3 (2026-06-10 audit): respawnFailedWorkspacePanes spawned
sessionId+isResume:true for all providers — shouldPreAssign false, capture
suppressed, stale external_session_id untouched — so the next reopen resumed
the PRE-crash conversation. Now: null the stale id for every provider
(before spawn, so the capture sink can write), and for providers with a
deterministic --session-id (claude) spawn with fresh semantics and stamp the
new pre-assigned id back, mirroring resumeWorkspacePanes' GHOST-HEAL gate.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Cross-chunk CLI-exit sentinel carry (F4)

`extractSentinel(rawData)` runs per PTY read with no state: `\n__SIGMALINK_CLI_EXIT_0__\n` split across two reads never matches — `onCliExited` never fires (pane status never flips to cli-exited) and the raw halves render in the pane. Shell-first is the DEFAULT mode (local-pty.ts:172-175), so this is a live-path miss. Fix: a small per-session tail (≤64 chars, anchor-safe) carried between chunks and prepended for SCANNING ONLY — bytes from a previous chunk were already forwarded to the renderer and can never be retracted, so the carry never rewrites `data`; only whole-chunk matches keep the existing stripping behaviour. (The buffered sibling pattern is `swarms/protocol.ts` `ProtocolLineBuffer`, used at factory-spawn.ts:511-521 — but that one delays/consumes lines, which we must NOT do to terminal output; hence a scan-only carry instead.)

Anchor-safety detail: a naive `combined.slice(-64)` could cut mid-line and turn `x__SIGMALINK…` into a string-start-anchored false positive on the next scan (SENTINEL_RE matches `(?:^|\r?\n)`). The carry therefore always starts at a real `\n` from the stream (tail from the LAST newline), and is dropped entirely when the in-flight line is already longer than any sentinel can be (~30 chars max; also bounds memory on newline-free streams like progress bars).

**Files:**
- Modify: `src/main/core/pty/sentinel.ts` (append helper after `extractSentinel`, before the win32 section)
- Modify: `src/main/core/pty/registry.ts:22` (import) and `registry.ts:254-271` (the onData sentinel block)
- Test (modify): `src/main/core/pty/sentinel.test.ts` (append describe at end)
- Test (modify): `src/main/core/pty/registry-lifecycle.test.ts` (append describe at end — created in Task 1)

- [ ] **Task 4 / Step 1: Write the failing unit tests for the helper** — in `src/main/core/pty/sentinel.test.ts`, extend the import (sentinel.test.ts:6-15) to include the two new exports:

```typescript
import {
  SENTINEL_PREFIX,
  SENTINEL_SUFFIX,
  SENTINEL_RE,
  containsSentinel,
  extractSentinel,
  buildSentinelSnippet,
  buildPowerShellSentinelSnippet,
  buildCmdSentinelSnippet,
  sliceSentinelCarry,
  SENTINEL_CARRY_MAX,
} from './sentinel';
```

then append at the END of the file:

```typescript
// ── 2026-06-10 audit finding 4: cross-chunk sentinel carry helper ──────────
describe('sliceSentinelCarry', () => {
  it('keeps the tail from the last newline when a partial sentinel may be in flight', () => {
    expect(sliceSentinelCarry('CLI output\n__SIGMALINK_CLI_EX')).toBe('\n__SIGMALINK_CLI_EX');
  });

  it('keeps just the newline when the chunk ends at a line boundary', () => {
    expect(sliceSentinelCarry('CLI output\n')).toBe('\n');
  });

  it('drops the carry when the in-flight line is longer than any sentinel (cap)', () => {
    expect(sliceSentinelCarry('start\n' + 'x'.repeat(SENTINEL_CARRY_MAX + 16))).toBe('');
  });

  it('returns empty when there is no newline at all (no anchor → no fabricated line start)', () => {
    expect(sliceSentinelCarry('x'.repeat(20))).toBe('');
  });

  it('never fabricates a line-start anchor: carry + next chunk only matches via a REAL stream newline', () => {
    // The carry always begins with the stream's own '\n', so prepending it to
    // the next chunk reproduces the genuine line boundary.
    const carry = sliceSentinelCarry('output\n__SIGMALINK_CLI_EXIT_');
    const match = extractSentinel(carry + '0__\n');
    expect(match).not.toBeNull();
    expect(match!.exitCode).toBe(0);
  });
});
```

- [ ] **Task 4 / Step 2: Run — verify FAIL**

Run: `npx vitest run src/main/core/pty/sentinel.test.ts`
Expected: FAIL — `sliceSentinelCarry`/`SENTINEL_CARRY_MAX` are not exported from './sentinel' (TS2305 / undefined at runtime).

- [ ] **Task 4 / Step 3: Implement the helper** — in `src/main/core/pty/sentinel.ts`, insert AFTER the `extractSentinel` function (after line 76) and BEFORE `buildSentinelSnippet`:

```typescript
// ---------------------------------------------------------------------------
// 2026-06-10 audit (finding 4) — cross-chunk sentinel carry.
//
// extractSentinel() is per-chunk. PTY reads can split the sentinel across two
// (or more) chunks, in which case it NEVER matched and onCliExited never
// fired (shell-first is the DEFAULT mode). The registry keeps a small
// per-session tail and prepends it to the next chunk for SCANNING ONLY — the
// data forwarded to the renderer is never rewritten (bytes from a previous
// chunk already rendered and cannot be retracted).
// ---------------------------------------------------------------------------

/**
 * Maximum carried tail length. The longest possible sentinel line is ~30
 * chars (`\n` + prefix(21) + 3 exit-code digits + suffix(2) + `\r\n`); 64
 * leaves comfortable headroom while bounding per-chunk concat cost.
 */
export const SENTINEL_CARRY_MAX = 64;

/**
 * Compute the tail of `combined` (= previous carry + current chunk) to carry
 * into the NEXT chunk's sentinel scan when no sentinel matched.
 *
 * Anchor-safe: the carry always starts at a REAL `\n` from the stream, so
 * prepending it to the next chunk can never fabricate the `(?:^|\r?\n)`
 * line-start anchor (a naive `slice(-64)` could cut mid-line and turn
 * `x__SIGMALINK…` into a string-start false positive).
 *
 * When the in-flight line is already longer than any sentinel can be, no
 * partial sentinel can be pending → carry nothing. This also bounds memory on
 * newline-free streams (progress bars, spinners).
 */
export function sliceSentinelCarry(combined: string): string {
  const lastNl = combined.lastIndexOf('\n');
  if (lastNl === -1) return '';
  const tail = combined.slice(lastNl); // includes the '\n' anchor
  return tail.length > SENTINEL_CARRY_MAX ? '' : tail;
}
```

Run: `npx vitest run src/main/core/pty/sentinel.test.ts`
Expected: PASS (whole file).

- [ ] **Task 4 / Step 4: Write the failing registry integration tests** — append at the END of `src/main/core/pty/registry-lifecycle.test.ts` (the `SENTINEL_PREFIX`/`SENTINEL_SUFFIX` imports from Task 1 are now used):

```typescript
describe('shell-first sentinel split across PTY reads (finding 4)', () => {
  function createShellFirstSession(
    cliExits: Array<{ sessionId: string; exitCode: number }>,
    forwarded: string[],
  ) {
    const fake = makeLifecyclePty();
    vi.mocked(spawnLocalPty).mockReturnValue(fake.pty);
    const registry = new PtyRegistry(
      (_sid, data) => forwarded.push(data),
      () => undefined,
      { onCliExited: (info) => cliExits.push(info) },
    );
    const sess = registry.create({ ...baseInput, spawnMode: 'shell-first' });
    return { fake, registry, sess };
  }

  it('fires onCliExited when the sentinel is split across two chunks', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const { fake, sess } = createShellFirstSession(cliExits, []);

    fake.fireData(`CLI done\n${SENTINEL_PREFIX}`);
    expect(cliExits).toHaveLength(0); // not complete yet
    fake.fireData(`0${SENTINEL_SUFFIX}\n`);

    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]).toEqual({ sessionId: sess.id, exitCode: 0 });
  });

  it('fires onCliExited when the sentinel is split across THREE chunks (multi-chunk carry)', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const { fake } = createShellFirstSession(cliExits, []);

    fake.fireData('\n__SIGMALINK');
    fake.fireData('_CLI_EXIT_4');
    fake.fireData('2__\n');

    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]?.exitCode).toBe(42);
  });

  it('forwards both raw halves unchanged (carry is detection-only, never retro-strips)', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const forwarded: string[] = [];
    const { fake } = createShellFirstSession(cliExits, forwarded);

    fake.fireData(`CLI done\n${SENTINEL_PREFIX}`);
    fake.fireData(`0${SENTINEL_SUFFIX}\n`);

    // Bytes already forwarded cannot be retracted; the carry must never
    // rewrite the forwarded stream — only detect.
    expect(forwarded).toEqual([`CLI done\n${SENTINEL_PREFIX}`, `0${SENTINEL_SUFFIX}\n`]);
  });

  it('does not false-positive on a partial prefix followed by unrelated text, and still catches a later real sentinel', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const { fake } = createShellFirstSession(cliExits, []);

    fake.fireData(`\n${SENTINEL_PREFIX}`);
    fake.fireData('… just ordinary CLI output flowing past the marker prefix, well over the carry cap …');
    expect(cliExits).toHaveLength(0);

    fake.fireData(`\n${SENTINEL_PREFIX}7${SENTINEL_SUFFIX}\n`);
    expect(cliExits).toHaveLength(1);
    expect(cliExits[0]?.exitCode).toBe(7);
  });

  it('whole-chunk sentinels still strip from the forwarded data (existing fast path unchanged)', () => {
    const cliExits: Array<{ sessionId: string; exitCode: number }> = [];
    const forwarded: string[] = [];
    const { fake } = createShellFirstSession(cliExits, forwarded);

    fake.fireData(`visible\n${SENTINEL_PREFIX}0${SENTINEL_SUFFIX}\nprompt`);

    expect(cliExits).toHaveLength(1);
    expect(forwarded[0]).not.toContain(SENTINEL_PREFIX);
    expect(forwarded[0]).toContain('visible');
    expect(forwarded[0]).toContain('prompt');
  });
});
```

Run: `npx vitest run src/main/core/pty/registry-lifecycle.test.ts`
Expected: FAIL — the two split tests and the false-positive-then-real test report `cliExits` empty after the completing chunk. The detection-only and whole-chunk tests pass (current behaviour).

- [ ] **Task 4 / Step 5: Implement the registry carry** — two edits in `src/main/core/pty/registry.ts`.

**Edit A** — import (registry.ts:22). Change:

```typescript
import { extractSentinel } from './sentinel';
```

to:

```typescript
import { extractSentinel, sliceSentinelCarry } from './sentinel';
```

**Edit B** — the onData sentinel block. Replace (registry.ts:254-271, starting at `const unsubData = pty.onData((rawData) => {` through the closing `}` of the sentinel `if` — keep everything from `buffer.append(data);` down unchanged):

```typescript
    const unsubData = pty.onData((rawData) => {
      // v1.6.0 Phase 2 — sentinel detection (shell-first mode only).
      // In shell-first mode the injected command line ends with a `; printf …`
      // snippet that emits the sentinel after the CLI exits.  We intercept it
      // here, strip it from the forwarded data (users must not see the raw
      // marker), and fire the cli-exited signal without tearing down the pane.
      let data = rawData;
      if (effectiveSpawnMode === 'shell-first' && cliExitedSink) {
        const match = extractSentinel(rawData);
        if (match !== null) {
          data = match.strippedData;
          try {
            cliExitedSink({ sessionId: id, exitCode: match.exitCode });
          } catch {
            /* never let a cli-exited listener break the data stream */
          }
        }
      }
```

with:

```typescript
    // 2026-06-10 audit (finding 4) — per-session tail carried between PTY
    // reads so a sentinel split across two (or more) chunks still matches.
    // DETECTION-ONLY: bytes from a previous chunk were already forwarded to
    // the renderer and can never be retracted, so the carry path never
    // rewrites `data` — only whole-chunk matches keep the stripping behaviour.
    let sentinelCarry = '';
    const unsubData = pty.onData((rawData) => {
      // v1.6.0 Phase 2 — sentinel detection (shell-first mode only).
      // In shell-first mode the injected command line ends with a `; printf …`
      // snippet that emits the sentinel after the CLI exits.  We intercept it
      // here, strip it from the forwarded data (users must not see the raw
      // marker), and fire the cli-exited signal without tearing down the pane.
      let data = rawData;
      if (effectiveSpawnMode === 'shell-first' && cliExitedSink) {
        const match = extractSentinel(rawData);
        if (match !== null) {
          data = match.strippedData;
          sentinelCarry = '';
          try {
            cliExitedSink({ sessionId: id, exitCode: match.exitCode });
          } catch {
            /* never let a cli-exited listener break the data stream */
          }
        } else {
          // Cross-chunk: scan carry + chunk. A match here necessarily spans
          // the chunk boundary (a whole-chunk match took the branch above),
          // so the first half already rendered — fire the signal but forward
          // the current chunk unchanged.
          const combined = sentinelCarry + rawData;
          const spanned = sentinelCarry.length > 0 ? extractSentinel(combined) : null;
          if (spanned !== null) {
            sentinelCarry = '';
            try {
              cliExitedSink({ sessionId: id, exitCode: spanned.exitCode });
            } catch {
              /* never let a cli-exited listener break the data stream */
            }
          } else {
            sentinelCarry = sliceSentinelCarry(combined);
          }
        }
      }
```

(Everything from `buffer.append(data);` onward in the handler stays byte-for-byte as it was.)

- [ ] **Task 4 / Step 6: Run — integration tests pass, full pty suite green**

Run: `npx vitest run src/main/core/pty/registry-lifecycle.test.ts`
Expected: PASS (9 tests).

Run: `npx vitest run src/main/core/pty/`
Expected: PASS — in particular the existing `PtyRegistry — Phase 2 sentinel detection` and `Phase 2 direct-mode regression guard` describes in registry.test.ts (the fast path and direct-mode behaviour are unchanged).

- [ ] **Task 4 / Step 7: Commit**

```bash
git add src/main/core/pty/sentinel.ts src/main/core/pty/sentinel.test.ts src/main/core/pty/registry.ts src/main/core/pty/registry-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
fix(pty): cross-chunk sentinel carry so split CLI-exit markers still fire onCliExited

Finding 4 (2026-06-10 audit): extractSentinel ran per PTY read with no carry —
a \n__SIGMALINK_CLI_EXIT_N__\n marker split across two reads never matched, so
onCliExited never fired in shell-first mode (the DEFAULT since Phase 7). The
registry now carries an anchor-safe ≤64-char per-session tail (from the last
real newline) and scans carry+chunk — detection-only: forwarded data is never
rewritten retroactively.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Final gate (run from `/Users/aisigma/projects/SigmaLink/app`)

- [ ] `npx tsc -b` — expected: clean (covers the rpc-router wiring that vitest cannot load).
- [ ] `npx eslint . --max-warnings 0` — expected: clean.
- [ ] `npx vitest run` — expected: all green. Under-load full-suite timeouts in swarms/factory or VoiceTab are known flakes — re-run the failing FILE in isolation before reacting.
- [ ] `npm run product:check` — expected: clean (build + electron:compile).
- [ ] **NO local e2e** (`npx playwright test`) and NO `electron:dev` on the operator's machine — defer e2e to the CI e2e-matrix on the PR.

---

## Coordination notes

- **Sibling batch — worktree-reaper-fence plan** also touches `resume-launcher.ts` (the keep/use predicates around `listEligibleRows`/`listRespawnableRows`). This plan's Tasks 2–3 touch the spawn-loop BODIES and `attachExitPersistence`, not the SELECTs — conflicts should be textual only, but coordinate landing order and re-run the resume-launcher suite after the second one merges. Remember the invariant: reaper keep-set ⊇ resume/use-set.
- **rpc-boundary plan** touches `rpc-router.ts`. Task 2's three-call-site wiring (panesCtl resume/respawnFailed/resumeSelected) will conflict textually with any panesCtl refactor — whichever lands second must re-run `grep -n "resumeWorkspacePanes(\|respawnFailedWorkspacePanes(" src/main/rpc-router.ts` and confirm all 3 sites still pass `broadcastPtyError`.
- **win32-spawn plan** touches `local-pty.ts`. This plan does NOT modify local-pty.ts, but `registry-lifecycle.test.ts` reproduces the `resolveEffectiveSpawnMode` mock contract (same as registry.test.ts) — if that signature changes, update BOTH test files' mocks.
- **Shared-tree discipline:** SigmaLink runs many concurrent sessions; integrate in an ISOLATED worktree off `origin/main`, commit atomically per task, push a fresh branch immediately. Re-gate in MAIN before the PR (`tsc -b` checks test files; worktree tsc can be laxer).
- **registry.ts size:** 525 lines pre-change, ~570 after — already over the 500-line guideline. A split is explicitly OUT of scope for this behavior-fix batch; park a `registry.ts` decomposition note in the WISHLIST instead.
- **Behavioral note for reviewers:** Task 1's create()-throw on a live duplicate converts a silent zombie-overwrite into a visible failed-resume toast for the SECOND concurrent caller (the row may briefly read exited/-1 while the first caller's pane is alive; the next resume pass skips it as `already-running`). This is the intended trade — never orphan a live PTY.
- **Renderer contract check (Task 2):** the `pty:error` broadcast payload `{ sessionId, exitCode, signal }` is identical to the existing executeLaunchPlan broadcast (rpc-router.ts:1470), so the renderer's existing crash-banner handler needs no changes.

## Self-review (performed at plan-writing time, fixes applied inline)

1. **Spec coverage:** F1 → Task 1 (timer guard + duplicate-create + double-spawn zombie prevention). F2 → Task 2 (isPtyCrash + pty:error + 3-site router wiring). F3 → Task 3 (heal gate + null-stale-ids for all providers). F4 → Task 4 (anchor-safe carry, detection-only). F5 → folded into Task 1 Edit B + test. No gaps; no findings refuted.
2. **Placeholder scan:** every test and implementation step carries complete code; no TBD/“similar to Task N”.
3. **Type consistency:** `broadcastPtyError` payload `{ sessionId: string; exitCode: number | null; signal?: string | null }` matches `LaunchDeps.broadcastPtyError` (workspaces/launcher.ts:92) and the rpc-router broadcast; `attachExitPersistence`'s 4th param reuses `ResumeLauncherDeps['broadcastPtyError']`; `sliceSentinelCarry(combined: string): string` is used with exactly that shape in registry.ts; the Task 2/3 fakes reuse the file's existing `setupDb`/`insertSession`/`makeSession`/`VALID_CLAUDE_SESSION_ID` symbols (all verified present). Fixed during review: the Task 2 fail-step now notes the failure first manifests as the deps-field type error; the Task 1 test file notes the sentinel imports only become used in Task 4.
