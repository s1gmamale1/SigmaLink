# BUG-V1.4.1-WIN-SIGMA-SPAWN — Sigma Assistant cannot spawn `claude` on Windows (ENOENT on npm shim)

- **Severity**: **P0 / P1 — feature non-functional**. The right-rail Sigma Assistant (the orchestrator + voice + tool-dispatch surface that shipped in v1.4.0 and was renamed in v1.4.1) returns a spawn error on every prompt on Windows. The whole assistant pane is unusable until the user installs Claude Code into a directory that happens to contain an extensionless executable (effectively never on Windows).
- **First reported**: 2026-05-17 user dogfood of v1.4.1 NSIS build on Windows 11 (single screenshot, exact error string captured below).
- **State**: **CONFIRMED ROOT CAUSE via static read of `runClaudeCliTurn.ts` + `local-pty.ts` + `providers/probe.ts`**. Fix is straightforward; no Windows VM reproduction needed for the diagnosis (the spawn call literally does not route `.cmd` through `cmd.exe`).
- **App commit**: `6e635db` (main, v1.4.1)
- **Regression of**: **v1.4.0** — the W-2 plan ([`docs/03-plan/archive/W-2-sigma-assistant-orchestrator-v1.4.0.md`](../03-plan/archive/W-2-sigma-assistant-orchestrator-v1.4.0.md)) introduced the streaming-JSON `runClaudeCliTurn` driver and its direct `child_process.spawn('claude', …)` call. Before v1.4.0 the right-rail assistant was a one-shot stub that never spawned the CLI, so this code path did not exist on Windows.
- **Affected platform**: Windows 10/11 (NSIS build). The error path is Windows-specific. Mac/Linux are NOT directly affected by this bug (see §5 below) — `claude` on POSIX is a real Node-shebanged executable on PATH, and the resolved path returned by `probeProvider` is directly spawnable by `child_process.spawn`.
- **Related but distinct**: The PTY-side shim resolver (PTY panes spawning `claude`, `codex`, `gemini`, `kimi`, `opencode`) was fixed in v1.2.0 — see [`docs/04-design/windows-port.md:57`](../04-design/windows-port.md). That fix lives at `app/src/main/core/pty/local-pty.ts:47-85` and `:175-197`. **The Sigma Assistant spawn path skipped it.**

---

## 1. Symptom

User opens Sigma Assistant from the right rail on Windows, types a prompt, and the assistant immediately returns:

```
claude CLI process error: spawn C:\Users\DaddysHere\AppData\Roaming\npm\claude ENOENT
```

User quote (dogfood report, 2026-05-17):
> "(i tested on windwows, could be universal problem), orchestrator/sigma assistant not working"

The exact wording `claude CLI process error: spawn <path> ENOENT` is emitted by the `child.on('error', …)` handler at [`app/src/main/core/assistant/runClaudeCliTurn.ts:407-414`](../../app/src/main/core/assistant/runClaudeCliTurn.ts) — the error string is constructed at line 409:

```ts
child.on('error', (err: Error) => {
  activeChildren.delete(turn.turnId);
  const msg = `claude CLI process error: ${err.message}`;
  ...
});
```

`err.message` is the standard Node `spawn <path> ENOENT` string, where `<path>` is whatever was passed as the first arg to `spawn(…)`.

## 2. Root cause (confirmed via static read)

**The spawn call at [`app/src/main/core/assistant/runClaudeCliTurn.ts:332-345`](../../app/src/main/core/assistant/runClaudeCliTurn.ts) hands `probe.resolvedPath` directly to Node's `child_process.spawn` with no Windows-aware wrapping**:

```ts
child = opts.spawnOverride
  ? opts.spawnOverride(probe.resolvedPath, args)
  : (spawn(probe.resolvedPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams);
```

On Windows, `probe.resolvedPath` comes from `providers/probe.ts:whichLike()`, which shells out to `where claude`. Windows `where` returns whatever it finds first on PATH — typically `C:\Users\<u>\AppData\Roaming\npm\claude.cmd`. Even when the resolved path correctly includes `.cmd`, **Node's `child_process.spawn` cannot execute a `.cmd` / `.bat` file directly with an arg array** — it must either:

1. Be wrapped through `cmd.exe /d /s /c <resolved> ...args` (the same pattern `providers/probe.ts:36-39` uses for the version probe and that `pty/local-pty.ts:184-188` uses for ConPTY launches), OR
2. Be spawned with `{ shell: true }` so Node itself routes through cmd.exe and applies PATHEXT.

