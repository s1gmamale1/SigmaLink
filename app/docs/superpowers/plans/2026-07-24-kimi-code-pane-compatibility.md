# Kimi Code Pane Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SigmaLink panes work correctly with the new single-binary Kimi Code: launching works again, streaming output stops flickering, and Kimi-initiated session renames stick as pane labels.

**Architecture:** Three independent root causes, fixed in priority order. (1) The shell-first PTY spawner hard-fails on a pre-flight PATH probe against Electron's stale `process.env.PATH` — soften the miss on POSIX so the pane's own login shell (which sources `~/.zshrc` and knows `~/.kimi-code/bin`) resolves the binary. (2) `@xterm/headless` parses but does not honor synchronized output (`CSI ? 2026 h/l`) — hold the engine's rAF buffer-change notify between BSU/ESU so Kimi's erase-then-rewrite frames paint atomically. (3) Terminal titles (OSC 0/2) are ingested nowhere — sink them into the existing `onAgentLabel` override plumbing, and stop the prompt-capture titler and the session-GC from clobbering/resurrecting labels.

**Tech Stack:** Electron main (node-pty), renderer TypeScript/React, `@xterm/headless` 6.0.0, vitest (colocated `*.test.ts`, real parser — no xterm mocks), pnpm workspace.

## Global Constraints

- Worktree: `/Users/aisigma/projects/SigmaLink-wt-kimi-code`, branch `fix/kimi-code-pane-rendering`. All paths below are relative to `app/` inside the worktree.
- **Prerequisite (once, before any test):** the worktree has no `node_modules` — run `cd /Users/aisigma/projects/SigmaLink-wt-kimi-code/app && pnpm install`.
- Test command pattern: `cd app && pnpm vitest run <test-file>`. Typecheck gate: `cd app && pnpm exec tsc -b`.
- Do NOT change win32 behavior of the H-9 pre-flight in `local-pty.ts` (win32 is consistently 'direct' end-to-end per H-6; the throw there stays).
- Do NOT change direct-mode pre-flight behavior in `local-pty.ts` — only shell-first.
- Labels are always routed through `setAgentLabel` (`src/renderer/lib/pane-labels.ts`) — it sanitizes (ANSI/control strip, 80-char cap) and no-ops on junk. Never store raw OSC payloads anywhere else.
- Kimi on-disk facts (verified 2026-07-24): binary `~/.kimi-code/bin/kimi`; config `~/.kimi-code/mcp.json`; sessions `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/state.json` with `createdAt`/`updatedAt` (ISO strings), `title`, `isCustomTitle`. Legacy home `~/.kimi/` still exists and must remain a working fallback.

**Source findings:** `WISHLIST.md` → `🔬 Deep review findings (2026-07-24)` sections A/B/C (worktree root).

**Out of scope (stays parked in WISHLIST.md, do NOT implement in this plan):** FlowView scroll-pin churn, `logicalLines()` full-buffer extraction windowing, DECSET-25 `cursorHidden` gating in the views, NAME-slot sync from `state.json`, `shell-path.ts` cache-hit freshness, dead `SIGMA::LABEL` label-reader removal.

---

### Task 1: Shell-first spawn must not hard-fail on Electron's stale PATH

The `+` pane / Workspaces kimi launch throws `ProviderLaunchError('spawn-failed')` before any PTY exists: `spawnShellFirstPty` pre-resolves the command against Electron's own PATH and throws ENOENT on a miss. After the 2026-07 kimi migration the binary lives only in `~/.kimi-code/bin`, which is exported from `~/.zshrc` — visible to the pane's login shell but not to a dev-launched (or stale-cache) Electron. On POSIX shell-first, a pre-flight miss must degrade to injecting the bare command: the login shell resolves it, and a genuine not-found still surfaces via the existing exit-127 sentinel. win32 keeps throwing (it degrades to direct mode anyway, so this path is POSIX-only in practice).

**Files:**
- Modify: `src/main/core/pty/local-pty.ts:694-727` (the H-9 block in `spawnShellFirstPty`)
- Test: `src/main/core/pty/local-pty.test.ts` (existing suite "spawnLocalPty ENOENT pre-flight" — real spawns, no node-pty mock)

**Interfaces:**
- Consumes: `resolvePosixCommand(cmd, env): string | null` (`local-pty.ts:86`), `resolveWindowsCommand(cmd, env): string | null` (`local-pty.ts:65`), `SpawnInput` (has `command`, `args`, `env?`, `cwd?`, `cols`, `rows`, `spawnMode`).
- Produces: unchanged public surface — `spawnLocalPty(input): PtyHandle`. Behavior change: POSIX shell-first with a PATH-missing command no longer throws synchronously; it returns a live shell `PtyHandle` (the shell reports `command not found` + exit 127 via the sentinel if truly absent).

- [ ] **Step 1: Write the failing test**

Append to `src/main/core/pty/local-pty.test.ts` (inside a new `describe`; the file already imports `spawnLocalPty` — check the existing import block at the top and reuse it):

```ts
describe('spawnLocalPty shell-first POSIX soft-miss', () => {
  it.skipIf(process.platform === 'win32')(
    'does NOT throw synchronously when the command is missing from Electron PATH (login shell resolves it)',
    () => {
      // Kimi-after-migration regression: ~/.kimi-code/bin is only on the login
      // shell's PATH (via ~/.zshrc), not Electron's. Shell-first must defer to
      // the pane's own shell instead of hard-failing the launch.
      const handle = spawnLocalPty({
        command: 'sigmalink-definitely-not-a-real-command-xyz',
        args: [],
        cwd: os.homedir(),
        cols: 80,
        rows: 24,
        spawnMode: 'shell-first',
      });
      try {
        expect(handle.pid).toBeGreaterThan(0);
      } finally {
        handle.kill();
      }
    },
  );

  it('direct mode still throws ENOENT synchronously for a missing command', () => {
    expect(() =>
      spawnLocalPty({
        command: 'sigmalink-definitely-not-a-real-command-xyz',
        args: [],
        cwd: os.homedir(),
        cols: 80,
        rows: 24,
        spawnMode: 'direct',
      }),
    ).toThrowError(/ENOENT/);
  });
});
```

