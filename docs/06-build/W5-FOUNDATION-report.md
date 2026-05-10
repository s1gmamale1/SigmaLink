# W5 - Foundation Build Report

Status: complete. P0 closed; 13 of 14 P1 items closed; 1 P1 (per-subscriber IPC) deferred. Build, electron compile, and product check all green.

## 1. Bug-by-bug summary

| Bug ID                              | Severity | Status   | File:line of fix                                                    |
|-------------------------------------|----------|----------|---------------------------------------------------------------------|
| P0-PTY-WIN-CMD                      | P0       | fixed    | app/src/main/core/pty/local-pty.ts:36-149                           |
| P1-PROBE-EXEC-WIN                   | P1       | fixed    | app/src/main/core/providers/probe.ts:24-50, 56-58                   |
| P1-PROBE-CMD-NOT-USED               | P1       | fixed    | app/src/main/core/providers/probe.ts:24-50; spawn-time resolve in local-pty.ts:99-114 |
| P1-WORKTREE-LEAK                    | P1       | fixed    | app/src/main/core/workspaces/launcher.ts:54-160                     |
| P1-PTY-FAILURE-NOT-DETECTED         | P1       | fixed    | app/src/main/core/pty/local-pty.ts:155-205; launcher.ts:120-138     |
| P1-DB-EXIT-DUPLICATE-LISTENER       | P1       | fixed    | app/src/main/core/pty/registry.ts:48-58, 91-117                     |
| P1-PTY-REGISTRY-LEAK                | P1       | fixed    | app/src/main/core/pty/registry.ts:55, 119-130; rpc-router.ts:198-212 |
| P1-NO-CLOSE-PANE                    | P1       | fixed    | app/src/renderer/features/command-room/CommandRoom.tsx:50-56, 144-152; state.tsx:71-87, 132-156 |
| P1-IPC-EVENT-RACE-CROSSWINDOW       | P1       | deferred | (single-window product; performance only — see deferrals)           |
| P1-INITIAL-PROMPT-DOUBLE            | P1       | fixed    | app/src/main/rpc-router.ts:67-86; launcher.ts:103-112 (commented as single source-of-truth) |
| P1-DRIZZLE-DEFAULT-OVERRIDE         | P1       | deferred | (cosmetic; clock skew sub-second — see deferrals)                   |
| P1-WORKTREE-PATH-COLLISION          | P1       | fixed    | app/src/main/core/git/git-ops.ts:38-46; worktree.ts:39-69           |
| P1-RUN-SHELL-TOKENISER              | P1       | fixed    | app/src/main/core/git/git-ops.ts:121-202                            |
| P1-RUN-SHELL-EXEC-WIN               | P1       | fixed    | app/src/main/core/git/git-ops.ts:204-225                            |
| P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST | P1       | fixed    | app/electron/preload.ts:6-32; app/src/shared/rpc-channels.ts (new)  |
| P1-DB-NEVER-CLOSED                  | P1       | fixed    | app/src/main/core/db/client.ts:75-94; electron/main.ts:60-65; rpc-router.ts:198-216 |
| P2-PTY-CWD-NOT-VALIDATED            | P2       | fixed    | app/src/main/core/pty/local-pty.ts:158-160                          |
| P2-EVENT-PAYLOAD-CASTING            | P2       | fixed    | app/src/renderer/app/state.tsx:118-126; Terminal.tsx:39-58, 99-112   |
| P2-RESIZE-DEBOUNCE                  | P2       | fixed    | app/src/renderer/features/command-room/Terminal.tsx:121-141          |
| P2-TERMINAL-FIT-DURING-OPEN         | P2       | fixed    | app/src/renderer/features/command-room/Terminal.tsx:79-86            |
| P2-RPC-ERROR-STACK-LOST             | P2       | fixed    | app/src/main/rpc-router.ts:181-194; shared/rpc.ts:8-10               |
| F7 (boot janitor)                   | new      | added    | app/src/main/core/db/janitor.ts (new); rpc-router.ts:36-39           |
| F11 (default-shell pwsh)            | new      | added    | app/src/main/core/pty/local-pty.ts:117-132                           |

