# 01 - Known Bug: Windows PTY "Cannot create process, error code: 2"

**Severity:** P0 - blocks every CLI agent launch on Windows.
**Reported by:** user; reproduces on Windows 11 with `C:/Users/DaddysHere/Documents/Homeworks` (Git repo).
**Status:** Root cause confirmed by code inspection.

---

## Summary

When the user launches any CLI-agent provider (Claude Code, Codex, Gemini, Kimi, Cursor Agent, OpenCode, Aider, Continue) the renderer surfaces red text:

```
Cannot create process, error code: 2
```

and no terminal output appears. The `Shell` provider (with empty command) is unaffected because it falls through to the default-shell branch and resolves to `cmd.exe` or `powershell.exe`.

The error comes from **node-pty's Windows ConPTY agent**: error code `2` is `ERROR_FILE_NOT_FOUND` from `CreateProcessW`. ConPTY does not perform PATHEXT resolution like a shell does; it requires the executable to be a real `.exe` (or have its full extension resolvable as a file). npm-installed Node CLIs on Windows are not `.exe` - they ship as `<bin>` (a Bourne-style shim with no extension) plus `<bin>.cmd` (the Windows shim that `cmd.exe` recognises). When node-pty tries to `CreateProcessW("claude", ...)`, Windows looks for a literal file named `claude` in PATH, finds none, and returns 2.

---

## Evidence

### 1. Provider definitions use extensionless commands

`app/src/shared/providers.ts:23-77` — each provider has `command: 'claude' | 'codex' | 'gemini' | 'kimi' | ...`. Only Claude has an `altCommands: ['claude.cmd']` fallback, and it is only consulted by the **probe** path (probe.ts), never by the spawn path.

```ts
{
  id: 'claude',
  ...
  command: 'claude',
  altCommands: ['claude.cmd'],
  ...
},
{
  id: 'codex',
  ...
  command: 'codex',
  args: [],
  ...
},
{
  id: 'gemini',
  ...
  command: 'gemini',
  ...
},
{
  id: 'kimi',
  ...
  command: 'kimi',
  ...
},
```

### 2. `local-pty.ts` only wraps when extension is already present

`app/src/main/core/pty/local-pty.ts:34-56`:

```ts
function windowsExtensionFor(cmd: string): string | null {
  const ext = path.extname(cmd).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  return null;
}

function platformAwareSpawnArgs(input: SpawnInput): { command: string; args: string[] } {
  if (!input.command) return defaultShell();
  if (process.platform !== 'win32') return { command: input.command, args: input.args };
  // Windows: wrap .cmd/.bat through cmd.exe and .ps1 through powershell.exe
  const kind = windowsExtensionFor(input.command);
  if (kind === 'cmd') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', input.command, ...input.args] };
  }
  if (kind === 'ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', input.command, ...input.args],
    };
  }
  return { command: input.command, args: input.args };  // <-- bug: extensionless commands fall through
}
```

When `input.command === 'claude'`, `path.extname('claude') === ''` so `windowsExtensionFor` returns `null` and the function returns the raw command unchanged. node-pty then attempts `CreateProcessW("claude", ...)` which fails with code 2.

### 3. Launcher passes the bare provider command

`app/src/main/core/workspaces/launcher.ts:68-75`:

```ts
const rec = deps.pty.create({
  providerId: provider.id,
  command: provider.command,   // <-- "claude" / "codex" / "gemini" / "kimi"
  args,
  cwd,
  cols: deps.defaultCols ?? 120,
  rows: deps.defaultRows ?? 32,
});
```

There is no resolution step that maps `claude` -> `claude.cmd` on Windows.

### 4. `rpc-router.ts` has the same pattern

`app/src/main/rpc-router.ts:51-62`:

```ts
const definition = AGENT_PROVIDERS.find((p) => p.id === providerId);
const command = definition?.command ?? '';
...
const rec = pty.create({
  providerId,
  command,
  args,
  cwd: input.cwd,
  ...
});
```

Same issue: `command` is the bare CLI name with no Windows-specific resolution.

### 5. The probe path *does* resolve `.cmd` but its result is discarded