If the existing test file does not import `os`, add `import os from 'node:os';` to its imports. If `SpawnInput` requires additional fields in the current signature, copy them from an existing `spawnLocalPty({...})` call in the same test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run src/main/core/pty/local-pty.test.ts`
Expected: FAIL — first new test throws `spawn sigmalink-definitely-not-a-real-command-xyz ENOENT` synchronously (current H-9 behavior). Second new test passes already.

- [ ] **Step 3: Change the H-9 block to soft-miss on POSIX**

In `src/main/core/pty/local-pty.ts`, replace the H-9 pre-flight throw (lines 694-727, the block starting `// H-9 (Wave-2 hardening): synchronous ENOENT pre-flight for shell-first mode.` through the `throw err;` closing brace) with:

```ts
  // H-9 (Wave-2 hardening) + 2026-07 kimi-code migration fix:
  //
  // The pre-flight resolves the command against ELECTRON's PATH so a missing
  // candidate can throw synchronously and drive the launcher's altCommands
  // walk (mirroring direct mode). But Electron's PATH is the WRONG oracle on
  // POSIX shell-first: a dev-launched app never runs the login-shell PATH
  // bootstrap (shell-path.ts isDev no-op) and a packaged warm boot applies a
  // possibly-stale cache — while the pane's own login shell (`zsh -l`,
  // `bash -l`) sources ~/.zshrc / profile and sees user additions like
  // ~/.kimi-code/bin that Electron cannot. A pre-flight miss here used to
  // hard-fail the launch before any PTY existed ("No usable command found
  // for provider kimi") even though typing the same command in a plain
  // terminal pane works fine.
  //
  // POSIX: a miss now degrades to injecting the BARE command — the login
  // shell resolves it if it exists anywhere on the user's real PATH, and a
  // genuine not-found still surfaces via the shell's own "command not found"
  // + the exit-127 sentinel (the launcher-level error path that predates
  // H-9). altCommands on POSIX are Windows shims (*.cmd) in practice, so
  // skipping the fallback walk on a POSIX miss loses nothing.
  //
  // win32: keep the synchronous throw — shell-first degrades to direct on
  // win32 end-to-end (H-6), so this branch is effectively unreachable there
  // and stays correct if that ever changes.
  const baseEnv = input.env ?? process.env;
  const resolvedCommand =
    process.platform === 'win32'
      ? resolveWindowsCommand(input.command, baseEnv)
      : resolvePosixCommand(input.command, baseEnv);
  if (!resolvedCommand && process.platform === 'win32') {
    const err = new Error(
      `spawn ${input.command} ENOENT`,
    ) as Error & { code: string; errno: number; syscall: string; path: string };
    err.code = 'ENOENT';
    err.errno = -2;
    err.syscall = 'spawn';
    err.path = input.command;
    throw err;
  }
  if (!resolvedCommand) {
    console.warn(
      `[pty] shell-first: "${input.command}" not on Electron's PATH; ` +
        `deferring to the pane's login shell (exit 127 sentinel covers a genuine miss)`,
    );
  }
```

Note: the existing code below (line ~783 comment + line 792) already injects `input.command` (the bare name) into the shell command line, so no change is needed there — on a hit the resolver result is intentionally unused beyond the gate, on a soft-miss the same bare-name injection is exactly what we want.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run src/main/core/pty/local-pty.test.ts`
Expected: PASS — all tests including the two new ones. The first new test spawns a real `zsh -l`, injects the bogus command, and we kill the handle; nothing asserts on the shell's `command not found` output.

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/main/core/pty/local-pty.ts app/src/main/core/pty/local-pty.test.ts
git commit -m "fix(pty): shell-first soft-miss on POSIX pre-flight — let the pane's login shell resolve the command

Electron's PATH (dev: inherited, no bootstrap; packaged: stale warm-boot
cache) hard-gated launches of binaries the pane's own login shell can
resolve — e.g. kimi after the 2026-07 migration to ~/.kimi-code/bin,
visible only via ~/.zshrc. POSIX shell-first now injects the bare command
on a pre-flight miss; genuine not-found still surfaces via the exit-127
sentinel. win32 throw and direct mode unchanged."
```

---

### Task 2: Honor synchronized output (`CSI ? 2026 h/l`) in the terminal engine

Kimi Code's TUI wraps every repaint frame in synchronized output (BSU/ESU) and repaints via erase-then-rewrite. `@xterm/headless` tracks mode 2026 (exposed as `term.modes.synchronizedOutputMode`) but never defers buffer mutation — so the engine's rAF-coalesced notify can fire between the flush containing the erases and the flush containing the rewrites, painting a blank/torn region for one frame at token rate. Hold the notify while sync mode is set; fire one coalesced notify when it clears.

**Files:**
- Modify: `src/renderer/lib/terminal-engine.ts:83-128` (scheduler + constructor wiring) and `:349-369` (`scheduleNotify`)
- Test: `src/renderer/lib/terminal-engine.test.ts` (real `@xterm/headless` parser in node; `makeEngine` + `flushWrite` helpers already exist)

**Interfaces:**
- Consumes: `term.modes.synchronizedOutputMode: boolean` (xterm typings line 1379), existing `schedule: (cb) => void` rAF/setTimeout shim (`terminal-engine.ts:83-86`).
- Produces: unchanged public surface — `onBufferChanged(cb)` semantics are only re-timed (suppressed mid-frame), never dropped: every suppressed frame ends with exactly one notify (via ESU or the watchdog).

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/lib/terminal-engine.test.ts`:

```ts
describe('TerminalEngine — synchronized output (DECSET 2026)', () => {
  it('holds buffer-change notify between BSU and ESU, then fires once', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 10 });
    track(engine);
    let notifies = 0;
    engine.onBufferChanged(() => notifies++);

    await flushWrite(engine, '\x1b[?2026h'); // BSU — frame opens
    await flushWrite(engine, '\r\x1b[2Kpartial'); // erased intermediate state
    await new Promise((r) => setTimeout(r, 20)); // let any scheduled notify fire
    expect(notifies).toBe(0); // nothing painted mid-frame

    await flushWrite(engine, 'complete frame\x1b[?2026l'); // ESU — frame closes
    await new Promise((r) => setTimeout(r, 20));
    expect(notifies).toBe(1); // exactly one coalesced paint
  });

  it('paints anyway via watchdog when the app dies mid-frame (no ESU)', async () => {
    const { engine } = makeEngine({ cols: 40, rows: 10 });
    track(engine);
    let notifies = 0;
    engine.onBufferChanged(() => notifies++);
    await flushWrite(engine, '\x1b[?2026h');
    await flushWrite(engine, 'orphaned frame');
    await new Promise((r) => setTimeout(r, 1200)); // > 1000ms watchdog, real timers
    expect(notifies).toBeGreaterThan(0);
    // NOTE: do NOT use vi.useFakeTimers() here — xterm's write queue is
    // timer-driven, so fake timers can hang flushWrite before the watchdog
    // is even armed. The 1.2s real-time wait stays under vitest's 5s default.
  });
});
```