Neither happens here. The result is `ENOENT` even though the file exists, because `CreateProcessW` (which Node uses under the hood) does not understand `.cmd` as an executable format.

### Why the error path drops the extension

The user-visible error reads `spawn C:\Users\DaddysHere\AppData\Roaming\npm\claude ENOENT` — note the missing `.cmd`. There are two non-exclusive explanations, both of which lead to the same fix:

- **(a)** The user's npm install really did drop an extensionless Unix-style shim at `…\npm\claude` (some `npm i -g` installs put a `.cmd` next to an extensionless POSIX shim; `where` returns whichever it finds first depending on PATHEXT ordering).
- **(b)** Some intermediate code stripped the extension. Re-reading `probe.ts:14-24` and `runClaudeCliTurn.ts:266-275` shows no such stripping in our codebase; the path is forwarded verbatim from `where` into `spawn`. So (a) is the most likely concrete trigger on this user's machine.

Either way, the **fix is identical**: route `claude.cmd` (or any extensionless npm shim) through `cmd.exe /d /s /c …`, which is exactly what the PTY-side resolver already does.

## 3. The reusable helper that should be used

`resolveWindowsCommand(cmd)` is **already exported** from [`app/src/main/core/pty/local-pty.ts:47-85`](../../app/src/main/core/pty/local-pty.ts) and is already reused by:

- `app/src/main/core/review/runner.ts:10,72` — `npx vitest` review runner
- `app/src/main/core/git/git-ops.ts:14,233` — `git` operations

The sibling helper `resolvePosixCommand` lives at `local-pty.ts:101-118`. The Windows-extension-wrapping logic (`.cmd`/`.bat` → `cmd.exe /d /s /c`, `.ps1` → `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`, `.exe` → direct) is in `platformAwareSpawnArgs()` at `local-pty.ts:175-197` but is **not exported** — currently only `spawnLocalPty` uses it internally.

There is **no general-purpose `spawnExecutable()` helper** wrapping `child_process.spawn` with the same Windows logic. Each consumer (`review/runner.ts`, `git/git-ops.ts`, and now `runClaudeCliTurn.ts`) has had to copy the `resolveWindowsCommand → wrap in cmd.exe` dance. The Sigma Assistant code never got that copy.

## 4. Recommended fix shape (when we go to fix)

Pick ONE of:

### Option A — extract a shared helper (preferred, ~30 LOC)

1. Add `app/src/main/core/util/spawn-cross-platform.ts` exporting `spawnExecutable(cmd: string, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams` that internally:
   - On Windows, calls `resolveWindowsCommand(cmd)` (moved from `pty/local-pty.ts` to the same util module, or re-exported).
   - Wraps `.cmd`/`.bat` through `cmd.exe /d /s /c <resolved> ...args` (mirror `local-pty.ts:184-188`).
   - Wraps `.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <resolved> ...args` (mirror `local-pty.ts:190-194`).
   - Otherwise spawns the resolved `.exe` directly.
   - On POSIX, just `spawn(cmd, args, opts)`.
2. Rewrite `runClaudeCliTurn.ts:336` to use it.
3. Bonus: migrate `review/runner.ts:72` and `git/git-ops.ts:233` over to the same helper to delete two copies of the same fragment.

This is the structurally correct fix and the one v1.4.2 should ship.

### Option B — quick patch with `shell: true` (NOT recommended)

Pass `{ shell: true }` to the existing `spawn(...)` call. Node would then route through `cmd.exe` and apply PATHEXT. **Downsides**:

- Changes argv quoting semantics: every arg becomes a shell-tokenised string. The Sigma Assistant prompt (`'-p', prompt, …`) contains arbitrary user text — would need careful escaping. Today's `args` array is safe precisely because it bypasses the shell.
- Doubles cmd-injection surface for any future prompt-content reflection.
- Doesn't unify with the PTY-side resolver, so we still drift if PATHEXT semantics change.

Listed for completeness — **do not take this option**.

## 5. macOS / Linux impact assessment

**Not directly affected.** On macOS:

- `claude` installs from `npm i -g @anthropic-ai/claude-code` as a real `node`-shebanged JS file at, typically, `/Users/<u>/.npm-global/bin/claude` or `/opt/homebrew/bin/claude` or `/usr/local/bin/claude`.
- `which claude` returns the absolute path; `probeProvider` forwards it; `child_process.spawn(<absolute path>, args)` succeeds because Unix `execvp` handles shebang dispatch.
- The Electron main process does need PATH bootstrapping (Electron does NOT inherit a login-shell PATH on macOS by default) — see `app/electron/main.ts:80-137` (`bootstrapNodeToolPath`). That is **already wired** at `app/electron/main.ts:415`. The bootstrap is a no-op on win32 (`main.ts:91`), correctly relying on Windows' own PATH-resolution semantics — but the assumption that "Windows resolves things itself" breaks for `child_process.spawn` on `.cmd` shims, which is exactly this bug.

The user's hypothesis that this is "could be universal problem" appears to be **wrong about Mac**: the symptom path `AppData\Roaming\npm\claude` is unambiguously a Windows path. **If a Mac user reports the same error string, it is a different bug.** That said, on macOS Catalina-era installs where Claude Code is missing PATH entries that `bootstrapNodeToolPath` doesn't enumerate (Volta paths, nvm shells, custom `~/.config/npm-global/bin`), `probeProvider` returns `found: false` and Sigma Assistant falls back to the no-binary stub — different code path, different error, not this bug.

## 6. Verification steps (for when fix lands)

1. On Windows 11 with `npm i -g @anthropic-ai/claude-code` installed and `where claude` returning `C:\Users\<u>\AppData\Roaming\npm\claude.cmd`:
   - Open Sigma Assistant, type any prompt → expect streaming response, no spawn error.
   - Confirm assistant emits the persisted assistant message row (check `conversations` DB).
2. Run the Sigma Assistant unit suite: `app/src/main/core/assistant/runClaudeCliTurn.test.ts` — add a fixture asserting that on `process.platform === 'win32'`, the spawn override receives `cmd.exe` as bin with `['/d', '/s', '/c', resolvedShim, ...originalArgs]`.
3. Cross-check: the existing PTY pane (Pane 1 Claude) still launches identically. No regression on `local-pty.ts`.
4. macOS regression check: a normal `claude` chat round-trip still works (the new helper's POSIX branch is a thin pass-through).

## 7. File:line evidence map

| Concern | File | Lines |
|---|---|---|
| Bare `spawn(resolvedPath, args)` — the bug | `app/src/main/core/assistant/runClaudeCliTurn.ts` | 332-345 |
| User-visible error string assembly | `app/src/main/core/assistant/runClaudeCliTurn.ts` | 407-414 |
| `probe.resolvedPath` comes from `where claude` | `app/src/main/core/providers/probe.ts` | 14-24, 54-72 |
| Probe version check ALREADY wraps `.cmd` via `cmd.exe` (proof we know how) | `app/src/main/core/providers/probe.ts` | 33-49 |
| Reusable `resolveWindowsCommand` | `app/src/main/core/pty/local-pty.ts` | 47-85 |
| Reusable `resolvePosixCommand` | `app/src/main/core/pty/local-pty.ts` | 101-118 |
| `.cmd`/`.bat`/`.ps1` wrapping logic (not yet exported) | `app/src/main/core/pty/local-pty.ts` | 175-197 |
| Existing reuse of `resolveWindowsCommand` outside PTY | `app/src/main/core/review/runner.ts:10,72`, `app/src/main/core/git/git-ops.ts:14,233` | — |
| W-2 plan that introduced this spawn path (no Windows section) | `docs/03-plan/archive/W-2-sigma-assistant-orchestrator-v1.4.0.md` | 9, 145, 152, 277 |
| Historic PTY-side fix (v1.2.0) for the same family of bugs | `docs/04-design/windows-port.md` | 57-59 |

## 8. Why this slipped through

- The W-2 plan was written by a Mac developer; the spawn snippet was lifted from the Mac-tested `claude -p ... --output-format stream-json` shape with no Windows annotation.
- The CI `release-windows.yml` workflow builds the NSIS EXE on `windows-latest` but does **not** run the assistant turn end-to-end — it cannot, since Claude Code is not installed in CI.
- The vitest unit suite for `runClaudeCliTurn` uses `spawnOverride` to inject a fake child, so it never exercises the actual `child_process.spawn` code path with a Windows `.cmd` shim.
- The dogfood window between v1.4.0 (where this spawn path landed) and v1.4.1 (release tag) was Mac-only.

**Action item for the v1.4.2 plan**: when the fix lands, add an end-to-end Windows test that spawns a stub `.cmd` file from a temp dir and confirms `runClaudeCliTurn` drives stdin/stdout through it without ENOENT.