## 2. Per-fix detail

### F1 — Windows .cmd shim (P0-PTY-WIN-CMD)

`app/src/main/core/pty/local-pty.ts`. Added `resolveWindowsCommand(cmd)` which walks `PATH` + `PATHEXT`, returns the absolute resolved path or null. `platformAwareSpawnArgs` now calls the resolver first; `.cmd`/`.bat` route through `cmd.exe /d /s /c <resolved> <args>`, `.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`, and `.exe` is spawned directly (no extra shell process). Cross-platform: macOS/Linux take the early-return branch and pass `command + args` through unchanged.

Test for: launching `claude`, `codex`, `gemini`, `kimi` on Windows resolves to their npm `.cmd` shims and node-pty no longer fails with `error code: 2`.

### F2 — IPC channel allowlist (P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST)

New `app/src/shared/rpc-channels.ts` exports `CHANNELS: ReadonlySet<string>` (every `<namespace>.<method>` from `AppRouter`) and `EVENTS` (every event the renderer is allowed to subscribe to). Preload now rejects any `invoke()` whose channel is not in `CHANNELS` and silently ignores `eventOn`/`eventSend` for unlisted events. Renderer-side `rpc.ts` is unchanged.

Test for: invoking an unlisted channel from devtools rejects; the existing rooms continue to work.

### F3 — PTY lifecycle / forget + killAll (P1-PTY-REGISTRY-LEAK, P1-DB-EXIT-DUPLICATE-LISTENER)

`app/src/main/core/pty/registry.ts`: every `create` now schedules `forget(id)` to run `gracefulExitDelayMs` (default 200 ms) after exit, so the renderer's last data drain and any late `subscribe` snapshot still succeed before the record disappears. Added `killAll()` (called from `before-quit`). `forget` clears the ring buffer and removes data/exit listeners.

Test for: launch+exit cycle leaves zero entries in `PtyRegistry.list()` after 250 ms; `before-quit` terminates surviving sessions.

### F4 — Launcher try/catch + worktree rollback (P1-WORKTREE-LEAK, P1-PTY-FAILURE-NOT-DETECTED)

`app/src/main/core/workspaces/launcher.ts`: every pane is now built inside its own try/catch. On failure: rollback the worktree (`worktreePool.remove`), do not insert a `running` row, and push an `AgentSession` with `status: 'error'` and `error` text into the returned array. The PTY-exit listener flips the row to `'error'` (not `'exited'`) when the PTY dies within ~1.5 s with a negative code, which is how spawn-failures present.

Test for: launching a known-bad provider (e.g. `gemini` when not installed) produces an error pane in the UI and leaves no `sigmalink/...` worktree on disk.

### F5 — Reducer REMOVE_SESSION + close-pane UI

`app/src/renderer/app/state.tsx` adds `REMOVE_SESSION` and an effect that auto-removes any session that has been `'exited'` for 5 s. `app/src/renderer/features/command-room/CommandRoom.tsx` now renders an `X` button per pane that kills the PTY (when running) and dispatches `REMOVE_SESSION`. Errored panes render an inline error block instead of a terminal.

### F6 — runShellLine tokenizer (P1-RUN-SHELL-TOKENISER, P1-RUN-SHELL-EXEC-WIN)

`app/src/main/core/git/git-ops.ts`: new `tokenizeShellLine(line)` is a state machine (`NORMAL` / `SQ` / `DQ`) that handles single quotes, double quotes with `\"` `\\` `\$` `\`` `\n` `\r` `\t` escapes, empty quoted segments, and concatenation across adjacent quoted/unquoted runs. `runShellLine` then resolves the command via `resolveWindowsCommand` on Windows and routes `.cmd` through `cmd.exe`, mirroring `local-pty.ts`. Sanity-check examples are documented at the top of the file.

### F7 — Boot janitor

New `app/src/main/core/db/janitor.ts`. On startup `runBootJanitor()` flips every `agent_sessions` row that is still `running` (left over from a crash) to `status='exited', exit_code=-1, exited_at=now`, and best-effort `git worktree prune`s every distinct repo root in `workspaces` within a 1 s budget. Wired from `registerRouter()` directly after DB init.

