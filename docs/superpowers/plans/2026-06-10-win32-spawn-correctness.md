# Win32 Spawn Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Windows launch of an npm `.cmd`-shim CLI (claude, codex, gemini, ruflo, npx, cursor-agent) deliver argv to the target byte-for-byte intact, and make that correctness CI-visible on the windows-latest leg.

**Architecture:** All Windows spawn correctness flows through ONE module: `app/src/main/core/util/windows-spawn.ts` (`buildWindowsSpawnArgs` → `cmd.exe /d /s /c "<inner>"` + `windowsVerbatimArguments: true`). The verbatim *plumbing* already shipped in #134 (`bb410a5`): `spawnExecutable` forwards the flag to `child_process`, `local-pty.ts:521` joins the argv into a single string for node-pty (node-pty 1.1.0 `windowsPtyAgent.js:254-259` appends a string `args` to the command line VERBATIM — verified in `app/node_modules/node-pty`). The residual core bug is the escaping itself: `cmdQuoteArg` caret-escapes `^ % !` INSIDE double quotes, where cmd.exe treats carets as literal characters, and emits `\"` which toggles cmd's quote state mid-token (an odd embedded quote makes a following `&` a live command separator — injection). This plan replaces the escaping with cross-spawn's battle-tested caret-escape-everything algorithm (derived from https://qntm.org/cmd), then routes the remaining raw-`spawn` consumers through `spawnExecutable`, and adds a win32 CI test leg.

**Tech Stack:** TypeScript (Electron main process), vitest, node-pty 1.1.0, child_process/libuv, GitHub Actions (windows-latest).

**Working directory:** all commands run from `/Users/aisigma/projects/SigmaLink/app` unless noted. The CI workflow lives one level up at `/Users/aisigma/projects/SigmaLink/.github/workflows/e2e-matrix.yml`.

---

## Audit-Finding Verification (2026-06-10, against current tree)

| # | Audit claim | Verified state |
|---|---|---|
| 1 | CRIT: cmd.exe wrap re-quoted by libuv/node-pty | **PARTIALLY REFUTED.** The verbatim plumbing already landed in #134: `windows-spawn.ts:103-130` returns `windowsVerbatimArguments: true`, `spawn-cross-platform.ts:61-73` forwards it, `local-pty.ts:516-521` passes `args.join(' ')` as a STRING to node-pty (verbatim per node-pty source), `exec.ts:50-56` forwards it for probe/git-ops/review-runner. **RESIDUAL CONFIRMED:** `cmdQuoteArg` (`windows-spawn.ts:72-79`) is wrong for the inside-quotes context — carets are literal inside `"…"` (so `a^b` → `a^^b`, `%X%` → `^%X^%` corruption), `\"` toggles cmd quote state (odd quote → following `&\|<>` go live = injection), and `%VAR%` expands straight through quotes (percent phase ignores quote state). The shipped test `windows-spawn.test.ts:29-33` asserts the corrupting output. Task 1 fixes this. |
| 2 | HIGH: http-daemon tiers 2/4 raw-spawn bare shims | **CONFIRMED** — `http-daemon-supervisor.ts:376` (`doSpawn`) **and a twin the audit missed: `:602-616` (`launchChild`, the crash-recovery respawn)**. Both `spawn(entry.launch.command, …)` with `'ruflo'`/`'npx'`. `commandOnPath` (`:747-757`, uses `where`) finds `ruflo.cmd` → tier selected → CreateProcessW ENOENT → crash-loop. Tasks 2. |
| 3 | MED: seed-workspace-memory bare `npx` + swallowed error | **CONFIRMED** — `seed-workspace-memory.ts:59`, `child.on('error', () => resolve())` at `:75`. Task 3. NEW hazard once cmd-wrapped: the `--value` payload is multi-line markdown; a raw newline ends a cmd line (rest would EXECUTE). Task 1's escaper sanitizes newlines; Task 3 documents it. |
| 4 | MED: openShell re-quoting trap | **CONFIRMED (shape adjusted)** — `rpc-router.ts:915-918` now uses `cmdQuoteArg` for the path but still spawns WITHOUT `windowsVerbatimArguments`, so libuv re-quotes the spaced/quoted tail (`"` → `\"`) → broken for `C:\Users\First Last\…`. Task 6. |
| 5 | MED: scratch shell trusts `env.SHELL` on win32 | **CONFIRMED** — `rpc-router.ts:1032-1034`. Task 7. |
| 6 | defaultShell ignores caller env on darwin/linux | **CONFIRMED** — `local-pty.ts:122-127` reads `process.env.SHELL`; win32 branch uses the `env` param. Task 7. |
| 7 | LOW: mcp-trust detect/run mismatch | **CONFIRMED** — `mcp-trust.ts:196` raw-spawns bare `cursor-agent`; `defaultDetectCli` (`:178-187`) accepts `name.cmd`. Task 5. |
| 8 | TEST GAP: class invisible to CI | **CONFIRMED + worse than stated** — `lint-and-build.yml` runs vitest ONLY on `macos-14`; the e2e windows leg runs Playwright only. The existing win32-gated integration test (`spawn-cross-platform.test.ts:182+`, `describe.skipIf(process.platform !== 'win32')`) has therefore NEVER executed in CI. Task 8. |
| — | NEW sibling found by sweep | `verify.ts:220-260` `defaultProbeRunner` raw-spawns bare `claude`/`codex`/`gemini`/`kimi`/`opencode` (`:229`) → all strict-verify probes ENOENT on win32. Task 4. |

### cmd.exe parsing rules this plan relies on (be precise — these justify every escape)