`app/src/main/core/providers/probe.ts:21-39` walks `[command, ...altCommands]` calling `where claude` / `where claude.cmd`. The resolved path is returned in `ProviderProbe.resolvedPath` and shown in the launcher as a checkmark, but it is **not stored** and **not threaded into the spawn call**. The spawn path always uses `provider.command` (the bare name).

### 6. Why the legacy app worked

The pre-Phase-1 implementation (referenced in `info.md`) wrapped every PTY through `cmd.exe /d /s /k <commandline>`. cmd.exe's command parser walks PATH **and PATHEXT**, so `claude` resolves to `claude.cmd` automatically. The new `local-pty.ts` removed that universal wrapper and only kept it for already-suffixed `.cmd/.bat`, breaking npm-installed CLIs.

---

## Root Cause (one sentence)

`platformAwareSpawnArgs` in `app/src/main/core/pty/local-pty.ts` only wraps commands through `cmd.exe` when the command string already ends in `.cmd`/`.bat`/`.ps1`; npm shims like `claude`, `codex`, `gemini`, `kimi` are extensionless and bypass the wrapper, so node-pty / ConPTY's `CreateProcessW` fails with `ERROR_FILE_NOT_FOUND` (code 2).

---

## Reproduction Steps

1. On Windows 11, install at least one CLI agent globally: `npm i -g @anthropic-ai/claude-code` (creates `%APPDATA%\npm\claude` and `%APPDATA%\npm\claude.cmd`).
2. Verify the shim resolves: `where claude` -> two paths, the `.cmd` first.
3. Open the SigmaLink app, pick `C:/Users/DaddysHere/Documents/Homeworks` (a Git repo), choose `1 pane`, assign `Claude Code`, click `Launch`.
4. Observe: the Command Room opens, the pane frame renders, then the terminal area shows `Cannot create process, error code: 2` in red.
5. Same result for `codex`, `gemini`, `kimi`. Picking `Shell` works because the empty-command branch falls through to `defaultShell()` which uses `powershell.exe` / `cmd.exe`.

---

## Proposed Patch (do NOT apply without review)

The minimal fix is to resolve extensionless commands to their `.cmd` shim on Windows, **or** wrap the entire command line through `cmd.exe /d /s /c` the way the legacy shell did. The latter matches user mental model (PATHEXT respected, quoting handled by cmd) and is closer to the previous working behaviour.

Unified diff against `app/src/main/core/pty/local-pty.ts`:

```diff
--- a/app/src/main/core/pty/local-pty.ts
+++ b/app/src/main/core/pty/local-pty.ts
@@ -32,6 +32,28 @@ function defaultShell(): { command: string; args: string[] } {
   return { command: sh, args: ['-l'] };
 }

+// Windows: resolve a bare command like "claude" against PATH+PATHEXT so we
+// can hand a real file path to ConPTY's CreateProcessW (which does not do
+// shell-style resolution).
+function resolveWindowsCommand(cmd: string): string | null {
+  const fs = require('node:fs') as typeof import('node:fs');
+  const pathMod = require('node:path') as typeof import('node:path');
+  if (pathMod.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;
+  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
+  const dirs = (process.env.PATH ?? '').split(pathMod.delimiter).filter(Boolean);
+  // If cmd already has an extension, only check it directly.
+  const hasExt = pathMod.extname(cmd).length > 0;
+  for (const dir of dirs) {
+    const base = pathMod.join(dir, cmd);
+    if (hasExt) {
+      if (fs.existsSync(base)) return base;
+    } else {
+      for (const ext of exts) {
+        const candidate = base + ext;
+        if (fs.existsSync(candidate)) return candidate;
+      }
+    }
+  }
+  return null;
+}
+
 function windowsExtensionFor(cmd: string): string | null {
   const ext = path.extname(cmd).toLowerCase();
   if (ext === '.cmd' || ext === '.bat') return 'cmd';
@@ -42,7 +64,15 @@ function windowsExtensionFor(cmd: string): string | null {
 function platformAwareSpawnArgs(input: SpawnInput): { command: string; args: string[] } {
   if (!input.command) return defaultShell();
   if (process.platform !== 'win32') return { command: input.command, args: input.args };
-  // Windows: wrap .cmd/.bat through cmd.exe and .ps1 through powershell.exe
+  // Windows: resolve PATH+PATHEXT then wrap shims through cmd.exe.
+  const resolved = resolveWindowsCommand(input.command) ?? input.command;
+  const kindResolved = windowsExtensionFor(resolved);
+  if (kindResolved === 'cmd') {
+    return { command: 'cmd.exe', args: ['/d', '/s', '/c', resolved, ...input.args] };
+  }
+  if (kindResolved === 'ps1') {
+    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...input.args] };
+  }
   const kind = windowsExtensionFor(input.command);
   if (kind === 'cmd') {
     return { command: 'cmd.exe', args: ['/d', '/s', '/c', input.command, ...input.args] };
@@ -53,5 +83,5 @@ function platformAwareSpawnArgs(input: SpawnInput): { command: string; args: str
       args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', input.command, ...input.args],
     };
   }
-  return { command: input.command, args: input.args };
+  return { command: resolved, args: input.args };
 }
```