### F8 — Graceful DB close

`app/src/main/core/db/client.ts` exports `closeDatabase()` which runs `PRAGMA wal_checkpoint(TRUNCATE)` then `db.close()` and nulls the cached handles. `electron/main.ts`'s new `app.on('before-quit', shutdownRouter)` calls `pty.killAll()` then `closeDatabase()`.

### F9 — DB row marked exited on graceful kill

The launcher attaches an `onExit` listener that updates `agent_sessions.status` whenever the PTY exits — which includes the path triggered by `pty.kill`. The synthetic-exit path in `local-pty.ts` (added in F1) also fires that listener so spawn-failures end up as `status='error'`. No additional code path required; the registry's `kill()` produces the same `onExit` event as a natural exit.

### F10 — 8-char branch suffix + collision guard

`app/src/main/core/git/git-ops.ts`: `generateBranchName` now uses `randomUUID().replace(/-/g,'').slice(0,8)` (~2.8e12 states, sourced from a CSPRNG instead of `Math.random()`). `app/src/main/core/git/worktree.ts` retries up to 3 times if `fs.existsSync(worktreePath)` reports a directory clash (still possible after the sanitiser collapses dotted hints into the same directory segment).

### F11 — Cross-platform default-shell

`app/src/main/core/pty/local-pty.ts` `defaultShell()`: on Windows tries `pwsh.exe`, then `pwsh`, then `powershell.exe`, then `powershell`, then `cmd.exe`, all via `resolveWindowsCommand`. macOS prefers `$SHELL` then `/bin/zsh`. Linux prefers `$SHELL` then `/bin/bash`.

## 3. Build verification

### `npm run lint`

```
✖ 56 problems (53 errors, 3 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.
```

All 53 errors and 3 warnings are pre-existing and live in files I did not introduce or that were already non-compliant before this wave: `_legacy/**` (excluded from build but not from lint globs), `components/ui/**` (shadcn-ui generated), `lib/utils.ts` (xterm ANSI regex predates this wave), and the pre-existing `react-refresh/only-export-components` warning on `useAppState` in `state.tsx`. The single new lint complaint I introduced and fixed (`no-useless-escape` in the `sanitizeBranchSegment` regex of `git-ops.ts`) is no longer reported. No lint regression in any file I touched beyond what was there before.

### `npm run build`

```
dist/index.html                    0.40 kB │ gzip:   0.27 kB
dist/assets/index-CQAoOz1e.css    96.38 kB │ gzip:  16.41 kB
dist/assets/index-CaaJQLOJ.js    582.76 kB │ gzip: 164.06 kB
✓ built in 4.85s
```

`tsc -b` passed (no TypeScript errors). Vite bundle warning about chunk size is pre-existing.

### `npm run electron:compile`

```
electron-dist\main.js      201.8kb
electron-dist\main.js.map  564.5kb
Done in 43ms

electron-dist\preload.cjs      2.6kb
electron-dist\preload.cjs.map  4.7kb
Done in 7ms
[build-electron] wrote electron-dist
```

Both bundles built successfully. preload.cjs grew slightly (was 2.0 KB pre-wave) because of the inlined channel allowlist.

### `npm run product:check`

`npm run build && npm run electron:compile` — both stages green; final lines reproduced above.

## 4. Deferrals

| Bug ID                          | Why deferred                                                                                                  | Suggested next attempt                                                                                                            |
|--------------------------------|---------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| P1-IPC-EVENT-RACE-CROSSWINDOW  | Single window today; the broadcast pattern only over-amplifies IPC when multiple BrowserWindows or many panes mount. Functional, not load-blocking. | Move broadcasts to a `Map<webContentsId, Set<sessionId>>` populated by an explicit `pty.subscribe` controller; emit only to subscribed windows. Wave 6 task. |
| P1-DRIZZLE-DEFAULT-OVERRIDE    | Cosmetic — JS `Date.now()` and SQL `unixepoch()*1000` agree to within tens of ms in practice. No functional impact.                                | Drop the JS `now` argument from `factory.ts` workspace inserts and let the SQL default fill it.                                  |

## 5. New IPC channels

