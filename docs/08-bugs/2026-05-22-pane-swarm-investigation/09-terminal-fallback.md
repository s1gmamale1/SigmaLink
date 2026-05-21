# LANE 9 — Terminal Fallback on CLI Crash

## Current State

### 1. `altCommands` fallback in `resolveAndSpawn` (`providers/launcher.ts`)

Scope: **spawn-time ENOENT only**. When `pty.create` throws an ENOENT-shaped error, `resolveAndSpawn` walks `[command, ...altCommands]` and retries each in turn (`local-pty.ts:494–510` syncs the pre-flight check so POSIX surfaces ENOENT early). Non-ENOENT failures (permission denied, runtime crash) abort immediately and bubble as `ProviderLaunchError{code:'spawn-failed'}`.

This has nothing to do with a CLI crashing *after* successful spawn. It is strictly a "binary not found at launch" fallback.

### 2. Shell-first mode (`pty.spawnMode = 'shell-first'`)

When the KV key `pty.spawnMode` is `'shell-first'`, `spawnShellFirstPty` (`local-pty.ts:665`) spawns the user's **default shell** as the actual PTY child and writes the CLI command line (e.g. `claude --session-id <uuid>`) into the shell's stdin 250 ms after the first prompt arrives. The shell parent process stays alive for the entire PTY lifetime.

Outcome: if the CLI exits (crash or clean exit), the shell returns to its interactive prompt. **The PTY / pane remains open.** The sentinel mechanism (`buildSentinelSnippet`, `extractSentinel`) detects the CLI's exit code, strips the marker from the forwarded data, fires `onCliExited` in the registry, and leaves the xterm display on-screen at the shell prompt.

This **is the fallback the user wants** — a crashed CLI leaves a live shell the user can type into.

However: the feature is **default-off**. `parseSpawnMode` in `local-pty.ts:199` returns `'direct'` for any value other than the literal string `'shell-first'`. The flip-to-default comment (`local-pty.ts:467`) requires explicit operator sign-off after Windows dogfood. As of v1.12.1, new panes spawn in `'direct'` mode unless the user opts in via **Settings → Experimental → "Shell-first panes"** toggle.

### 3. Scratch-shell sub-tabs (`Cmd+T` / `Ctrl+Shift+T`)

`PaneShell.tsx:108–117` spawns an ephemeral `shell` PTY via `rpc.pty.spawnScratch`. The result is a separate sub-tab that is a standalone interactive shell. It is a **manual convenience**, not an auto-fallback: the user must press `Cmd+T` proactively before or after the CLI crashes. Closing the tab calls `rpc.pty.killScratch`, which kills and forgets the PTY immediately.

### 4. What happens in `'direct'` mode when a CLI exits / crashes

1. PTY emits `onExit` → registry broadcasts `pty:exit` to renderer.
2. `terminal-cache.ts:244–253` writes `\r\n[session exited code=N]\r\n` into the xterm scrollback.
3. `use-live-events.ts:29–36` dispatches `MARK_SESSION_EXITED` → session `status` becomes `'exited'` or `'error'`.
4. `PaneHeader.tsx:114` changes the status dot to grey (`#9ca3af` for exited) or red (for error).
5. **The pane stays mounted.** The xterm is still rendered; the terminal content is still visible. The PTY fd is dead — keystrokes from xterm are ignored by the dead handle (`pty.write` is a no-op after `forget`). There is no auto-remove and no drop-to-shell.
6. The user must press `Cmd+T` to open a scratch shell or press Close / "Close pane" to dismiss.

### 5. `onCliExited` path (shell-first mode only)

When `onCliExited` fires the registry does **not** broadcast `pty:exit` — it fires only the notifications source (`pushPtyExitNotification`). The `MARK_SESSION_EXITED` reducer action is never dispatched; the session stays `status:'running'` in the renderer. The pane remains alive with the interactive shell prompt visible.

---

## Gap Analysis

| Mode | CLI crashes | Pane state | User can type |
|---|---|---|---|
| `direct` (default) | PTY exits → `[session exited code=N]` in scrollback | Stays mounted, status dot grey | No — keystrokes ignored |
| `shell-first` (opt-in) | CLI exits → sentinel → shell prompt | Stays mounted, status unchanged | **Yes — live shell** |