1. **Phase order:** for a `cmd /c <line>`, `%VAR%` expansion runs FIRST and **ignores quote state entirely**; the caret/quote phase runs second. A caret therefore cannot directly escape `%`, but interleaving carets into the would-be variable name (`^%VAR^%`) makes phase 1 look up the literal name `VAR^`, find nothing, and leave the text alone; phase 2 then consumes the carets — net result: literal `%VAR%`.
2. **Inside `"…"`, `^ & | < >` are all LITERAL.** A caret inside quotes is NOT an escape — it survives as a real character. This is the current `cmdQuoteArg` bug.
3. **cmd has no `\"` escape.** A `"` always toggles quote state in phase 2 (the backslash is just a character). `\"` is only meaningful to the TARGET program's Win32 argv (MSVCRT) parser. Emitting `\"` into a line cmd itself parses flips the in-quotes state for everything after it.
4. **`^X` outside quotes makes X literal — including spaces** (`C:\First^ Last\x.cmd` is a valid unquoted command token). Caret-escaping EVERY metachar including the quote characters themselves means cmd never enters in-quotes state, every escape is honored, and one cmd parse collapses the token back to its plain Win32-argv form. This is cross-spawn's algorithm; npm/yarn run on it.
5. **`/s` semantics:** with `cmd /d /s /c "<tail>"`, when the first character after `/c` is `"`, cmd strips that first quote and the LAST quote on the line, treating everything in between as the command line. Quote characters in between (ours are all caret-escaped) are untouched by the strip.
6. **npm `.cmd` shims re-expand `%*`** into a fresh `node "%~dp0…cli.js" %*` line inside the batch file — that line gets a SECOND full phase-1+2 parse. Args must therefore be escaped TWICE (`doubleEscape`). Trace for the hostile arg `say "boo & del C:`: single-escaped survives our `/c` parse but the shim's `%*` re-parse sees a real unbalanced `"` → the `&` lands OUTSIDE quotes → `del` executes. Double-escaped, the re-parse still sees `^&` → literal. All CLIs this app launches on Windows are npm cmd-shims (global `%AppData%\npm\*.cmd` uses the same `%*` template as `node_modules\.bin`), so the `.cmd`/`.bat` branch always double-escapes args. (Deviation from cross-spawn, which only double-escapes `node_modules\.bin` shims — ours is the superset-safe choice; a batch file that never references `%1`/`%*` is unaffected by the extra layer.)
7. **A raw newline terminates a cmd line** — anything after it would run as a separate command. There is no escape; the escaper replaces `[\r\n]+` with a single space (lossy but injection-proof; relevant to seed-workspace-memory's multi-line `--value`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `app/src/main/core/util/windows-spawn.ts` | Modify (130 → ~190 lines) | THE escaping core: `cmdEscapeArg` + `cmdEscapeCommandPath` replace `cmdQuoteArg`; `buildWindowsSpawnArgs` cmd-branch update; new `buildWindowsOpenShellArgs` (pure, testable here instead of inside the untestable rpc-router). |
| `app/src/main/core/util/windows-spawn.test.ts` | Modify | Table-driven pure tests for the new escapers (run on ALL platforms); update the two stale `buildWindowsSpawnArgs` assertions; tests for `buildWindowsOpenShellArgs`. |
| `app/src/main/core/util/spawn-cross-platform.test.ts` | Modify | Refresh canned mock strings to the new line format; add the win32-gated npm-shim argv round-trip integration test. |
| `app/src/main/core/ruflo/http-daemon-supervisor.ts` | Modify | Route `doSpawn` (:376) AND `launchChild` (:604) through `spawnExecutable`. |
| `app/src/main/core/ruflo/http-daemon-supervisor.test.ts` | Modify | Mock `spawn-cross-platform`, assert routing. |
| `app/src/main/core/ruflo/seed-workspace-memory.ts` | Modify | `defaultRunStore` via `spawnExecutable`; log swallowed spawn errors. |
| `app/src/main/core/ruflo/seed-workspace-memory.test.ts` | Modify | Default-runStore routing + error-log tests. |
| `app/src/main/core/ruflo/verify.ts` | Modify | `defaultProbeRunner` (:229) via `spawnExecutable`; export it for tests. |
| `app/src/main/core/ruflo/verify.test.ts` | Modify | Direct `defaultProbeRunner` test. |
| `app/src/main/core/workspaces/mcp-trust.ts` | Modify | `defaultRunCli` (:196) via `spawnExecutable`; export it for tests. |
| `app/src/main/core/workspaces/mcp-trust.test.ts` | Modify | Direct `defaultRunCli` test. |
| `app/src/main/rpc-router.ts` | Modify | openShell (:915) → `buildWindowsOpenShellArgs` + verbatim; spawnScratch (:1032) → ignore `env.SHELL` on win32, use `defaultShell()`. (rpc-router cannot load under vitest — better-sqlite3 Electron ABI — so its 6 changed lines are seams over pure helpers tested elsewhere.) |
| `app/src/main/core/pty/local-pty.ts` | Modify | Export `defaultShell`; honor the `env` param on darwin/linux. |
| `app/src/main/core/pty/local-pty.test.ts` | Modify | `defaultShell` env-param tests. |
| `/Users/aisigma/projects/SigmaLink/.github/workflows/e2e-matrix.yml` | Modify | Run the util vitest suite on the windows-latest leg. |

No new source files. All touched files stay well under 500 lines except `rpc-router.ts` (pre-existing >500; we change 6 lines, no restructure).

---

### Task 1: cmd.exe escaping core (cross-spawn algorithm) + table-driven tests

**Files:**
- Modify: `app/src/main/core/util/windows-spawn.ts:72-79` (replace `cmdQuoteArg`), `:103-130` (cmd branch of `buildWindowsSpawnArgs`)
- Test: `app/src/main/core/util/windows-spawn.test.ts`

These tests are PURE (no platform branch inside the escapers) — they run and must pass on the macOS dev machine.

- [ ] **Step 1: Write the failing table-driven tests**

Replace the `describe('cmdQuoteArg', …)` block in `app/src/main/core/util/windows-spawn.test.ts` with:

```typescript
import {
  buildWindowsSpawnArgs,
  buildWindowsOpenShellArgs, // added in Task 6 — leave the import out until then
  cmdEscapeArg,
  cmdEscapeCommandPath,
  resolveWindowsCommand,
} from './windows-spawn';
```

(For THIS task import only `cmdEscapeArg` and `cmdEscapeCommandPath`; `buildWindowsOpenShellArgs` is appended to the import list in Task 6.)

```typescript
describe('cmdEscapeArg — single escape (one cmd parse)', () => {
  // [input, expected] — expected strings per the cross-spawn/qntm.org/cmd
  // algorithm: Win32-argv quote+backslash rules first, then caret-escape
  // EVERY cmd metachar including the quotes themselves.
  const cases: Array<[string, string]> = [
    ['hello world', '^"hello^ world^"'],
    ['a&b', '^"a^&b^"'],
    ['p|q', '^"p^|q^"'],
    ['x<y>z', '^"x^<y^>z^"'],
    ['a^b', '^"a^^b^"'],
    ['bang!', '^"bang^!^"'],
    ['100%', '^"100^%^"'],
    ['%USERNAME%', '^"^%USERNAME^%^"'],
    ['say "hi"', '^"say^ \\^"hi\\^"^"'],
    ['C:\\tmp\\', '^"C:\\tmp\\\\^"'],
    ['', '^"^"'],
    // cmd lines are single-line: raw newlines would TERMINATE the line and
    // execute the remainder as a new command — replaced with one space.
    ['one\ntwo', '^"one^ two^"'],
    ['one\r\ntwo', '^"one^ two^"'],
  ];
  it.each(cases)('escapes %j', (input, expected) => {
    expect(cmdEscapeArg(input)).toBe(expected);
  });
});

describe('cmdEscapeArg — double escape (npm .cmd shims re-expand %*)', () => {
  const cases: Array<[string, string]> = [
    ['hello world', '^^^"hello^^^ world^^^"'],
    ['a&b', '^^^"a^^^&b^^^"'],
    ['%USERNAME%', '^^^"^^^%USERNAME^^^%^^^"'],
    ['-p', '^^^"-p^^^"'],
    ['say "hi"', '^^^"say^^^ \\^^^"hi\\^^^"^^^"'],
  ];
  it.each(cases)('double-escapes %j', (input, expected) => {
    expect(cmdEscapeArg(input, true)).toBe(expected);
  });
});

describe('cmdEscapeCommandPath', () => {
  it('caret-escapes spaces in the resolved shim path (usernames with spaces)', () => {
    expect(
      cmdEscapeCommandPath('C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd'),
    ).toBe('C:\\Users\\First^ Last\\AppData\\Roaming\\npm\\claude.cmd');
  });
  it('leaves a metachar-free path untouched', () => {
    expect(cmdEscapeCommandPath('C:\\npm\\tool.CMD')).toBe('C:\\npm\\tool.CMD');
  });
});
```

Then UPDATE the two existing `buildWindowsSpawnArgs` assertions (they currently lock in the corrupting format):

```typescript
describe('buildWindowsSpawnArgs', () => {
  it('wraps .cmd shims: caret-escaped command + double-escaped args, OUTER-quoted, verbatim', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\npm\\tool.CMD',
    );

    const result = buildWindowsSpawnArgs(
      'tool',
      ['hello world', '%USERNAME%', 'a&b'],
      { PATH: 'C:\\npm', PATHEXT: '.CMD' },
    );

    expect(result.command).toBe('cmd.exe');
    // /s strips the first+last quote; everything between is caret-escaped so
    // cmd.exe NEVER enters in-quotes state on the first parse. Args carry a
    // second escape layer because npm shims re-expand %* (second cmd parse).
    expect(result.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\npm\\tool.CMD ^^^"hello^^^ world^^^" ^^^"^^^%USERNAME^^^%^^^" ^^^"a^^^&b^^^""',
    ]);
    expect(result.windowsVerbatimArguments).toBe(true);
  });

  it('caret-escapes spaces in a .cmd path instead of quoting it', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\Program Files\\npm\\tool.CMD',
    );

    const result = buildWindowsSpawnArgs(
      'tool',
      ['arg with space', 'plain'],
      { PATH: 'C:\\Program Files\\npm', PATHEXT: '.CMD' },
    );

    expect(result.command).toBe('cmd.exe');
    expect(result.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Program^ Files\\npm\\tool.CMD ^^^"arg^^^ with^^^ space^^^" ^^^"plain^^^""',
    ]);
    expect(result.windowsVerbatimArguments).toBe(true);
  });

  // … keep the .ps1 test unchanged …
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/core/util/windows-spawn.test.ts`
Expected: FAIL — `cmdEscapeArg is not a function` / old `cmdQuoteArg` assertions removed, new expected strings unmatched.

- [ ] **Step 3: Implement the escapers**

In `app/src/main/core/util/windows-spawn.ts`, DELETE `cmdQuoteArg` (lines 72-79) and insert:

```typescript
// cmd.exe metacharacters that need caret-escaping when a token sits OUTSIDE
// double quotes. This is cross-spawn's battle-tested set (the npm ecosystem
// runs on it): parens, brackets, percent, bang, caret, quote, backtick,
// angle brackets, ampersand, pipe, semicolon, comma, SPACE, star, question.
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escape the resolved command path for the inner line of
 * `cmd.exe /d /s /c "<inner>"`.
 *
 * The path is NOT quoted; every cmd metachar — including spaces — is
 * caret-escaped (`C:\Users\First^ Last\npm\claude.cmd`). `^X` outside quotes
 * makes X literal without splitting the command token. A quoted form cannot
 * work here: carets inside quotes are LITERAL, so a quoted path could never
 * protect `%` (phase-1 expansion ignores quotes) — see cmdEscapeArg.
 */
export function cmdEscapeCommandPath(resolvedPath: string): string {
  return resolvedPath.replace(CMD_META_RE, '^$1');
}

/**
 * Escape ONE argument for the inner line of `cmd.exe /d /s /c "<inner>"`.
 * cross-spawn's algorithm, derived from https://qntm.org/cmd:
 *
 *  1. Win32-argv (MSVCRT) layer — what the TARGET re-parses: double every
 *     backslash run before a `"` and emit `\"`; double a trailing backslash
 *     run; wrap in `"…"`.
 *  2. cmd.exe phase-2 layer — caret-escape EVERY metachar INCLUDING the
 *     quotes from layer 1. cmd then never enters in-quotes state: `^&`/`^|`
 *     can't act as operators, and `^%` interleaves carets into would-be
 *     `%VAR%` names (phase 1 looks up the literal name `VAR^`, finds
 *     nothing, leaves the text; phase 2 strips the carets). One cmd parse
 *     collapses the token back to its plain layer-1 form.
 *
 * `doubleEscape` adds a second layer-2 pass: npm `.cmd` shims re-expand `%*`
 * into a fresh `node "%~dp0…cli.js" %*` line — a SECOND full cmd parse.
 * Without it, an arg with an odd embedded quote re-parses with `&` OUTSIDE
 * quotes → live command separator (injection).
 *
 * cmd lines are single-line; a raw newline TERMINATES the line and the rest
 * would execute as a separate command. No escape exists — newlines are
 * replaced with one space (lossy, injection-proof).
 */
export function cmdEscapeArg(arg: string, doubleEscape = false): string {
  let s = String(arg).replace(/[\r\n]+/g, ' ');
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META_RE, '^$1');
  if (doubleEscape) s = s.replace(CMD_META_RE, '^$1');
  return s;
}
```

Then replace the `kind === 'cmd'` branch of `buildWindowsSpawnArgs` (keep the `BuiltWindowsSpawn` interface and its `windowsVerbatimArguments` doc comment — update the doc's "pre-quotes every token" sentence to "caret-escapes every token"):

```typescript
  if (kind === 'cmd') {
    // Command path caret-escaped (never quoted); args double-escaped because
    // every .cmd this app launches is an npm shim that re-expands %* (a
    // second cmd parse). The whole inner line is wrapped in ONE outer pair of
    // quotes that `cmd /d /s /c` strips via /s. The result MUST reach the
    // spawn layer without re-quoting — see `windowsVerbatimArguments`.
    const inner = [
      cmdEscapeCommandPath(resolved),
      ...args.map((a) => cmdEscapeArg(a, true)),
    ].join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }
```

- [ ] **Step 4: Fix the now-broken `cmdQuoteArg` import in rpc-router (compile gate)**

`app/src/main/rpc-router.ts:145` imports `cmdQuoteArg`. Task 6 replaces that call site properly; to keep `tsc` green WITHIN this task, change line 145 to import nothing yet and line 915 to use the still-correct-shape interim:

```typescript
// rpc-router.ts:145 — TEMPORARY until Task 6 lands in the next commits:
import { cmdEscapeArg } from './core/util/windows-spawn';
// rpc-router.ts:915 — same call shape, still broken for spaces (Task 6 fixes):
        spawn('cmd.exe', ['/d', '/s', '/k', `cd /d ${cmdEscapeArg(resolved)}`], {
```

(If executing Tasks 1 and 6 in one session, skip this step and do Task 6's edit directly.)

- [ ] **Step 5: Run the util tests + typecheck**

Run: `npx vitest run src/main/core/util/windows-spawn.test.ts && npx tsc -b`
Expected: PASS / clean.

- [ ] **Step 6: Refresh the canned mock strings in spawn-cross-platform.test.ts**

The mocks at `spawn-cross-platform.test.ts:47-53` and `:74-78` feed canned `buildWindowsSpawnArgs` outputs in the OLD all-quoted format. They still pass (format-agnostic pass-through) but would mislead readers. Update the two canned `args[3]` strings to the new format, e.g. line ~51:

```typescript
          '"C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd ^^^"-p^^^" ^^^"hello^^^ world^^^" ^^^"--output-format^^^" ^^^"stream-json^^^""',
```

(and the matching `expect(argv[3])` at ~line 66) and the `.bat` one at ~line 76 to `'"C:\\tools\\run.bat ^^^"--flag^^^""'` (+ its assertion).

Run: `npx vitest run src/main/core/util/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/core/util/windows-spawn.ts src/main/core/util/windows-spawn.test.ts src/main/core/util/spawn-cross-platform.test.ts src/main/rpc-router.ts
git commit -m "fix(win32): correct cmd.exe escaping — caret-escape outside quotes (cross-spawn algorithm), double-escape for npm shim %* re-parse"
```

---

### Task 2: http-daemon-supervisor tiers via spawnExecutable (doSpawn + launchChild twins)

**Files:**
- Modify: `app/src/main/core/ruflo/http-daemon-supervisor.ts:15` (import), `:376` (doSpawn), `:604` (launchChild)
- Test: `app/src/main/core/ruflo/http-daemon-supervisor.test.ts`

The audit cited only `doSpawn`; the sweep found the crash-recovery twin `launchChild` (`:602-616`) — fix BOTH or recovery respawns keep ENOENT-ing (the exact SF-14 doSpawn/launchChild sibling pair).

- [ ] **Step 1: Write the failing routing test**

In `http-daemon-supervisor.test.ts`, next to the existing `vi.mock('node:child_process', …)` (line 24), add:

```typescript
// Routed-spawn assertion: the SUT must launch tiers through spawnExecutable
// (which wraps .cmd shims on win32), not raw child_process.spawn. The mock
// forwards to mockSpawn so every existing assertion keeps working.
const spawnExecutableCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('../util/spawn-cross-platform', () => ({
  spawnExecutable: (cmd: string, args: string[], opts: unknown) => {
    spawnExecutableCalls.push({ cmd, args });
    return mockSpawn(cmd, args, opts);
  },
}));
```

(clear `spawnExecutableCalls.length = 0` in the existing `beforeEach`), and a test mirroring the existing `spawn-succeeds` case (same arrange steps as `http-daemon-supervisor.test.ts:256-266`):

```typescript
  it('routes the tier launch through spawnExecutable (win32 .cmd shim safety)', async () => {
    const supervisor = makeSupervisor(); // reuse the file's existing factory/arrange helper
    const spawnPromise = supervisor.spawn('ws-route', '/home/user/project');
    emitHealthy(); // reuse the file's existing health-probe helper pattern
    await spawnPromise;
    expect(spawnExecutableCalls.length).toBeGreaterThan(0);
    expect(spawnExecutableCalls[0].cmd).toBe('ruflo');
    expect(spawnExecutableCalls[0].args).toContain('mcp');
  });
```

(Adapt the arrange/health helpers to this test file's existing local idioms — the assertion lines are the contract.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/ruflo/http-daemon-supervisor.test.ts`
Expected: FAIL — `spawnExecutableCalls.length` is 0 (SUT still calls raw spawn, which the node:child_process mock receives directly).

- [ ] **Step 3: Implement**

In `http-daemon-supervisor.ts`:

```typescript
// line 15 — drop `spawn` from the node:child_process import:
import { execFileSync, type ChildProcess } from 'node:child_process';
// add:
import { spawnExecutable } from '../util/spawn-cross-platform';
```

At `:376` (doSpawn) and `:604` (launchChild), change `child = spawn(` / `return spawn(` to `child = spawnExecutable(` / `return spawnExecutable(` — options objects unchanged. (`spawnExecutable` resolves against `opts.env` — both sites pass a full `{...process.env, …}` env, so PATH/PATHEXT resolution sees the same environment the child runs with. Tier 3 spawns `process.execPath`, a real `.exe` — POSIX/exe passthrough, no behavior change.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/core/ruflo/http-daemon-supervisor.test.ts`
Expected: PASS (new test + all existing — the forwarding mock keeps `mockSpawn` assertions intact).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/ruflo/http-daemon-supervisor.ts src/main/core/ruflo/http-daemon-supervisor.test.ts
git commit -m "fix(win32): route ruflo http-daemon tiers (doSpawn + launchChild) through spawnExecutable — ruflo.cmd/npx.cmd no longer ENOENT crash-loop"
```

---

### Task 3: seed-workspace-memory npx spawn + error visibility

**Files:**
- Modify: `app/src/main/core/ruflo/seed-workspace-memory.ts` (imports + `defaultRunStore`, spawn at `:59`, error swallow at `:75`)
- Test: `app/src/main/core/ruflo/seed-workspace-memory.test.ts`

- [ ] **Step 1: Write the failing tests**

In `seed-workspace-memory.test.ts` add (top-level, alongside existing imports):

```typescript
import { EventEmitter } from 'node:events';

const seedSpawnCalls: Array<{ cmd: string; args: string[] }> = [];
let seedSpawnMode: 'close' | 'error' = 'close';
vi.mock('../util/spawn-cross-platform', () => ({
  spawnExecutable: (cmd: string, args: string[]) => {
    seedSpawnCalls.push({ cmd, args });
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (seedSpawnMode === 'error') child.emit('error', new Error('spawn npx ENOENT'));
      else child.emit('close', 0);
    });
    return child;
  },
}));
```

(reset `seedSpawnCalls.length = 0; seedSpawnMode = 'close';` in `beforeEach`) and two tests — reuse the file's existing tmp-workspace-with-CLAUDE.md arrange helper:

```typescript
  it('defaultRunStore spawns npx via spawnExecutable (win32 .cmd shim safety)', async () => {
    const root = makeTmpWorkspaceWithClaudeMd(); // existing helper pattern in this file
    await seedWorkspaceMemory({ workspaceRoot: root }); // NO runStore override → default path
    expect(seedSpawnCalls.length).toBe(1);
    expect(seedSpawnCalls[0].cmd).toBe('npx');
    expect(seedSpawnCalls[0].args).toEqual(
      expect.arrayContaining(['memory', 'store', '--namespace', 'patterns']),
    );
  });

  it('logs (does not silently swallow) a spawn error, and still resolves', async () => {
    const root = makeTmpWorkspaceWithClaudeMd();
    seedSpawnMode = 'error';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(seedWorkspaceMemory({ workspaceRoot: root })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ruflo-seed]'));
    warn.mockRestore();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/core/ruflo/seed-workspace-memory.test.ts`
Expected: FAIL — `seedSpawnCalls.length` 0 (raw `spawn` used) and no `[ruflo-seed]` warn.

- [ ] **Step 3: Implement**

In `seed-workspace-memory.ts`: replace the `import { spawn } from 'node:child_process';` with `import { spawnExecutable } from '../util/spawn-cross-platform';`, change `const child = spawn(` to `const child = spawnExecutable(` (same args/options), and replace `child.on('error', () => resolve());` with:

```typescript
      child.on('error', (err: unknown) => {
        // Best-effort seeding must never reject — but an invisible ENOENT
        // (bare `npx` on win32 pre-fix) cost us this whole feature silently.
        console.warn(
          `[ruflo-seed] memory store spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        resolve();
      });
```

Note in the function's doc comment: the `--value` payload is multi-line; on win32 the cmd wrap flattens newlines to spaces (Task 1's `cmdEscapeArg` sanitization) — degraded content, never injection.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/core/ruflo/seed-workspace-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/ruflo/seed-workspace-memory.ts src/main/core/ruflo/seed-workspace-memory.test.ts
git commit -m "fix(win32): seed-workspace-memory npx via spawnExecutable; surface swallowed spawn errors"
```

---

### Task 4: verify.ts strict-probe runner (NEW sibling found by sweep)

**Files:**
- Modify: `app/src/main/core/ruflo/verify.ts:220-260` (`defaultProbeRunner`, spawn at `:229`)
- Test: `app/src/main/core/ruflo/verify.test.ts`

`defaultProbeRunner` raw-spawns bare `claude`/`codex`/`gemini`/`kimi`/`opencode` (`verify.ts:174-184`) — every strict MCP verification probe ENOENTs on win32. Existing tests inject `probeRunner`, so the default was never covered.

- [ ] **Step 1: Export `defaultProbeRunner` and write the failing test**

In `verify.ts` add `export` to `function defaultProbeRunner(` with a `/** Exported for unit tests. */` line. In `verify.test.ts` add:

```typescript
import { EventEmitter } from 'node:events';
import { defaultProbeRunner } from './verify';

const probeSpawnCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('../util/spawn-cross-platform', () => ({
  spawnExecutable: (cmd: string, args: string[]) => {
    probeSpawnCalls.push({ cmd, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {},
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('ruflo: connected\n'));
      child.emit('close', 0);
    });
    return child;
  },
}));

describe('defaultProbeRunner', () => {
  it('routes CLI probes through spawnExecutable (win32 .cmd shims)', async () => {
    const result = await defaultProbeRunner('claude', ['mcp', 'list'], {
      cwd: '/tmp',
      timeoutMs: 1000,
    });
    expect(probeSpawnCalls).toEqual([{ cmd: 'claude', args: ['mcp', 'list'] }]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ruflo');
  });
});
```

(Match the fake child's surface to what `defaultProbeRunner` actually touches at `verify.ts:220-260` — `stdout.on('data')`, `stderr.on('data')`, `on('close')`, `on('error')`, `kill()`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/ruflo/verify.test.ts`
Expected: FAIL — `defaultProbeRunner` not exported, then (after exporting) `probeSpawnCalls` empty.

- [ ] **Step 3: Implement**

In `verify.ts`: drop `spawn` from the `node:child_process` import (keep whatever else it imports), add `import { spawnExecutable } from '../util/spawn-cross-platform';`, change `const child = spawn(` (:229) to `const child = spawnExecutable(` — options unchanged.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/core/ruflo/verify.test.ts`
Expected: PASS (existing injected-probeRunner tests untouched).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/ruflo/verify.ts src/main/core/ruflo/verify.test.ts
git commit -m "fix(win32): ruflo strict-verify CLI probes via spawnExecutable — sibling missed by the audit"
```

---

### Task 5: mcp-trust cursor-agent detect/run parity

**Files:**
- Modify: `app/src/main/core/workspaces/mcp-trust.ts:191-204` (`defaultRunCli`, spawn at `:196`)
- Test: `app/src/main/core/workspaces/mcp-trust.test.ts`

- [ ] **Step 1: Export `defaultRunCli` and write the failing test**

Add `export` + `/** Exported for unit tests. */` to `defaultRunCli`. In `mcp-trust.test.ts`:

```typescript
import { defaultRunCli } from './mcp-trust';

const trustSpawnCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('../util/spawn-cross-platform', () => ({
  spawnExecutable: (cmd: string, args: string[]) => {
    trustSpawnCalls.push({ cmd, args });
    return {
      kill: () => {},
      once: (event: string, cb: () => void) => {
        if (event === 'exit') queueMicrotask(cb);
      },
      unref: () => {},
    };
  },
}));

describe('defaultRunCli', () => {
  it('spawns cursor-agent via spawnExecutable so detect (.cmd-aware) and run agree', () => {
    defaultRunCli('cursor-agent', ['mcp', 'enable', 'ruflo'], '/tmp');
    expect(trustSpawnCalls).toEqual([
      { cmd: 'cursor-agent', args: ['mcp', 'enable', 'ruflo'] },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/workspaces/mcp-trust.test.ts`
Expected: FAIL — export missing, then `trustSpawnCalls` empty.

- [ ] **Step 3: Implement**

In `mcp-trust.ts`: replace the `node:child_process` `spawn` import with `import { spawnExecutable } from '../util/spawn-cross-platform';` and change `const child = spawn(cmd, args, { cwd, stdio: 'ignore' });` to `const child = spawnExecutable(cmd, args, { cwd, stdio: 'ignore' });`. `defaultDetectCli` (`:178-187`) is already `.cmd`-aware — unchanged.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/core/workspaces/mcp-trust.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspaces/mcp-trust.ts src/main/core/workspaces/mcp-trust.test.ts
git commit -m "fix(win32): cursor-agent trust enable via spawnExecutable — detectCli/runCli .cmd parity"
```

---

### Task 6: openShell — pre-built verbatim `cd /d` line

**Files:**
- Modify: `app/src/main/core/util/windows-spawn.ts` (append `buildWindowsOpenShellArgs`)
- Modify: `app/src/main/rpc-router.ts:145` (import), `:915-918` (win32 branch)
- Test: `app/src/main/core/util/windows-spawn.test.ts`

- [ ] **Step 1: Write the failing test**

In `windows-spawn.test.ts` (add `buildWindowsOpenShellArgs` to the import):

```typescript
describe('buildWindowsOpenShellArgs', () => {
  it('builds a verbatim /k cd-line that survives paths with spaces', () => {
    const r = buildWindowsOpenShellArgs('C:\\Users\\First Last\\project');
    expect(r.command).toBe('cmd.exe');
    // /s strips the outer pair → cmd /k runs: cd /d "C:\Users\First Last\project"
    expect(r.args).toEqual(['/d', '/s', '/k', '"cd /d "C:\\Users\\First Last\\project""']);
    expect(r.windowsVerbatimArguments).toBe(true);
  });
  it('strips illegal quote chars from the cwd defensively', () => {
    const r = buildWindowsOpenShellArgs('C:\\evil" & del C:\\x"');
    expect(r.args[3]).toBe('"cd /d "C:\\evil & del C:\\x""');
  });
});
```

(Second case: with quotes stripped, the `&` sits INSIDE the `cd` argument's quotes — phase-2 literal, not a separator. Windows paths cannot legally contain `"`, so stripping loses nothing real.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/util/windows-spawn.test.ts`
Expected: FAIL — `buildWindowsOpenShellArgs is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `windows-spawn.ts`:

```typescript
/**
 * Detached interactive console in `cwd` (rpc openShell). The `/k` tail is ONE
 * pre-built line: `cd` is a cmd BUILTIN parsed exactly once, so the path is
 * plain-quoted — NOT caret-escaped (carets inside quotes are literal, and a
 * builtin consumes the quoted form natively; `&` inside the quotes is
 * phase-2 literal). MUST be spawned with `windowsVerbatimArguments: true`:
 * libuv's default quoting turns the spaced/quoted tail into `\"`-soup that
 * cmd.exe cannot parse (broke C:\Users\First Last\…). Residual edge: a
 * defined %VAR% pattern inside the path still expands (phase 1 ignores
 * quotes) — pathological for a directory name, accepted.
 */
export function buildWindowsOpenShellArgs(cwd: string): BuiltWindowsSpawn {
  const safeCwd = cwd.replace(/"/g, '');
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/k', `"cd /d "${safeCwd}""`],
    windowsVerbatimArguments: true,
  };
}
```

- [ ] **Step 4: Wire rpc-router**

`rpc-router.ts:145` → `import { buildWindowsOpenShellArgs } from './core/util/windows-spawn';` (replacing the Task-1 interim `cmdEscapeArg` import). Replace the win32 branch (`:914-918`):

```typescript
      } else if (plat === 'win32') {
        const winShell = buildWindowsOpenShellArgs(resolved);
        spawn(winShell.command, winShell.args, {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: winShell.windowsVerbatimArguments,
        }).unref();
      } else {
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/main/core/util/windows-spawn.test.ts && npx tsc -b`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/util/windows-spawn.ts src/main/core/util/windows-spawn.test.ts src/main/rpc-router.ts
git commit -m "fix(win32): openShell cd-line passed verbatim — paths with spaces no longer re-quoted into garbage"
```

---

### Task 7: scratch shell ignores env.SHELL on win32; defaultShell honors caller env

**Files:**
- Modify: `app/src/main/core/pty/local-pty.ts:108-129` (export + darwin/linux env param)
- Modify: `app/src/main/rpc-router.ts:1031-1042` (spawnScratch)
- Test: `app/src/main/core/pty/local-pty.test.ts`

- [ ] **Step 1: Write the failing tests**

In `local-pty.test.ts` (follow the file's existing platform-stub idiom — `Object.defineProperty(process, 'platform', …)` with restore in `afterEach`):

```typescript
import { defaultShell } from './local-pty';

describe('defaultShell', () => {
  it('honours the caller-supplied env on darwin (was: read process.env.SHELL)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(defaultShell({ SHELL: '/opt/custom/fish' })).toEqual({
      command: '/opt/custom/fish',
      args: ['-l'],
    });
  });

  it('win32: ignores env.SHELL entirely and probes pwsh → powershell → cmd', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => p === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    const r = defaultShell({
      SHELL: '/usr/bin/bash', // git-bash export — must NOT be used (ENOENT on win32)
      PATH: 'C:\\Program Files\\PowerShell\\7',
      PATHEXT: '.EXE',
    });
    expect(r).toEqual({
      command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/core/pty/local-pty.test.ts`
Expected: FAIL — `defaultShell` not exported; darwin case returns `process.env.SHELL` not the param.

- [ ] **Step 3: Implement in local-pty.ts**

```typescript
/**
 * Resolve the user's default interactive shell for the given env.
 * win32 NEVER consults env.SHELL (git-bash exports SHELL=/usr/bin/bash —
 * not a Win32 path → ENOENT) — it probes pwsh → powershell → cmd.
 * Exported for the rpc scratch-shell seam + unit tests.
 */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
```

and in the darwin/linux branches change `process.env.SHELL` → `env.SHELL`:

```typescript
  if (process.platform === 'darwin') {
    const sh = env.SHELL ?? '/bin/zsh';
    return { command: sh, args: ['-l'] };
  }
  const sh = env.SHELL ?? '/bin/bash';
  return { command: sh, args: ['-l'] };
```

(Callers all pass `input.env ?? process.env`, which spreads `process.env` — behavior changes only for an explicit caller env whose SHELL differs, which is the bug being fixed.)

- [ ] **Step 4: Wire spawnScratch in rpc-router.ts (:1031-1042)**

Add `defaultShell` to the existing `./core/pty/local-pty` import cluster (line ~16-21), then:

```typescript
      // win32: NEVER trust env.SHELL — git-bash users export SHELL=/usr/bin/bash
      // (ENOENT as a Win32 path) and honouring it bypasses defaultShell()'s
      // pwsh → powershell → cmd preference. POSIX behaviour unchanged.
      const scratchShell =
        process.platform === 'win32'
          ? defaultShell()
          : { command: process.env.SHELL ?? '/bin/sh', args: [] as string[] };
      const rec = pty.create({
        providerId: 'shell',
        command: scratchShell.command,
        args: scratchShell.args,
        cwd: input.cwd,
        cols: 80,
        rows: 24,
      });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/main/core/pty/local-pty.test.ts && npx tsc -b`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/pty/local-pty.ts src/main/core/pty/local-pty.test.ts src/main/rpc-router.ts
git commit -m "fix(win32): scratch shell ignores env.SHELL on win32 (pwsh>powershell>cmd); defaultShell honours caller env on posix"
```

---

### Task 8: win32 npm-shim argv round-trip integration test + CI visibility

**Files:**
- Modify: `app/src/main/core/util/spawn-cross-platform.test.ts` (extend the existing `describe.skipIf(process.platform !== 'win32')` block at `:182+`)
- Modify: `/Users/aisigma/projects/SigmaLink/.github/workflows/e2e-matrix.yml` (insert one step)

TDD adaptation: this test SKIPS on the macOS dev machine — its red/green cycle happens on the PR's windows-latest CI leg ([[no local e2e]] discipline holds; this is vitest, not Playwright, and spawns no Electron window even when run locally on Windows).

- [ ] **Step 1: Write the round-trip test**

Append inside the existing win32-only describe in `spawn-cross-platform.test.ts`:

```typescript
  it('round-trips hostile argv through a real npm-style .cmd shim (%* re-expansion)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-xp-shim-'));
    const outFile = path.join(tmpDir, 'argv.json');
    // Mirror npm's cmd-shim template: the .cmd re-expands %* into a node
    // line — the exact second cmd parse the doubleEscape layer exists for.
    fs.writeFileSync(
      path.join(tmpDir, 'args.js'),
      'require("fs").writeFileSync(process.env.ARGS_OUT, JSON.stringify(process.argv.slice(2)));',
      'utf8',
    );
    // .cmd files need CRLF line endings.
    fs.writeFileSync(
      path.join(tmpDir, 'claude.cmd'),
      '@ECHO off\r\nnode "%~dp0args.js" %*\r\n',
      'utf8',
    );
    const hostile = [
      'hello world',
      'C:\\Users\\First Last\\project',
      'say "hi"',
      'a&b|c',
      '%USERNAME%', // defined on every runner — must arrive UNexpanded
      '50%',
      'caret^caret',
      'bang!bang',
      '(parens) and, commas;semis',
      'trailing\\',
    ];
    try {
      const { spawnExecutable } = await import('./spawn-cross-platform');
      const child = spawnExecutable('claude', hostile, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${tmpDir};${process.env.PATH ?? ''}`,
          ARGS_OUT: outFile,
        },
      });
      await new Promise<void>((resolve, reject) => {
        child.on('close', () => resolve());
        child.on('error', reject);
      });
      const roundTripped = JSON.parse(fs.readFileSync(outFile, 'utf8')) as string[];
      expect(roundTripped).toEqual(hostile);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run locally to confirm it skips cleanly**

Run: `npx vitest run src/main/core/util/spawn-cross-platform.test.ts`
Expected: PASS with the win32 describe reported as skipped.

- [ ] **Step 3: Wire the windows CI leg**

In `/Users/aisigma/projects/SigmaLink/.github/workflows/e2e-matrix.yml`, insert AFTER the `Rebuild native modules for Electron` step and BEFORE `Build renderer + electron` (the job already has `defaults.run.working-directory: app`, so no `cd` needed):

```yaml
      - name: Win32 spawn correctness tests (unit + .cmd shim round-trip)
        if: runner.os == 'Windows'
        run: pnpm exec vitest run src/main/core/util
```

Scoped to `src/main/core/util` so the windows leg stays fast and avoids modules with platform-specific test assumptions; the FULL vitest suite still runs on macos in `lint-and-build.yml`. (Verify `vitest.config` `setupFiles` pull in nothing Electron-binary-dependent for this dir — the util tests import only node builtins; the Electron binary is installed earlier in this job regardless.)

- [ ] **Step 4: Commit**

```bash
git add src/main/core/util/spawn-cross-platform.test.ts ../.github/workflows/e2e-matrix.yml
git commit -m "test(win32): npm .cmd shim argv round-trip integration test; run util suite on the windows CI leg"
```

- [ ] **Step 5 (CI-only checkpoint): open the PR and watch the windows leg**

The round-trip test executes for the first time on `smoke (windows-latest)`. If it fails there, the failure output (expected-vs-actual argv JSON) localizes which escape case is wrong — fix in `cmdEscapeArg`/`cmdEscapeCommandPath` (Task 1 files) only, re-push. Do NOT run Playwright/e2e locally.

---

### Task 9: grep-the-siblings completeness proof + full gate

**Files:** none modified (verification task; fixes loop back into the task that owns the file).

- [ ] **Step 1: Re-run the sibling sweep and check it against the classification table**

Run (from `app/`):

```bash
grep -rn "spawn(" src/main --include="*.ts" | grep -v "\.test\.ts" \
  | grep -v "spawnExecutable\|spawnLocalPty\|spawnShellFirst\|nodePty.spawn\|pty.spawn\|//\|\* "
```

Every surviving raw `spawn(` call site must appear in this table with verdict SAFE (anything new/unclassified = add a fix step to the owning task before proceeding):

| Site | Command | Verdict |
|---|---|---|
| `rpc-router.ts:913` | `'open'` | SAFE — darwin-only branch |
| `rpc-router.ts:~915` | `cmd.exe` via `buildWindowsOpenShellArgs` | FIXED (Task 6) |
| `rpc-router.ts:920` | `'x-terminal-emulator'` | SAFE — linux-only branch |
| `core/workspaces/mcp-trust.ts:196` | bare `cursor-agent` | FIXED (Task 5) |
| `core/ruflo/installer.ts:275` | `TAR_BIN` (`tar.exe` on win32, `:44`) | SAFE — real `.exe` (bsdtar ships with Win10+); CreateProcessW executes `.exe` natively |
| `core/ruflo/http-daemon-supervisor.ts:376` | tier `ruflo`/`npx`/execPath | FIXED (Task 2) |
| `core/ruflo/http-daemon-supervisor.ts:604` | same (launchChild twin) | FIXED (Task 2) |
| `core/memory/mcp-supervisor.ts:137` | `process.execPath` | SAFE — Electron binary `.exe` |
| `core/ruflo/seed-workspace-memory.ts:59` | bare `npx` | FIXED (Task 3) |
| `core/ruflo/supervisor.ts:295` | `this.opts.nodeBinary` (defaults `process.execPath`, `:78`) | SAFE — `.exe` |
| `core/review/runner.ts:79` | via `buildWindowsSpawnArgs` + verbatim (`:70-85`) | SAFE — already routed (#134); inherits Task 1's escaping fix automatically |
| `core/ruflo/verify.ts:229` | bare `claude`/`codex`/`gemini`/`kimi`/`opencode` | FIXED (Task 4) |
| `core/skills/marketplace.ts:295` | `TAR_BIN` (`tar.exe`, `:291`) | SAFE — `.exe` |
| `lib/exec.ts:50` | helper itself; forwards `windowsVerbatimArguments` (`:55`) | SAFE — callers (probe.ts:31, git-ops.ts:417-424, review/runner.ts) all pass the flag |
| `core/util/spawn-cross-platform.ts:72` | the platform-aware helper itself | SAFE |

Also sweep `execFile`/`execFileSync`/`exec(` the same way:

```bash
grep -rn "execFileSync\|execFile(\|exec(" src/main --include="*.ts" | grep -v "\.test\.ts" | grep -v "execCmd\|//\|\* "
```

Known-good: `http-daemon-supervisor.ts:747` `execFileSync('where', …)` — `where.exe` is a real executable. Anything else newly surfaced: classify before proceeding.

- [ ] **Step 2: Full local gate (NO local e2e — e2e runs on the PR's CI matrix)**

```bash
npx tsc -b
npx eslint . --max-warnings 0
npx vitest run
npm run product:check
```

Expected: all green. Known flake note: under load, full-vitest can time out in swarms/factory/VoiceTab — re-run the failing FILE in isolation before reacting.

- [ ] **Step 3: Commit any stragglers from Step 1, else no-op**

```bash
git status --short   # expect clean (all task commits already made)
```

---

## Risks / behavior notes

- **Escaping format change is observable** in any log/snapshot that captured the old `"…"`-token inner lines — only the two updated test fixtures asserted it; no runtime consumer parses the inner line back.
- **Newline flattening** (`cmdEscapeArg`): win32-only, lossy by design (cmd lines are single-line; the alternative is command injection). Affects multi-line args routed through `.cmd` shims — today only seed-workspace-memory's `--value` (degraded to single-line context, acceptable for a best-effort memory seed) and any future prompt-as-arg caller (claude turns pass prompts via stdin/flags today).
- **`%VAR%`-shaped directory names** in `buildWindowsOpenShellArgs` can still expand (phase 1 ignores quotes; a quoted `cd` line cannot caret-protect them). Pathological; documented in the helper.
- **rpc-router seams untested at unit level** (better-sqlite3 Electron ABI blocks vitest loading rpc-router — established repo constraint): both seams (openShell, spawnScratch) are 3-6 lines over pure helpers that ARE tested (`buildWindowsOpenShellArgs`, `defaultShell`).
- **doubleEscape for ALL `.cmd`/`.bat`** (vs cross-spawn's `node_modules\.bin`-only heuristic): correct for every batch file that references `%1`/`%*` (all npm shims, global included); a batch file that ignores its args is unaffected. Deviation documented in `cmdEscapeArg`'s comment.

## Coordination notes

- **Serialize merges with the sibling 2026-06-10 plans:** `rpc-boundary-hardening`, `pty-lifecycle-resume-fixes`, and the perf-hot-paths work also touch `rpc-router.ts` / `local-pty.ts`. Land this plan's Task 6/7 rpc-router edits in coordination — rebase-or-wait, never parallel-edit those two files (concurrent shared-tree stomp is a known repo failure mode; integrate in an isolated worktree off `origin/main` and push immediately).
- **`win32-platform-services` is the sibling plan** for the rest of the Windows audit (this plan is the prerequisite: it owns `windows-spawn.ts`, and that plan's consumers must route through `spawnExecutable`/`buildWindowsSpawnArgs` rather than growing new raw spawns).
- Code-editing subagents take `isolation: "worktree"` on the Agent call; gate re-runs happen in MAIN (`tsc -b` checks test files; worktree tsc is laxer). Capture diffs with `git add -A && git diff --cached HEAD`.
- The e2e-matrix workflow edit is repo-root (`../.github/...` from `app/`) — include it in the same PR so the windows leg validates the round-trip test on first CI contact.

## Self-review (done, fixes applied inline)

- Spec coverage: F1→Task 1 (+plumbing verified already-shipped, documented as partial refutation); F2→Task 2 (incl. the launchChild twin the audit missed); F3→Task 3; F4→Task 6; F5/F6→Task 7; F7→Task 5; F8→Task 8; new verify.ts sibling→Task 4; completeness proof→Task 9. node-pty string-args research: verified in `app/node_modules/node-pty/lib/windowsPtyAgent.js:254-259` (string args appended verbatim) — no node-pty-side change needed; `local-pty.ts:521` already hands the joined string.
- Placeholder scan: every code step carries full code; the two "reuse the file's existing helper" notes in Tasks 2-3 name the exact pattern+line to mirror rather than inventing parallel scaffolding.
- Type consistency: `BuiltWindowsSpawn` reused by `buildWindowsOpenShellArgs`; `cmdEscapeArg(arg, doubleEscape)` signature consistent across Tasks 1/6; `defaultShell(env)` return `{command, args}` consistent across Task 7's two call sites; `spawnExecutable(cmd, args, opts)` signature matches `spawn-cross-platform.ts:61`.
- Escape-string arithmetic double-checked: `'%USERNAME%'` single → `^"^%USERNAME^%^"` (9 escapes), double → `^^^"^^^%USERNAME^^^%^^^"`; `'say "hi"'` layer-1 → `"say \"hi\""`, single → `^"say^ \^"hi\^"^"`; trailing-backslash doubling before the closing argv quote verified.