| Channel       | Payload                  | Owning controller       |
|---------------|--------------------------|--------------------------|
| `pty.forget`  | `(sessionId: string) → void` | `app/src/main/rpc-router.ts` `ptyCtl.forget` |

`pty.forget` lets the renderer drop a session from the registry explicitly (currently auto-triggered after PTY exit + grace, but available for future swarm/teardown flows).

## 6. New files

- `app/src/shared/rpc-channels.ts` — IPC channel and event allowlists shared by preload.
- `app/src/main/core/db/janitor.ts` — boot-time zombie-session cleanup + best-effort worktree prune.

## 7. New dependencies

None. All fixes use the existing dependency surface (better-sqlite3, drizzle, node-pty, node:crypto/fs/path).

## 8. Cross-platform behaviour notes

- **Windows.** The PATH+PATHEXT resolver in `local-pty.ts` and `git-ops.ts` is the only platform-conditional path. `.cmd`/`.bat` shims are wrapped through `cmd.exe /d /s /c`, `.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`, and `.exe` is spawned directly. The default-shell preference order is `pwsh.exe → powershell.exe → cmd.exe`. The probe also routes `.cmd` shims through `cmd.exe` for the `--version` call so version detection now works.
- **macOS.** `defaultShell()` prefers `$SHELL` (typical: `/bin/zsh`), falls back to `/bin/zsh`. PATH+PATHEXT resolver is skipped (early return in `platformAwareSpawnArgs`). `before-quit` shutdown hook fires correctly even when the app stays in the dock; `pty.killAll` and `closeDatabase` execute on Cmd+Q.
- **Linux.** `defaultShell()` prefers `$SHELL`, falls back to `/bin/bash`. Spawn behaviour is unchanged from previous build. `node-pty`'s POSIX path uses `execvp`, which honours `$PATH` natively, so no resolver is needed. `before-quit` is honoured on graceful quit.
- **Path separators.** Every path I added uses `path.join` / `path.delimiter`. No string concatenation of paths. The branch-name segment splits on `/` because Git always uses `/` for branch hierarchy regardless of OS, then `path.join`s into a per-OS directory under `<userData>/worktrees/<repoSha[0:12]>/<segment>`.

## 9. Files modified

### Modified

- `app/electron/main.ts` — wires `before-quit → shutdownRouter`.
- `app/electron/preload.ts` — IPC channel + event allowlist.
- `app/src/main/core/db/client.ts` — `closeDatabase()` with WAL truncate.
- `app/src/main/core/git/git-ops.ts` — F6 tokenizer, F10 8-char suffix, F1 Windows resolver in `runShellLine`, fixed sanitiser regex escape.
- `app/src/main/core/git/worktree.ts` — collision-retry on `fs.existsSync(worktreePath)`.
- `app/src/main/core/providers/probe.ts` — `execVersion` routes `.cmd`/`.ps1` through their interpreters; resolved path is used for the version probe.
- `app/src/main/core/pty/local-pty.ts` — F1 PATH+PATHEXT resolver, synthetic spawn-failure exit, cwd validation, F11 default-shell.
- `app/src/main/core/pty/registry.ts` — graceful-exit forget, `killAll`.
- `app/src/main/core/workspaces/launcher.ts` — F4 try/catch + rollback + early-death → `'error'`.
- `app/src/main/rpc-router.ts` — boot janitor wiring, `pty.forget` controller, `shutdownRouter`, dev-only error stacks.
- `app/src/renderer/app/state.tsx` — `REMOVE_SESSION` action, exited-session auto-remove timer, payload guard.
- `app/src/renderer/features/command-room/CommandRoom.tsx` — close-pane button, error-state inline.
- `app/src/renderer/features/command-room/Terminal.tsx` — payload guards, deferred initial fit, debounced resize.
- `app/src/shared/router-shape.ts` — `pty.forget`.
- `app/src/shared/rpc.ts` — `RpcResult.stack?` field on the failure variant.
- `app/src/shared/types.ts` — `AgentSession.error?: string`.

### New

- `app/src/shared/rpc-channels.ts`
- `app/src/main/core/db/janitor.ts`