(`vi` is already imported in this test file — verify at the top; it is, per the existing `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run src/renderer/lib/terminal-engine.test.ts`
Expected: FAIL — first test gets `notifies` ≥ 1 before ESU (notify fires on the mid-frame write).

- [ ] **Step 3: Implement sync-aware notify**

In `src/renderer/lib/terminal-engine.ts`:

3a. Add a private field near `notifyScheduled` (line ~93):

```ts
  private syncWatchdog: ReturnType<typeof setTimeout> | null = null;
```

3b. Replace the constructor's notify wiring (line 113, `this.disposers.push(this.term.onWriteParsed(() => this.scheduleNotify()));`) with:

```ts
    // Coalesced change notify: bursts of writes collapse to one callback per
    // frame (rAF in the renderer; setTimeout(0) under node tests).
    // DECSET 2026 (synchronized output, BSU/ESU): the app — e.g. Kimi Code's
    // OpenTUI inline renderer — wraps each repaint frame in ?2026h/?2026l and
    // repaints via erase-then-rewrite. xterm tracks the mode but mutates the
    // buffer as bytes arrive, so an unguarded notify can paint the erased
    // intermediate state (the streaming flicker). Hold the notify while sync
    // mode is set; fire once when it clears. A 1s watchdog paints anyway if
    // the app died mid-frame so the pane can never freeze on a held notify.
    this.disposers.push(this.term.onWriteParsed(() => this.onWriteParsedNotify()));
```

3c. Add the method next to `scheduleNotify` (line ~349):

```ts
  private onWriteParsedNotify(): void {
    if (this.term.modes.synchronizedOutputMode) {
      if (!this.syncWatchdog) {
        this.syncWatchdog = setTimeout(() => {
          this.syncWatchdog = null;
          this.scheduleNotify();
        }, 1000);
        (this.syncWatchdog as { unref?: () => void }).unref?.();
      }
      return;
    }
    if (this.syncWatchdog) {
      clearTimeout(this.syncWatchdog);
      this.syncWatchdog = null;
    }
    this.scheduleNotify();
  }
```

3d. In `dispose()` (line ~341), clear the watchdog before disposing:

```ts
    if (this.syncWatchdog) {
      clearTimeout(this.syncWatchdog);
      this.syncWatchdog = null;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run src/renderer/lib/terminal-engine.test.ts`
Expected: PASS — both new tests plus all existing goldens.

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/renderer/lib/terminal-engine.ts app/src/renderer/lib/terminal-engine.test.ts
git commit -m "fix(terminal): honor DECSET 2026 synchronized output in the engine notify

Kimi Code wraps every repaint frame in BSU/ESU and erases-then-rewrites;
xterm tracks the mode but mutates the buffer as bytes arrive, so the rAF
notify painted torn mid-frame state at token rate (streaming flicker).
Hold the buffer-change notify while synchronizedOutputMode is set, fire
once on ESU, 1s watchdog guards against an app dying mid-frame."
```

---

### Task 3: Sink OSC 0/2 terminal titles into the pane label

Kimi's session rename (e.g. "School Account Fix-Agent") arrives as an OSC 0/2 title sequence and is currently consumed by xterm and dropped — no `registerOscHandler(0|1|2)` and no `onTitleChange` wiring exists anywhere. Feed titles into the existing `onAgentLabel` override (it bumps the orchestrator generation, superseding any in-flight prompt summary), on BOTH presenter paths: DOM-mode `TerminalEngine` (wired in `engine-cache.ts`) and xterm-mode `Terminal` (wired in `terminal-cache.ts`).

**Files:**
- Modify: `src/renderer/lib/terminal-engine.ts:88-149` (constructor) and `:163-169` (subscription API, next to `onBufferChanged`)
- Modify: `src/renderer/lib/engine-cache.ts:22-35` (`EngineCacheEntry`), `:95-100` (creation), `:137-147` (destroy)
- Modify: `src/renderer/lib/terminal-cache.ts:440-457` (entry creation; also add `offTitle` to `CacheEntry` and dispose it alongside `onDataDispose`)
- Test: `src/renderer/lib/terminal-engine.test.ts`

**Interfaces:**
- Consumes: `onAgentLabel(sessionId: string, text: string): void` (`src/renderer/lib/pane-title-orchestrator.ts:47`) — sets the label and invalidates in-flight summaries; `term.parser.registerOscHandler(id, (data: string) => boolean)`; xterm's `Terminal.onTitleChange(cb): IDisposable`.
- Produces: NEW `TerminalEngine.onTitleChange(cb: (title: string) => void): () => void` — subscribe to OSC 0/2 title sets; returns an unsubscribe. Raw title string (untrimmed); consumers sanitize via `setAgentLabel`.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/lib/terminal-engine.test.ts`:

```ts
describe('TerminalEngine — OSC title sink', () => {
  it('emits OSC 2 titles to subscribers', async () => {
    const { engine } = makeEngine();
    track(engine);
    const titles: string[] = [];
    engine.onTitleChange((t) => titles.push(t));
    await flushWrite(engine, '\x1b]2;School Account Fix-Agent\x07');
    expect(titles).toEqual(['School Account Fix-Agent']);
  });

  it('emits OSC 0 titles and ignores empty ones', async () => {
    const { engine } = makeEngine();
    track(engine);
    const titles: string[] = [];
    engine.onTitleChange((t) => titles.push(t));
    await flushWrite(engine, '\x1b]0;\x07'); // empty — dropped
    await flushWrite(engine, '\x1b]0;renamed session\x07');
    expect(titles).toEqual(['renamed session']);
  });

  it('unsubscribe stops delivery', async () => {
    const { engine } = makeEngine();
    track(engine);
    const titles: string[] = [];
    const off = engine.onTitleChange((t) => titles.push(t));
    off();
    await flushWrite(engine, '\x1b]2;never seen\x07');
    expect(titles).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run src/renderer/lib/terminal-engine.test.ts`
Expected: FAIL with "engine.onTitleChange is not a function".

- [ ] **Step 3: Implement the engine title sink**

3a. In `src/renderer/lib/terminal-engine.ts`, add a field next to `changeSubs` (line ~92):

```ts
  private readonly titleSubs = new Set<(title: string) => void>();
```

3b. Add the subscription method right after `onBufferChanged` (after line 169):

```ts
  /** Subscribe to OSC 0/2 window-title sets (Kimi/claude rename the session
   *  this way). Raw payload; consumers sanitize. Returns the unsubscribe. */
  onTitleChange(cb: (title: string) => void): () => void {
    this.titleSubs.add(cb);
    return () => {
      this.titleSubs.delete(cb);
    };
  }
```

3c. In the constructor, after the OSC 133 registration (after line 148), add:

```ts
    // OSC 0/2 (icon+window / window title): agent-initiated session renames
    // (Kimi Code, claude /rename). xterm tracks the title internally but
    // nothing surfaces it — sink it to subscribers so the pane label can
    // follow. Return false: xterm's own title bookkeeping still runs.
    const onOscTitle = (data: string): boolean => {
      const title = data.trim();
      if (title) {
        for (const cb of Array.from(this.titleSubs)) {
          try {
            cb(title);
          } catch {
            /* one broken subscriber must never starve the others */
          }
        }
      }
      return false;
    };
    this.disposers.push(this.term.parser.registerOscHandler(0, onOscTitle));
    this.disposers.push(this.term.parser.registerOscHandler(2, onOscTitle));
```

3d. In `dispose()`, clear `this.titleSubs.clear();` next to `this.changeSubs.clear();` (line ~344).

3e. Wire the DOM-mode path in `src/renderer/lib/engine-cache.ts`:
- Add to `EngineCacheEntry` (after `offExit: () => void;`, line 34): `offTitle: () => void;`
- Add the import at the top (next to the label-reader import, line 18): `import { onAgentLabel } from './pane-title-orchestrator';`
- After `attachEngineLabelReader(sessionId, engine);` (line 100):

```ts
  // Agent-initiated renames (OSC 0/2) follow the same override sink as
  // SIGMA::LABEL — supersedes any in-flight prompt summary.
  const offTitle = engine.onTitleChange((t) => onAgentLabel(sessionId, t));
```

- Add `offTitle,` to the entry literal (after `offExit,`, line 96) and `entry.offTitle();` in destroy next to `entry.offExit();` (line ~142).

3f. Wire the xterm-mode path in `src/renderer/lib/terminal-cache.ts`:
- Add the same import: `import { onAgentLabel } from './pane-title-orchestrator';`
- After `attachXtermLabelReader(sessionId, term);` (line 457):

```ts
  // Agent-initiated renames (OSC 0/2) → same override sink as SIGMA::LABEL.
  const offTitle = term.onTitleChange((t) => {
    if (t.trim()) onAgentLabel(sessionId, t);
  });
```

- Add `offTitle: IDisposable`-typed field to `CacheEntry` (match the type of the neighboring `onDataDispose` field — copy its type), include `offTitle` in the `entry` literal at line 440-453, and dispose it where `onDataDispose` is disposed in the cache destroy path.

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `cd app && pnpm vitest run src/renderer/lib/terminal-engine.test.ts src/renderer/lib/engine-cache.test.ts src/renderer/lib/terminal-cache.test.ts src/renderer/lib/pane-title-orchestrator.test.ts && pnpm exec tsc -b`
Expected: PASS — new OSC tests green, existing cache/orchestrator suites (including `'onAgentLabel (voluntary SIGMA::LABEL) overrides + invalidates in-flight summary'`) still green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/renderer/lib/terminal-engine.ts app/src/renderer/lib/terminal-engine.test.ts app/src/renderer/lib/engine-cache.ts app/src/renderer/lib/terminal-cache.ts
git commit -m "fix(labels): sink OSC 0/2 terminal titles into the pane label

Kimi's session rename arrives as an OSC title and was consumed by xterm
and dropped — the pane kept its SigmaLink-given name. Both presenter
paths (DOM engine + xterm) now forward titles into onAgentLabel, the
existing override that supersedes in-flight prompt summaries."
```

---

### Task 4: Slash-command lines must never reach the pane titler

Typing `/rename School Account Fix-Agent` in the pane commits as a "prompt" and gets sent to the cloud summarizer, which retitles the pane from the command text — then the next substantive prompt overwrites it again (last-writer-wins, no lock). A leading `/` is a CLI command, not a task: it should never reach the titler (also a privacy improvement — commands stop going to the cloud summarizer).

**Files:**
- Modify: `src/renderer/lib/pane-prompt-capture.ts:61-73` (`commit`)
- Test: `src/renderer/lib/pane-prompt-capture.test.ts`

**Interfaces:**
- Consumes: existing `commit(sessionId): string | null` internals.
- Produces: unchanged signatures — `feedPromptKey`/`feedPromptPaste`/`commit` behavior changes only for drafts whose first non-space character is `/`: commit returns `null` and the titler is not called.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/lib/pane-prompt-capture.test.ts` (follow the file's existing pattern of feeding keys via `feedPromptKey`; check how existing tests construct the Enter event and reuse that shape):

```ts
it('skips slash-command lines — CLI commands are not tasks', () => {
  const enter = { key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
  for (const ch of '/rename School Account Fix-Agent') {
    feedPromptKey('s1', { key: ch, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  }
  expect(feedPromptKey('s1', enter)).toBeNull();
  expect(getAgentLabel('s1')).toBeNull(); // titler never ran
});
```

Match the actual imports/setup of the existing test file (it already exercises `feedPromptKey` and resets drafts between tests — reuse its `beforeEach` reset, session id style, and `CaptureKeyEvent` literal shape; if the file does not import `getAgentLabel`, import it from `@/renderer/lib/pane-labels` and its `__resetAgentLabels` into the existing reset block).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run src/renderer/lib/pane-prompt-capture.test.ts`
Expected: FAIL — commit returns `'/rename School Account Fix-Agent'` instead of `null`.

- [ ] **Step 3: Implement the skip**

In `src/renderer/lib/pane-prompt-capture.ts`, inside `commit` (line 61), immediately after the `if (!clean || isLikelyAck(clean)) return null;` line, add:

```ts
  // Slash-command lines (/rename, /model, …) are CLI commands, not tasks —
  // they must never re-title the pane (and never reach the cloud titler).
  if (clean.startsWith('/')) return null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run src/renderer/lib/pane-prompt-capture.test.ts`
Expected: PASS — new test plus all existing capture tests (acks, paste, draft cap).

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/renderer/lib/pane-prompt-capture.ts app/src/renderer/lib/pane-prompt-capture.test.ts
git commit -m "fix(labels): never title panes from slash-command lines

/rename & co. are CLI commands, not tasks — they re-titled the pane via
the cloud summarizer and then got clobbered by the next real prompt.
Skipping them also keeps command lines off the cloud titler."
```

---

### Task 5: Session-GC must not resurrect the default label on a transient miss

`useTerminalCacheGc` clears the pane label the first tick a session id is absent from `state.sessionsByWorkspace`; the header then falls back to `summarizePrompt(session.initialPrompt)` — the SigmaLink default name. Any transient omission (session-list refetch racing a PTY burst) produces exactly the reported "rename reset to default". Require two consecutive absent ticks before clearing the label-side stores; terminal-cache destroy stays immediate (it has its own 5s exited-grace upstream).

**Files:**
- Modify: `src/renderer/app/state-hooks/use-terminal-cache-gc.ts:27-74`
- Test: `src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts` (jsdom, `renderHook`, real `pane-labels` store, mocked terminal-cache/scratch-tabs/prompt-watcher/label-reader)

**Interfaces:**
- Consumes: existing hook signature `useTerminalCacheGc(state: AppState): void`.
- Produces: unchanged signature. Timing change: `clearAgentLabel` / `clearPromptDraft` / `clearPaneTitle` fire only after a session id is absent for 2 consecutive effect ticks; `destroy` / `closeScratchForParent` / `disposePromptWatcher` / `detachLabelReader` stay first-tick.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts` (the file already provides `session(id)` and `stateWith(workspaces)` helpers and a `renderHook` pattern — reuse them verbatim):

```ts
it('keeps the pane label through a single transient miss; clears after two', () => {
  const id = 'sess-transient';
  setAgentLabel(id, 'School Account Fix-Agent');
  hasCachedMock.mockReturnValue(true);

  const { rerender } = renderHook(({ state }) => useTerminalCacheGc(state), {
    initialProps: { state: stateWith({ 'ws-1': [session(id)] }) },
  });

  rerender({ state: stateWith({}) }); // tick 1: transient miss
  expect(getAgentLabel(id)).toBe('School Account Fix-Agent');

  rerender({ state: stateWith({}) }); // tick 2: still absent — genuinely gone
  expect(getAgentLabel(id)).toBeNull();
});

it('a session that reappears resets the miss counter', () => {
  const id = 'sess-flap';
  setAgentLabel(id, 'kept');
  hasCachedMock.mockReturnValue(true);

  const { rerender } = renderHook(({ state }) => useTerminalCacheGc(state), {
    initialProps: { state: stateWith({ 'ws-1': [session(id)] }) },
  });

  rerender({ state: stateWith({}) });                  // miss 1
  rerender({ state: stateWith({ 'ws-1': [session(id)] }) }); // reappears — counter resets
  rerender({ state: stateWith({}) });                  // miss 1 again (not 2)
  expect(getAgentLabel(id)).toBe('kept');
});
```

(`setAgentLabel`, `getAgentLabel`, and `__resetAgentLabels` are already imported in this file — verify `__resetAgentLabels()` runs in the existing `beforeEach` and keep it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`
Expected: FAIL — label is `null` after the first miss (current behavior).

- [ ] **Step 3: Implement the two-tick guard**

In `src/renderer/app/state-hooks/use-terminal-cache-gc.ts`, next to `everSeen` (line 32), add:

```ts
  // Label-side stores (pane label, prompt draft, title-orchestrator state)
  // must survive a TRANSIENT session-list miss (e.g. a refetch racing a PTY
  // burst) — clearing them on the first absent tick resurrects the default
  // floor label, which reads as "the rename was reset". Only clear after two
  // consecutive absent ticks. Terminal-cache destroy stays first-tick: the
  // 5s exited-grace upstream already covers real closes.
  const missCount = useRef<Map<string, number>>(new Map());
```

Replace the miss loop body (lines 50-59) with:

```ts
    for (const id of everSeen.current) {
      if (seenNow.has(id)) {
        missCount.current.delete(id);
        continue;
      }
      if (hasCached(id)) destroy(id);
      closeScratchForParent(id);
      disposePromptWatcher(id); // 2026-06-10 finding 4 — no-op if never watched
      detachLabelReader(id);
      const misses = (missCount.current.get(id) ?? 0) + 1;
      if (misses >= 2) {
        missCount.current.delete(id);
        clearAgentLabel(id);
        clearPromptDraft(id);
        clearPaneTitle(id);
      } else {
        missCount.current.set(id, misses);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts`
Expected: PASS — new tests plus existing GC contract tests (destroy-on-close is untouched).

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/renderer/app/state-hooks/use-terminal-cache-gc.ts app/src/renderer/app/state-hooks/use-terminal-cache-gc.test.ts
git commit -m "fix(labels): clear pane labels only after two consecutive session-list misses

A transient sessionsByWorkspace omission cleared the label store and the
header fell back to the default floor label — the 'rename resets to the
SigmaLink name' report. Terminal-cache destroy stays first-tick."
```

---

### Task 6: MCP autowrite targets the new `~/.kimi-code/mcp.json`

The 2026-07 kimi migration moved the MCP config home from `~/.kimi/mcp.json` to `~/.kimi-code/mcp.json`. Autowrite still targets the legacy path, so the ruflo MCP server silently stops being injected for kimi. Prefer the modern path; keep writing the legacy one only when it is the only one that exists (pre-migration installs).

**Files:**
- Modify: `src/main/core/workspaces/mcp-autowrite.ts:132-156` (target selection + `kimiActive`)
- Test: `src/main/core/workspaces/mcp-autowrite.test.ts` (uses the `opts.homeDir` injection)

**Interfaces:**
- Consumes: `fs.existsSync`, `opts.homeDir`, `detectCli('kimi')` — all already in scope in `writeWorkspaceMcpConfig`.
- Produces: unchanged `WorkspaceMcpWriteResult` shape; `kimi` field now points at whichever target was actually written.

- [ ] **Step 1: Write the failing test**

Append to `src/main/core/workspaces/mcp-autowrite.test.ts` (the file already provides `tmpDir(prefix)`, `quietLogger`, and the `writeWorkspaceMcpConfig(root, { homeDir, logger, detectCli })` call shape — reuse them verbatim; `fs`/`path` are already imported):

```ts
it('writes the modern ~/.kimi-code/mcp.json when the migrated home exists', () => {
  const root = tmpDir('sigma-mcp-root-');
  const home = tmpDir('sigma-mcp-home-');
  fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
  const result = writeWorkspaceMcpConfig(root, {
    homeDir: home,
    logger: quietLogger,
    detectCli: () => true,
  });
  expect(result.kimi).toBe(path.join(home, '.kimi-code', 'mcp.json'));
  expect(fs.existsSync(path.join(home, '.kimi-code', 'mcp.json'))).toBe(true);
});

it('falls back to legacy ~/.kimi/mcp.json when only the legacy file exists', () => {
  const root = tmpDir('sigma-mcp-root-');
  const home = tmpDir('sigma-mcp-home-');
  fs.mkdirSync(path.join(home, '.kimi'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kimi', 'mcp.json'), '{}');
  const result = writeWorkspaceMcpConfig(root, {
    homeDir: home,
    logger: quietLogger,
    detectCli: () => true,
  });
  expect(result.kimi).toBe(path.join(home, '.kimi', 'mcp.json'));
});

it('prefers the modern path for fresh machines (neither file exists)', () => {
  const root = tmpDir('sigma-mcp-root-');
  const home = tmpDir('sigma-mcp-home-');
  const result = writeWorkspaceMcpConfig(root, {
    homeDir: home,
    logger: quietLogger,
    detectCli: () => true,
  });
  expect(result.kimi).toBe(path.join(home, '.kimi-code', 'mcp.json'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run src/main/core/workspaces/mcp-autowrite.test.ts`
Expected: FAIL — first and third tests get the legacy path.

- [ ] **Step 3: Implement the target switch**

In `src/main/core/workspaces/mcp-autowrite.ts`, replace line 135 (`const kimiTarget = path.join(home, '.kimi', 'mcp.json');`) with:

```ts
  // 2026-07 kimi-code migration: the single-binary kimi moved its home from
  // ~/.kimi to ~/.kimi-code. Prefer the modern target; keep writing legacy
  // only when it is the only one that exists (pre-migration installs).
  const kimiModernTarget = path.join(home, '.kimi-code', 'mcp.json');
  const kimiLegacyTarget = path.join(home, '.kimi', 'mcp.json');
  const kimiTarget =
    fs.existsSync(kimiModernTarget) || !fs.existsSync(kimiLegacyTarget)
      ? kimiModernTarget
      : kimiLegacyTarget;
```

And replace the `kimiActive` line (146) with:

```ts
  const kimiActive =
    fs.existsSync(kimiModernTarget) || fs.existsSync(kimiLegacyTarget) || detectCli('kimi');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run src/main/core/workspaces/mcp-autowrite.test.ts`
Expected: PASS — new tests plus all existing autowrite/refusal tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/main/core/workspaces/mcp-autowrite.ts app/src/main/core/workspaces/mcp-autowrite.test.ts
git commit -m "fix(mcp): autowrite ruflo into ~/.kimi-code/mcp.json after the kimi migration

The single-binary kimi-code reads ~/.kimi-code/mcp.json; writing only
~/.kimi/mcp.json silently dropped the ruflo MCP injection. Legacy path
kept as fallback for pre-migration installs."
```

---

### Task 7: Resume picker scans the `~/.kimi-code` sessions layout

`listKimiSessions` only walks `~/.kimi/sessions/<bucket>/<uuid>/state.json`. Post-migration sessions live at `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/state.json` with a different state shape (`createdAt`/`updatedAt` ISO strings, `title`, `isCustomTitle`), so the kimi resume picker finds nothing new. Scan both roots and merge.

**Files:**
- Modify: `src/main/core/pty/session-disk-scanner.ts:560-628` (`listKimiSessions`)
- Test: `src/main/core/pty/session-disk-scanner.test.ts`

**Interfaces:**
- Consumes: existing helpers in scope — `safeStat`, `safeReadDir`, `UUID_RE`, `MAX_ENTRIES_PER_DIR`, `trunc`, `workspaceAllowedIds(opts)`, `SessionListItem` (`{ id, providerId, cwd, createdAt, updatedAt, title?, firstMessagePreview? }`).
- Produces: unchanged `listKimiSessions` signature and item shape; results now include modern-layout sessions (deduped by `id`).

- [ ] **Step 1: Write the failing test**

Append to `src/main/core/pty/session-disk-scanner.test.ts`, inside (or next to) the existing `describe('findLatestSessionId — kimi', …)` block. The file already provides `tmpHome` (fresh mkdtemp per test), `makeUuid(seed)`, `touchDir(dir, mtimeMs)`, and imports both `findLatestSessionId` and `listSessionsInCwd` — reuse them verbatim:

```ts
it('discovers sessions in the modern ~/.kimi-code layout', async () => {
  const now = 1_700_000_000_000;
  const uuid = makeUuid('aaaa1111');
  const sessionDir = path.join(
    tmpHome,
    '.kimi-code',
    'sessions',
    'wd_app_35facf05b7a7',
    `session_${uuid}`,
  );
  touchDir(sessionDir, now - 1_000);

  const id = await findLatestSessionId('kimi', '/tmp/proj', {
    homeDir: tmpHome,
    now,
  });
  expect(id).toBe(uuid);
});

it('reads the modern state.json shape (ISO timestamps + real title)', async () => {
  const now = 1_700_000_000_000;
  const uuid = makeUuid('bbbb2222');
  const sessionDir = path.join(
    tmpHome,
    '.kimi-code',
    'sessions',
    'wd_proj_0123456789ab',
    `session_${uuid}`,
  );
  touchDir(sessionDir, now - 1_000);
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      createdAt: '2026-07-24T15:51:27.018Z',
      updatedAt: '2026-07-24T18:04:06.506Z',
      title: 'School Account Fix-Agent',
      isCustomTitle: true,
    }),
  );

  const items = await listSessionsInCwd('kimi', '/tmp/proj', { homeDir: tmpHome });
  const hit = items.find((i) => i.id === uuid);
  expect(hit).toBeDefined();
  expect(hit!.providerId).toBe('kimi');
  expect(hit!.title).toBe('School Account Fix-Agent');
  expect(hit!.createdAt).toBe(Date.parse('2026-07-24T15:51:27.018Z'));
  expect(hit!.updatedAt).toBe(Date.parse('2026-07-24T18:04:06.506Z'));
});

it('lists legacy and modern layouts side by side, deduped by id', async () => {
  const now = 1_700_000_000_000;
  const legacyUuid = makeUuid('cccc3333');
  const modernUuid = makeUuid('dddd4444');
  touchDir(path.join(tmpHome, '.kimi', 'sessions', 'project-hash-abc', legacyUuid), now - 2_000);
  touchDir(
    path.join(tmpHome, '.kimi-code', 'sessions', 'wd_proj_0123456789ab', `session_${modernUuid}`),
    now - 1_000,
  );
  // Same uuid present in BOTH layouts must appear exactly once.
  touchDir(
    path.join(tmpHome, '.kimi', 'sessions', 'project-hash-abc', modernUuid),
    now - 3_000,
  );

  const items = await listSessionsInCwd('kimi', '/tmp/proj', { homeDir: tmpHome });
  const ids = items.map((i) => i.id);
  expect(ids).toContain(legacyUuid);
  expect(ids).toContain(modernUuid);
  expect(ids.filter((x) => x === modernUuid)).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run src/main/core/pty/session-disk-scanner.test.ts`
Expected: FAIL — modern-layout session not found.

- [ ] **Step 3: Implement the dual-layout scan**

In `src/main/core/pty/session-disk-scanner.ts`, inside `listKimiSessions` (line 571):

3a. Replace the `sessionDirs` collection block (lines 578-596) with:

```ts
  // 2026-07 kimi-code migration: sessions moved from
  //   ~/.kimi/sessions/<bucket>/<uuid>/
  // to
  //   ~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/
  // (state.json now carries ISO createdAt/updatedAt, title, isCustomTitle).
  // Scan both roots; dedupe by uuid below.
  const roots = [
    path.join(homeDir, '.kimi', 'sessions'),
    path.join(homeDir, '.kimi-code', 'sessions'),
  ];
  const allowedIds = await workspaceAllowedIds(opts);
  const sessionDirs: string[] = [];
  for (const root of roots) {
    if (!(await safeStat(root))) continue;
    const projectEntries = (await safeReadDir(root)).slice(0, MAX_ENTRIES_PER_DIR);
    for (const entry of projectEntries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (UUID_RE.test(entry.name)) {
        sessionDirs.push(full);
      } else {
        for (const child of (await safeReadDir(full)).slice(0, MAX_ENTRIES_PER_DIR)) {
          if (!child.isDirectory()) continue;
          if (!UUID_RE.test(child.name)) continue;
          sessionDirs.push(path.join(full, child.name));
        }
      }
    }
  }
```

(`UUID_RE` at `session-disk-scanner.ts:110-111` is unanchored, so `session_<uuid>` basenames pass `.test` during collection and the existing `.match(UUID_RE)?.[0]` extraction at line 603 yields the bare uuid unchanged — no regex change needed.)

3b. Extend the `state.json` parsing (lines 612-624) to also read the modern shape, replacing the `if (typeof data.timestamp ...)` / title lines with:

```ts
        if (typeof data.timestamp === 'number') createdAt = data.timestamp;
        // Modern kimi-code shape: ISO strings + a real title.
        if (typeof data.createdAt === 'string') {
          const t = Date.parse(data.createdAt);
          if (Number.isFinite(t)) createdAt = t;
        }
        if (typeof data.updatedAt === 'string') {
          const t = Date.parse(data.updatedAt);
          if (Number.isFinite(t)) updatedAt = t;
        }
        if (typeof data.title === 'string' && data.title.trim()) title = data.title.trim();
        else if (typeof data.model === 'string') title = data.model;
```

(`updatedAt` is currently `const` from `stat.mtimeMs` at line 601 — change it to `let`.)

3c. Dedupe before returning — replace the return (line 627) with:

```ts
  const byId = new Map<string, SessionListItem>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxCount);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run src/main/core/pty/session-disk-scanner.test.ts && pnpm exec tsc -b`
Expected: PASS — new modern-layout tests plus all existing scanner suites (claude/gemini/opencode untouched), typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/main/core/pty/session-disk-scanner.ts app/src/main/core/pty/session-disk-scanner.test.ts
git commit -m "fix(resume): scan ~/.kimi-code sessions layout for the kimi resume picker

Post-migration sessions live under ~/.kimi-code/sessions/wd_*/session_<uuid>
with ISO timestamps and real titles; the legacy ~/.kimi scan found none of
them. Both layouts are scanned, merged, and deduped by session id."
```

---

### Task 8: providers.ts kimi install metadata points at the migrated package

The kimi provider entry still claims PyPI (`pip install kimi-cli`) — the Install button would install the legacy package. The new distribution is the `@moonshot-ai/kimi-code` single binary.

**Files:**
- Modify: `src/shared/providers.ts:167-190` (the `kimi` entry)
- Test: `src/shared/providers.test.ts`

**Interfaces:**
- Consumes: `AgentProviderDefinition` shape (unchanged).
- Produces: unchanged — metadata only.

- [ ] **Step 1: Check the existing test for kimi assertions**

Run: `cd app && grep -n "kimi" src/shared/providers.test.ts`
If the test asserts the old install hint/command, update those assertions in Step 3 alongside the source change (this is a metadata correction, not behavior — TDD's failing-first step is satisfied by the updated assertions failing against the old source).

- [ ] **Step 2: Run test to verify current state**

Run: `cd app && pnpm vitest run src/shared/providers.test.ts`
Expected: PASS against the old metadata (baseline).

- [ ] **Step 3: Update the metadata**

In `src/shared/providers.ts`, replace the kimi entry's comment block + install fields (lines 178-189) with:

```ts
    // 2026-07: Kimi Code migrated from the PyPI kimi-cli to the single-binary
    // @moonshot-ai/kimi-code (home moved ~/.kimi → ~/.kimi-code; PATH entry
    // added to the user's shell rc by the migrator).
    installHint: 'npm i -g @moonshot-ai/kimi-code',
    detectable: true,
    installCommand: {
      darwin: ['npm', 'i', '-g', '@moonshot-ai/kimi-code'],
      linux: ['npm', 'i', '-g', '@moonshot-ai/kimi-code'],
      win32: ['npm', 'i', '-g', '@moonshot-ai/kimi-code'],
    },
    installDocsUrl: 'https://www.npmjs.com/package/@moonshot-ai/kimi-code',
```

Update any kimi assertions in `src/shared/providers.test.ts` to match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run src/shared/providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/aisigma/projects/SigmaLink-wt-kimi-code
git add app/src/shared/providers.ts app/src/shared/providers.test.ts
git commit -m "fix(providers): point kimi install metadata at @moonshot-ai/kimi-code

The entry still offered `pip install kimi-cli` — the legacy package the
2026-07 migration replaced with the single-binary npm distribution."
```

---

### Final gate (after Task 8)

- [ ] Run the full suite: `cd app && pnpm test`
- [ ] Typecheck: `cd app && pnpm exec tsc -b`
- [ ] Manual smoke (requires the built app or `pnpm dev`): launch kimi via the `+` pane, stream a long answer (no flicker), trigger a Kimi session rename (label updates and stays), kill/relaunch.
- [ ] Mark the implemented items in `WISHLIST.md` as promoted (strike-through + link to this plan) per the wishlist skill.