### Alternative (one-line, more conservative)

Wrap every Windows non-shell command through `cmd.exe /d /s /c` exactly like the legacy build did. This guarantees PATHEXT lookup but inherits cmd.exe quoting quirks for arguments that contain `&`, `|`, `^`, `(`, `)`, `<`, `>`, `"`. For the small fixed argv the agents use today, this is acceptable and matches the previously-working behaviour.

```diff
 function platformAwareSpawnArgs(input: SpawnInput): { command: string; args: string[] } {
   if (!input.command) return defaultShell();
-  if (process.platform !== 'win32') return { command: input.command, args: input.args };
-  ...
+  if (process.platform !== 'win32') return { command: input.command, args: input.args };
+  // Windows: always go through cmd.exe so PATHEXT applies and .cmd shims work.
+  return { command: 'cmd.exe', args: ['/d', '/s', '/c', input.command, ...input.args] };
 }
```

The author should pick **one** of the two; combining them is unnecessary. I recommend the first (PATH+PATHEXT resolver) because it preserves the future ability to spawn a true `.exe` directly and only falls back to cmd.exe when actually launching a `.cmd`.

### Other changes worth bundling with the fix

- `app/src/main/core/providers/probe.ts:30-31` calls `execCmd(cmd, ['--version'], ...)` which uses `child_process.spawn` with `shell: false`. **This will fail for the same reason** when `cmd` is `claude`/`codex`/etc. The probe currently "works" only because `whichLike` runs first and returns success/failure; if `where claude` returns something but the literal `claude` (no extension) is not directly executable, the version detection silently fails. The probe should pass `resolved` (the path returned by `where`) into `execCmd` instead of the bare name.
- `app/src/main/lib/exec.ts:73-77` has a `resolveCommand` stub that returns its input unchanged. It is unused. Either delete it or wire it in.

---

## Risk if Unfixed

- All non-Shell launches fail. The product's primary value proposition (parallel CLI agents in worktree panes) is unusable on Windows.
- The user sees only the inline ConPTY error string; nothing in the UI reports the underlying cause, so the bug is opaque.
- Worktree directories created by `WorktreePool.create` (in `launcher.ts`) are still on disk because the launch path commits the DB row before observing PTY failure. Each failed launch leaks one worktree per pane (see `02-bug-sweep.md` P1-WORKTREE-LEAK).
- DB rows for those sessions are inserted with `status: 'running'` and never updated to `'error'` because PTY exit doesn't fire when CreateProcessW fails - node-pty emits a single `data` chunk with the error string and the process is born already-dead. This pollutes `agent_sessions` with permanently-running zombies.

---

## File:Line Index

- Bug origin: `app/src/main/core/pty/local-pty.ts:41-56` (`platformAwareSpawnArgs`)
- Caller 1: `app/src/main/core/workspaces/launcher.ts:68-75`
- Caller 2: `app/src/main/rpc-router.ts:51-69` (`pty.create` controller)
- Provider definitions: `app/src/shared/providers.ts:25-76`
- Probe path that should-but-doesn't share resolution: `app/src/main/core/providers/probe.ts:9-39`
- Unused helper: `app/src/main/lib/exec.ts:73-77`