The user's expectation ("fall back to a normal terminal") is **implemented but gated behind an experimental opt-in flag**. In direct mode there is no fallback at all: the pane is a frozen scrollback.

Two secondary gaps in the shell-first path:

1. **No UI cue that the CLI exited.** `onCliExited` does not update `session.status`; the status dot stays green. The user only knows the CLI exited because the xterm output stops and a shell prompt appears. No banner, no status change.
2. **`onCliExited` is not broadcast to the renderer.** There is no `pty:cli-exited` event in `EventMap` (`shared/events.ts`). The renderer cannot react (e.g. change dot color or show a "restart" affordance) without a new event.

---

## Proposed Design

### Option A — Flip `shell-first` to default-on (minimal)

Change `parseSpawnMode` fallback from `'direct'` to `'shell-first'` after Windows dogfood sign-off. This alone gives every new pane the terminal-fallback behaviour with no additional code.

Prerequisite: Windows dogfood completion and operator sign-off. The comment at `local-pty.ts:467` marks this explicitly.

### Option B — Add `pty:cli-exited` event + status cue (additive, works today)

1. Add `'pty:cli-exited': { sessionId: string; exitCode: number }` to `EventMap`.
2. In `rpc-router.ts` `onCliExited`, broadcast the event alongside the notification push.
3. In `use-live-events.ts`, subscribe and dispatch a new action (e.g. `CLI_EXITED`) that sets `session.status` to `'cli-exited'` (distinct from `'exited'` so the pane knows the PTY is still alive).
4. In `PaneHeader.tsx`, map `'cli-exited'` to a amber/yellow dot color and optionally show a "Relaunch" chip.
5. In `terminal-cache.ts`, write a dim banner (`[CLI exited code=N — shell active]`) into the xterm when `cli-exited` fires, mirroring the existing `[session exited code=N]` line in the direct-mode exit path.

This option is additive and can ship before the shell-first default flip.

### Option C — On-crash keep-shell option in direct mode (new feature)

Add a new `pty.onCrashSpawnShell` KV flag (default off). When set, the registry's `onExit` callback checks the exit code: non-zero → spawn a plain shell PTY in the same cwd and inject its `scratchId` into the existing session record so the renderer reuses the live xterm without a pane reload. Essentially auto-executes a `spawnScratch` on behalf of the user when the CLI dies unexpectedly.

This requires the most new code but provides the smoothest UX and works without the shell-first startup overhead on every pane.

### Recommended path

1. **Short term**: implement Option B to surface the shell-first CLI-exit state in the UI. This is a small additive change.
2. **Medium term**: flip shell-first to default after Windows dogfood (Option A), which makes Option C unnecessary for the common case.
3. **Long term (optional)**: Option C as a power-user setting for users who want the guarantee even in direct mode.

---

## File References

- `/Users/aisigma/projects/SigmaLink/app/src/main/core/providers/launcher.ts` — `resolveAndSpawn`, `altCommands` walk, `isENOENT` scope
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/pty/local-pty.ts` — `spawnLocalPty`, `spawnShellFirstPty`, `parseSpawnMode`, `KV_PTY_SPAWN_MODE`, `buildShellCommandLine`
- `/Users/aisigma/projects/SigmaLink/app/src/main/core/pty/registry.ts` — `onCliExited` sink, `onExit` lifecycle, `pty:exit` broadcast wiring
- `/Users/aisigma/projects/SigmaLink/app/src/main/rpc-router.ts:319–406` — `PtyRegistry` construction, `onCliExited` handler (notifications only, no broadcast)
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/lib/terminal-cache.ts:244–253` — `[session exited code=N]` banner on `pty:exit`
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/app/state-hooks/use-live-events.ts:29–37` — `MARK_SESSION_EXITED` dispatch
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/PaneShell.tsx:108–136` — `spawnScratch` / `closeScratch` (Cmd+T scratch sub-tabs)
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/command-room/PaneHeader.tsx:112–114` — status dot colours
- `/Users/aisigma/projects/SigmaLink/app/src/renderer/features/settings/RufloSettings.tsx:460–479` — "Shell-first panes" opt-in toggle
- `/Users/aisigma/projects/SigmaLink/app/src/shared/events.ts` — `EventMap` (no `pty:cli-exited` entry today)
