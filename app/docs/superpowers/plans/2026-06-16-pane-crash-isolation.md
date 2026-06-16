# Pane Crash Isolation + Resume-Loop Backoff + Boot Safety Net — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the post-power-loss restart crash loop where restoring panes takes down the whole command room ("panes crash → go to workspace", every restart), and make the failure self-contained, non-recurring, and diagnosable.

**Architecture:** Four additive/defensive changes — (1) a per-pane React error boundary so one bad pane can't crash the room; (2) failed resumes land in a non-resume-eligible state so they don't retry forever; (3) main-process `uncaughtException`/`unhandledRejection` handlers + a boot `.catch()`; (4) a persisted diagnostics log (capturing the renderer's existing `[ErrorBoundary]` console output) so the exact throwing component is recoverable for a surgical follow-up.

**Tech Stack:** React 18 (class error boundaries), Electron ^30, better-sqlite3 (tested via the existing hand-rolled fake `db`), vitest + jsdom.

**Base:** worktree `/Users/aisigma/projects/SigmaLink-pane-crash-fix` on branch `fix/pane-crash-isolation` off `origin/main` @ `c44868a` (v2.7.0). `node_modules` is symlinked from the main tree. Run all commands from the `app/` subdir.

**Spec:** `app/docs/superpowers/specs/2026-06-16-pane-crash-isolation-design.md`

---

## File Structure

- **Modify** `app/src/renderer/app/ErrorBoundary.tsx` — add `PaneFallback` + `PaneErrorBoundary` (reuses the existing `ErrorBoundary` class + `copyDiagnostics`).
- **Modify** `app/src/renderer/features/command-room/CommandRoom.tsx` — wrap the per-pane `<PaneShell>` in `<PaneErrorBoundary>`.
- **Modify** `app/src/renderer/app/ErrorBoundary.test.tsx` — pane-isolation test.
- **Modify** `app/src/main/core/pty/resume-launcher.ts` — `markResumeFailed` writes `status='error'` instead of `exited,-1`.
- **Modify** `app/src/main/core/pty/resume-launcher.test.ts` — update the existing failed-resume test + fake-db handler + add a re-eligibility assertion.
- **Create** `app/electron/diagnostics-log.ts` — `appendDiagnostic`, `formatError`, `attachRendererLogCapture` (pure, injectable file path).
- **Create** `app/electron/diagnostics-log.test.ts` — log writer tests.
- **Modify** `app/electron/main.ts` — `process.on` handlers + boot `.catch()` + wire `attachRendererLogCapture` in `buildWindow`.

Tasks 1, 2, and 3 touch disjoint files and may be implemented in parallel lanes; Task 4 (full gate) runs last.

---

### Task 1: Per-pane error boundary (renderer)

**Files:**
- Modify: `app/src/renderer/app/ErrorBoundary.tsx`
- Modify: `app/src/renderer/features/command-room/CommandRoom.tsx:437-472`
- Test: `app/src/renderer/app/ErrorBoundary.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `app/src/renderer/app/ErrorBoundary.test.tsx` (it already imports `render`, `screen` from `@testing-library/react` and `RootErrorBoundary` from `./ErrorBoundary` — add `PaneErrorBoundary` to that import):

```tsx
import { PaneErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('pane render exploded');
}

describe('PaneErrorBoundary (pane isolation)', () => {
  it('contains a throwing pane and renders the pane fallback', () => {
    render(
      <PaneErrorBoundary>
        <Boom />
      </PaneErrorBoundary>,
    );
    expect(screen.getByText("This pane couldn’t render")).toBeTruthy();
    expect(screen.getByText('pane render exploded')).toBeTruthy();
  });

  it('isolates the crash: a sibling boundary still renders its content', () => {
    render(
      <div>
        <PaneErrorBoundary>
          <Boom />
        </PaneErrorBoundary>
        <PaneErrorBoundary>
          <div>healthy sibling pane</div>
        </PaneErrorBoundary>
      </div>,
    );
    expect(screen.getByText("This pane couldn’t render")).toBeTruthy();
    expect(screen.getByText('healthy sibling pane')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/renderer/app/ErrorBoundary.test.tsx`
Expected: FAIL — `PaneErrorBoundary` is not exported from `./ErrorBoundary`.

- [ ] **Step 3: Implement `PaneFallback` + `PaneErrorBoundary`**

In `app/src/renderer/app/ErrorBoundary.tsx`, add `X` to the lucide import (currently `import { AlertTriangle, ClipboardCopy, RefreshCcw } from 'lucide-react';`):

```tsx
import { AlertTriangle, ClipboardCopy, RefreshCcw, X } from 'lucide-react';
```

Then append (after `RoomErrorBoundary`, end of file):

```tsx
/**
 * Per-pane fallback — compact, fills the pane cell. A single pane's render throw
 * is contained here instead of bubbling to the room boundary and taking down the
 * whole command room. Offers Relaunch (re-spawn the pane), Close pane (soft-delete
 * so it does NOT resurrect on restart), and Copy diagnostics.
 */
function PaneFallback({
  error,
  componentStack,
  reset,
  onRelaunch,
  onClose,
}: BoundaryRenderState & { onRelaunch?: () => void; onClose?: () => void }) {
  return (
    <div className="sl-fade-in flex h-full min-h-0 w-full flex-col items-center justify-center bg-card p-4">
      <EmptyState
        icon={AlertTriangle}
        title="This pane couldn’t render"
        description={error.message || 'An unexpected error occurred while rendering this pane.'}
        className="h-auto"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRelaunch ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={() => {
                  reset();
                  onRelaunch();
                }}
              >
                <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
                Relaunch
              </Button>
            ) : null}
            {onClose ? (
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                <X className="h-3.5 w-3.5" aria-hidden />
                Close pane
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void copyDiagnostics(error, componentStack)}
            >
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
              Copy diagnostics
            </Button>
          </div>
        }
      />
    </div>
  );
}

/**
 * Wrap each command-room pane so one pane's render throw is contained to its own
 * cell — the room, the sidebar, and every sibling pane keep working. `onRelaunch`
 * / `onClose` are the same handlers the pane chrome uses.
 */
export function PaneErrorBoundary({
  children,
  onRelaunch,
  onClose,
}: {
  children: ReactNode;
  onRelaunch?: () => void;
  onClose?: () => void;
}) {
  return (
    <ErrorBoundary
      label="pane"
      fallback={(s) => <PaneFallback {...s} onRelaunch={onRelaunch} onClose={onClose} />}
    >
      {children}
    </ErrorBoundary>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/renderer/app/ErrorBoundary.test.tsx`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Wire `PaneErrorBoundary` into CommandRoom**

In `app/src/renderer/features/command-room/CommandRoom.tsx`, add to the imports near the other command-room imports:

```tsx
import { PaneErrorBoundary } from '@/renderer/app/ErrorBoundary';
```

Then in `renderLeaf` (currently `return ( <PaneShell ... /> );` at lines ~443-471), wrap the returned `<PaneShell …>` element so it reads:

```tsx
            return (
              <PaneErrorBoundary
                onRelaunch={() => void handleRelaunch(session)}
                onClose={() => handleRemove(session)}
              >
                <PaneShell
                  session={session}
                  paneIndex={paneIndex}
                  providers={providers}
                  workspaceRootPath={activeWorkspace.rootPath}
                  onFocus={() => {
                    dispatch({ type: 'CLEAR_SESSION_ATTENTION', sessionId: session.id });
                    if (activeSessionId !== session.id) dispatch({ type: 'SET_ACTIVE_SESSION', id: session.id });
                  }}
                  onRemove={() => handleRemove(session)}
                  onStop={() => handleStop(session)}
                  onRelaunch={() => void handleRelaunch(session)}
                  onSplit={(dir, providerId) => void handleSplitPane(session, dir, providerId)}
                  onToggleMinimise={() => handleToggleMinimise(session)}
                  isFullscreen={focusedPaneId === session.id}
                  onToggleFullscreen={() =>
                    dispatch(
                      focusedPaneId === session.id
                        ? { type: 'UNFOCUS_PANE' }
                        : { type: 'FOCUS_PANE', paneId: session.id },
                    )
                  }
                  skillBindings={paneBindings}
                  onSkillDrop={(name, source) =>
                    void attachSkill({ paneSessionId: session.id, skillName: name, skillSource: source })
                  }
                  onSkillDetach={(bindingId) => void detachSkill(bindingId)}
                />
              </PaneErrorBoundary>
            );
```

(The pane cell in `PaneGrid` is already keyed by `sessionId`, so the boundary remounts cleanly per pane — no extra `key` needed.)

- [ ] **Step 6: Run the affected suites**

Run: `cd app && npx vitest run src/renderer/app/ErrorBoundary.test.tsx src/renderer/features/command-room/CommandRoom.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-pane-crash-fix
git add app/src/renderer/app/ErrorBoundary.tsx app/src/renderer/app/ErrorBoundary.test.tsx app/src/renderer/features/command-room/CommandRoom.tsx
git commit -m "fix(command-room): per-pane error boundary so one bad pane can't crash the room"
```

---

### Task 2: Resume backoff — failed resumes stop retrying forever (main)

**Files:**
- Modify: `app/src/main/core/pty/resume-launcher.ts:264-278` (`markResumeFailed`)
- Test: `app/src/main/core/pty/resume-launcher.test.ts:69-166` (fake db) and `:348-373` (existing failed-resume test)

- [ ] **Step 1: Update the existing failed-resume test to the new expectation + add a re-eligibility assertion**

In `app/src/main/core/pty/resume-launcher.test.ts`, replace the body assertions of the test at line 348 (`'marks failed resumes as exited without throwing'`). Rename it and change the final assertions:

```tsx
  it('marks failed resumes as error (not resume-eligible) without throwing', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-fail' });
    const registry = {
      get: () => undefined,
    } as unknown as PtyRegistry;
    const resolve = (() => {
      throw new Error('spawn failed');
    }) as NonNullable<ResumeLauncherDeps['resolve']>;

    const deps = {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      now: () => 2222,
      getProvider: () => claudeProvider,
      resolve,
    };

    const result = await resumeWorkspacePanes('ws-1', deps);

    expect(result.resumed.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.error).toBe('spawn failed');
    // A failed resume must NOT remain in the resume-eligible exited/-1 bucket —
    // otherwise it retries (and re-fails) on every boot forever. It lands in
    // 'error', which the renderer surfaces as the crashed/Relaunch card.
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.exit_code).toBe(-1);
    expect(rows[0]?.exited_at).toBe(2222);

    // Re-running resume must now skip it (no infinite retry loop).
    const second = await resumeWorkspacePanes('ws-1', deps);
    expect(second.resumed.length).toBe(0);
    expect(second.failed.length).toBe(0);
  });
```

- [ ] **Step 2: Teach the fake db's `run` handler the new SQL**

In `setupDb` (`resume-launcher.test.ts`), inside the `run(...)` handler, add a branch for the new `status = 'error'` UPDATE. Insert it immediately AFTER the `if (/status = 'running'/.test(sql)) { … }` block (lines ~117-127) and BEFORE the `if (/status = 'exited'/.test(sql))` block:

```tsx
          if (/status = 'error'/.test(sql)) {
            const [exitedAt, sessionId] = args as [number, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) {
              row.status = 'error';
              row.exit_code = -1;
              row.exited_at = exitedAt;
            }
            return { changes: row ? 1 : 0 };
          }
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd app && npx vitest run src/main/core/pty/resume-launcher.test.ts -t "marks failed resumes"`
Expected: FAIL — production still writes `status='exited'`, so `rows[0].status` is `'exited'`, not `'error'`.

- [ ] **Step 4: Change `markResumeFailed` to a non-resume-eligible state**

In `app/src/main/core/pty/resume-launcher.ts`, change `markResumeFailed` (lines 264-278). Replace its body:

```ts
function markResumeFailed(
  db: Database.Database,
  sessionId: string,
  now: number,
): void {
  try {
    // A failed resume must NOT stay in the resume-eligible `exited, exit_code=-1`
    // bucket (which `listEligibleRows` matches) — otherwise the same broken pane
    // is retried, and re-fails, on EVERY boot forever (the post-power-loss crash
    // loop). Land it in `error`, which is not resume-eligible and which the
    // renderer surfaces as the crashed/Relaunch card. `exit_code=-1` is kept as
    // the "no real exit code" sentinel. The orphaned-running → exited/-1 path in
    // the boot janitor is unchanged, so legitimate force-quit resume still works.
    db.prepare(
      `UPDATE agent_sessions
       SET status = 'error', exit_code = -1, exited_at = ?
       WHERE id = ?`,
    ).run(now, sessionId);
  } catch {
    /* best-effort; caller still returns failure details */
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd app && npx vitest run src/main/core/pty/resume-launcher.test.ts`
Expected: PASS (the whole file — confirms no sibling test relied on the old `exited,-1` failure marker).

- [ ] **Step 6: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-pane-crash-fix
git add app/src/main/core/pty/resume-launcher.ts app/src/main/core/pty/resume-launcher.test.ts
git commit -m "fix(resume): failed resume → 'error' (not exited/-1) so it stops retrying every boot"
```

---

### Task 3: Main-process safety net + persisted diagnostics log

**Files:**
- Create: `app/electron/diagnostics-log.ts`
- Create: `app/electron/diagnostics-log.test.ts`
- Modify: `app/electron/main.ts` (`buildWindow` ~633; after the single-instance lock block ~871; the `app.whenReady().then(...)` chain ~897)

- [ ] **Step 1: Write the failing test for the log writer**

Create `app/electron/diagnostics-log.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendDiagnostic, formatError, attachRendererLogCapture } from './diagnostics-log.ts';

const tmps: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-diag-'));
  tmps.push(dir);
  return path.join(dir, 'nested', 'diagnostics.log');
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(path.dirname(d), { recursive: true, force: true });
});

describe('appendDiagnostic', () => {
  it('creates parent dirs and appends a line', () => {
    const f = tmpFile();
    appendDiagnostic(f, 'first');
    appendDiagnostic(f, 'second');
    expect(fs.readFileSync(f, 'utf8')).toBe('first\nsecond\n');
  });

  it('trims the file when it exceeds the cap', () => {
    const f = tmpFile();
    const big = 'x'.repeat(300 * 1024);
    appendDiagnostic(f, big);
    expect(fs.statSync(f).size).toBeLessThanOrEqual(256 * 1024);
  });

  it('never throws on a bad path', () => {
    expect(() => appendDiagnostic('/this/does/not/exist/\0/bad', 'x')).not.toThrow();
  });
});

describe('formatError', () => {
  it('formats a kind, message and stack with a timestamp', () => {
    const out = formatError('uncaughtException', new Error('boom'), '2026-06-16T00:00:00.000Z');
    expect(out).toContain('[2026-06-16T00:00:00.000Z] uncaughtException: boom');
    expect(out).toContain('Error: boom');
  });
  it('coerces non-Error reasons', () => {
    expect(formatError('unhandledRejection', 'plain', '2026-06-16T00:00:00.000Z')).toContain(
      'unhandledRejection: plain',
    );
  });
});

describe('attachRendererLogCapture', () => {
  function fakeWc() {
    let cb: ((e: unknown, level: number, message: string) => void) | null = null;
    return {
      on: (_evt: string, fn: (e: unknown, level: number, message: string) => void) => {
        cb = fn;
      },
      emit: (level: number, message: string) => cb?.({}, level, message),
    };
  }

  it('captures error-level and [ErrorBoundary] messages, ignores chatter', () => {
    const f = tmpFile();
    const wc = fakeWc();
    attachRendererLogCapture(wc as never, f);
    wc.emit(1, 'just an info log'); // ignored
    wc.emit(2, 'a warning or error'); // captured (level >= 2)
    wc.emit(0, '[ErrorBoundary] room Error: boom at PaneShell'); // captured (marker)
    const out = fs.readFileSync(f, 'utf8');
    expect(out).not.toContain('just an info log');
    expect(out).toContain('a warning or error');
    expect(out).toContain('[ErrorBoundary] room');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run electron/diagnostics-log.test.ts`
Expected: FAIL — `./diagnostics-log.ts` does not exist.

- [ ] **Step 3: Implement `diagnostics-log.ts`**

Create `app/electron/diagnostics-log.ts`:

```ts
// Persisted crash diagnostics. Best-effort, never-throwing file logging for
// main-process uncaught errors AND renderer console output (we capture the
// renderer's existing `console.error('[ErrorBoundary]', …)` via the main-side
// `console-message` event — no IPC channel or preload change needed). The point
// is that after ANY crash the exact throwing component + stack is on disk, so a
// surgical fix needs no DevTools work from the user.
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 256 * 1024; // cap; on overflow keep the most-recent half

/** Append a line to `file` (creating parents), trimming to the cap. Never throws. */
export function appendDiagnostic(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    const st = fs.statSync(file);
    if (st.size > MAX_LOG_BYTES) {
      const buf = fs.readFileSync(file);
      fs.writeFileSync(file, buf.subarray(buf.length - Math.floor(MAX_LOG_BYTES / 2)));
    }
  } catch {
    /* diagnostics logging must never cascade into another failure */
  }
}

/** Format a main-process error for the log. */
export function formatError(kind: string, err: unknown, iso: string): string {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  return `[${iso}] ${kind}: ${e.message}\n${e.stack ?? ''}`;
}

interface ConsoleCapableWebContents {
  on(
    event: 'console-message',
    listener: (event: unknown, level: number, message: string, line?: number, sourceId?: string) => void,
  ): void;
}

/**
 * Persist renderer console errors. Electron ^30 uses the legacy
 * `(event, level, message, line, sourceId)` signature where `level` is numeric
 * (≥2 ⇒ warning/error). We also always capture our own `[ErrorBoundary]` marker
 * regardless of level, since that line carries the React component stack.
 */
export function attachRendererLogCapture(wc: ConsoleCapableWebContents, file: string): void {
  wc.on('console-message', (_event, level, message) => {
    if (level >= 2 || message.startsWith('[ErrorBoundary]')) {
      appendDiagnostic(file, `[${new Date().toISOString()}] [renderer] ${message}`);
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run electron/diagnostics-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire handlers + capture into `main.ts`**

In `app/electron/main.ts`:

(a) Add the import near the other local `electron/` imports:

```ts
import { appendDiagnostic, attachRendererLogCapture, formatError } from './diagnostics-log';
```

(b) Add a small helper + the process handlers immediately AFTER the single-instance lock block (after line 871, before the `ipcMain.on('app:session-snapshot', …)` block):

```ts
// V3 boot safety net — there were previously ZERO process-level handlers, and
// the `app.whenReady().then(...)` chain below had no `.catch()`, so any unhandled
// main-side error during boot killed the process silently with no log and no
// recovery. Log every uncaught error/rejection to a persisted diagnostics file.
function diagnosticsLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'diagnostics.log');
}
function logMainError(kind: string, err: unknown): void {
  appendDiagnostic(diagnosticsLogPath(), formatError(kind, err, new Date().toISOString()));
}
process.on('uncaughtException', (err) => logMainError('uncaughtException', err));
process.on('unhandledRejection', (reason) => logMainError('unhandledRejection', reason));
```

(c) In `buildWindow` (line 633), after `const win = new BrowserWindow({ … });` and before `win` is returned, attach renderer capture:

```ts
  attachRendererLogCapture(win.webContents, path.join(app.getPath('userData'), 'logs', 'diagnostics.log'));
```

(d) Add a `.catch()` to the boot chain. Change the chain head at line 897 from:

```ts
void app.whenReady().then(async () => {
```

to keep that line, and change its tail — the `});` that closes the `.then(async () => { … })` (find the matching close of the `whenReady().then` callback) — to:

```ts
}).catch((err) => {
  logMainError('boot', err);
  try {
    showDiagnosticWindow([{ name: 'boot', ok: false, detail: String(err) }]);
  } catch {
    /* last-resort: the error is already on disk via logMainError */
  }
});
```

> Implementation note: verify the `showDiagnosticWindow` argument shape matches its definition (it is already imported and used at main.ts:935 with the `checkNativeModules()` result — `{ name, ok, detail? }[]`). If the `detail` field name differs, match the existing call site exactly.

- [ ] **Step 6: Type-check the main bundle**

Run: `cd app && npx tsc -b`
Expected: no errors. (If the worktree's symlinked `node_modules` surfaces unrelated errors in files you did not touch, re-confirm in the main tree per the project's worktree caveat.)

- [ ] **Step 7: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-pane-crash-fix
git add app/electron/diagnostics-log.ts app/electron/diagnostics-log.test.ts app/electron/main.ts
git commit -m "fix(main): uncaughtException/unhandledRejection handlers + boot .catch + persisted renderer-error log"
```

---

### Task 4: Full gate

- [ ] **Step 1: Run the full vitest suite**

Run: `cd app && npx vitest run`
Expected: PASS. (Per project memory, run the WHOLE suite — a change on a mocked dependency can break a sibling mock that scoped runs miss.)

- [ ] **Step 2: Type-check + build**

Run: `cd app && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit any gate fixes (if needed)**

```bash
cd /Users/aisigma/projects/SigmaLink-pane-crash-fix
git add -A && git commit -m "test: gate fixes for pane crash isolation"
```

- [ ] **Step 4: Report**

Summarize: tests added/changed, full-suite result, tsc result. Do NOT push or open a PR until the operator authorizes it. Note the still-open **surgical follow-up**: once the operator hits the crash again, read `~/Library/Application Support/SigmaLink/logs/diagnostics.log` for the exact `[ErrorBoundary]` throwing component, then fix that one bug.

---

## Self-Review

- **Spec coverage:** Part 1 → Task 1; Part 2 → Task 2; Part 3 (handlers + `.catch`) → Task 3 steps 5b/5d; Part 4 (persisted diagnostics) → Task 3 steps 1-5c. All four spec parts mapped. ✓
- **Placeholders:** None — every code step shows the full code; the one `> Implementation note` (showDiagnosticWindow arg shape) is a verification instruction against an existing call site, not a missing implementation.
- **Type consistency:** `PaneErrorBoundary({ children, onRelaunch, onClose })` is defined in Task 1 Step 3 and consumed with exactly those props in Step 5. `appendDiagnostic(file, line)` / `formatError(kind, err, iso)` / `attachRendererLogCapture(wc, file)` signatures match between `diagnostics-log.ts` (Task 3 Step 3), its test (Step 1), and `main.ts` wiring (Step 5). `markResumeFailed(db, sessionId, now)` signature unchanged. ✓
```
