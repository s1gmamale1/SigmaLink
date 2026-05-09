# 02 - Bug Sweep

**Counts:** P0 = 1, P1 = 14, P2 = 17, P3 = 9.
The single P0 is the Windows PTY launch failure documented in detail in `01-known-bug-windows-pty.md`. The P1 list contains every issue that produces wrong behaviour, leaks resources, or leaves the user state inconsistent on currently-supported flows; the P2 list is correctness/polish that does not block usage; P3 is hygiene and forward-looking work. Every entry cites file:line and quotes the relevant code.

---

## P0 — Blocks Launch

### P0-PTY-WIN-CMD - Windows agents fail with `Cannot create process, error code: 2`

- Location: `app/src/main/core/pty/local-pty.ts:41-56`
- Evidence: see `01-known-bug-windows-pty.md` for full analysis.
- Fix: resolve PATH+PATHEXT for extensionless commands on Windows, wrap `.cmd` through `cmd.exe /d /s /c`. Diff in the linked report.

---

## P1 — Functional but Wrong

### P1-PROBE-EXEC-WIN - Provider probe `--version` will also fail on Windows

- Location: `app/src/main/core/providers/probe.ts:29-32`
- Evidence:
  ```ts
  const v = await execCmd(cmd, versionArgs, { timeoutMs: 8_000 });
  ```
  `cmd` here is the bare name (e.g. `claude`). `execCmd` uses `child_process.spawn` with `shell: false`. On Windows this requires a real executable file - same root cause as P0. The probe will report `found: true` (because `where claude` succeeds) but `version: undefined` because the version probe silently throws and is swallowed by the surrounding `try { ... } catch { /* probe is best-effort */ }`.
- Fix: pass the `resolved` path from `whichLike` into `execCmd` instead of the bare command. Or invoke through `cmd.exe /d /s /c <cmd> --version`.

### P1-PROBE-CMD-NOT-USED - Resolved `.cmd` path discarded

- Location: `app/src/main/core/providers/probe.ts:21-39`; `app/src/shared/providers.ts:30` (`altCommands: ['claude.cmd']`)
- Evidence: probe iterates `[command, ...altCommands]` and stores the resolved path in `ProviderProbe.resolvedPath`, but the launcher and `pty.create` controller never read `resolvedPath`; they always re-use `provider.command`. The `altCommands` field is therefore decorative for runtime purposes.
- Fix: thread `resolvedPath` (or a normalised "spawn target") into the launcher so PATH lookups happen once, at probe time.

### P1-WORKTREE-LEAK - Failed launches leak worktree directories and DB rows

- Location: `app/src/main/core/workspaces/launcher.ts:54-90`
- Evidence: `worktreePool.create` is awaited *before* `pty.create`. If the PTY spawn fails (P0) or any later step throws, there is no `try/catch` to roll back the worktree directory or delete the just-inserted `agent_sessions` row. The next loop iteration may also throw mid-way leaving partially-launched panes.
  ```ts
  if (wsRow.repoMode === 'git' && wsRow.repoRoot) {
    const r = await deps.worktreePool.create({ ... });
    worktreePath = r.worktreePath;
    branch = r.branch;
  }
  ...
  const rec = deps.pty.create({ ... });
  ...
  db.insert(agentSessions).values({ ..., status: 'running', ... }).run();
  ```
- Fix: wrap each pane in try/catch; on failure call `worktreePool.remove(repoRoot, worktreePath)` and either skip the DB insert or insert with `status: 'error'`.

### P1-PTY-FAILURE-NOT-DETECTED - PTY birth failures are not surfaced

- Location: `app/src/main/core/pty/local-pty.ts:66-72`; `app/src/main/core/pty/registry.ts:35-66`
- Evidence: `nodePty.spawn` is called synchronously with no try/catch. On Windows, spawn-time failures arrive as a synthetic data chunk (`Cannot create process, error code: 2`) followed by an `onExit` with code -1. There is no main-process logging, no DB status update path that flips `running` -> `error`, and the renderer only shows the inline data string.
- Fix: wrap `nodePty.spawn` in try/catch; emit `pty:exit` synthetically when caught; in `launcher.ts` register an `onExit` handler that flips the row to `'error'` when the exit happens within e.g. <1s or with code <0.

### P1-DB-EXIT-DUPLICATE-LISTENER - Exit handler attached twice per session

- Location: `app/src/main/core/workspaces/launcher.ts:116-125`; `app/src/main/core/pty/registry.ts:43-51`
- Evidence: `registry.create` already attaches an internal `onExit` that broadcasts `pty:exit` and updates the in-memory `SessionRecord`. The launcher then calls `rec.pty.onExit(...)` again to update the DB row. Two listeners is intentional, but the launcher's second listener is **never disposed**. Once `registry.forget(id)` is called the inner Set is dropped, but the launcher's closure (which captured `db`, `agentSessions`, `finalSessionId`) is still pinned via `dataSubs`/`exitSubs` *only inside the registry*. After `forget`, the listener Set is garbage-collected, so it self-cleans - but only because `forget` runs `unsubData/unsubExit` which clears the Set entirely. **`forget` is never called anywhere in the codebase**, so all session records stay in the registry forever (P1-PTY-REGISTRY-LEAK).
- Fix: ensure `forget` runs after final exit + buffer drain; or have the launcher attach its DB-update listener via the registry's exit broadcast and not directly on the PtyHandle.

### P1-PTY-REGISTRY-LEAK - Sessions are never forgotten

- Location: `app/src/main/core/pty/registry.ts:94-100`; entire repo
- Evidence: `PtyRegistry.forget(id)` is defined but `grep -rn "forget"` only matches the definition - nothing calls it. Every PTY session lives in the in-memory map until the app quits, including its 256 KiB ring buffer per pane.
- Fix: when `pty:exit` fires + after some grace period (e.g. 30s for buffer replay), or when the user closes a pane in the UI, call `registry.forget(id)`. Phase-1 minimum is to call it from a "close pane" UI affordance (which is also missing — see P1-NO-CLOSE-PANE).

### P1-NO-CLOSE-PANE - No way to remove a pane from the grid

- Location: `app/src/renderer/features/command-room/CommandRoom.tsx:124-134`
- Evidence: the only per-pane action is the Stop button which calls `rpc.pty.kill`. The session stays in `state.sessions`, the DB row stays, the worktree stays, and the pane keeps rendering "exited". Sessions accumulate across launches forever within a single app run because reducer `ADD_SESSIONS` only inserts and never removes.
- Fix: add a "remove" action that calls `rpc.pty.forget`/cleanup + dispatches `REMOVE_SESSION`. Renderer reducer (`app/src/renderer/app/state.tsx:46-78`) has no remove action defined.

### P1-IPC-EVENT-RACE-CROSSWINDOW - PTY events broadcast to all windows; subscribe race is not airtight

- Location: `app/src/main/rpc-router.ts:20-24`; `app/src/renderer/features/command-room/Terminal.tsx:75-93`
- Evidence: `broadcast` sends to every BrowserWindow's webContents. Today there is only one window, but the comment in `Terminal.tsx` claims "subscribe order is: register live data listener FIRST". That is true within a single mount, but **`pty.subscribe` does not register the renderer with the main process** - `subscribe` only returns the snapshot. The live listener is `eventOn('pty:data', ...)` registered at preload, which fires for **every pty:data event regardless of session**. Since data is filtered in JS (`if (p.sessionId === sessionId)`), every Terminal instance receives every pane's data over IPC. With 16 panes that is 16x the ideal IPC traffic, plus 16 string compares per chunk.
- Fix: keep an opt-in subscriber set in the main process keyed by webContents id and session id; emit only to subscribed windows.

### P1-INITIAL-PROMPT-DOUBLE - Initial prompt could be sent twice

- Location: `app/src/main/rpc-router.ts:63-67`; `app/src/main/core/workspaces/launcher.ts:93-101`
- Evidence: both the controller and the launcher schedule a `pty.write(initialPrompt + '\n')` after a setTimeout. If a caller invokes `pty.create` directly with `initialPrompt` (the controller path) AND that same path is also being used in launches, the prompt could fire twice. Today `executeLaunchPlan` does not call the controller's `pty.create` (it calls `pty.create` on the registry directly), so the duplication does not occur today, but the duplicated logic is fragile.
- Fix: keep only one place (the launcher) responsible for typing the initial prompt.

### P1-DRIZZLE-DEFAULT-OVERRIDE - SQL default `created_at` overwritten unintentionally

- Location: `app/src/main/core/db/schema.ts:21-26`; `app/src/main/core/workspaces/factory.ts:43-54`
- Evidence: schema defaults `createdAt = unixepoch()*1000` but the factory always passes `createdAt: now`. Harmless today but the bootstrap SQL also sets a default; if Drizzle is later re-run with a partial insert, `now` from the renderer JS clock and the SQL `unixepoch()` clock could disagree by hundreds of ms during heavy load. Cosmetic.
- Fix: pick one source of truth. Recommended: drop the JS `now` argument and let SQLite's clock fill it.

### P1-WORKTREE-PATH-COLLISION - Branch suffix only 5 chars, collisions silently fail

- Location: `app/src/main/core/git/git-ops.ts:35-39`
- Evidence:
  ```ts
  export function generateBranchName(role: string, hint?: string): string {
    const suffix = Math.random().toString(36).slice(2, 7);
    ...
  }
  ```
  5 random base-36 chars = ~60 million states. Collision probability is small but `worktreeAdd` will throw `fatal: '<path>' already exists` and the launcher has no retry. Worse: `pathForBranch` strips the `sigmalink/` prefix and uses the role+hint+suffix as the directory name, so two panes for the same role+hint will produce different *branch* names but possibly the same *directory* name if the random suffix collides only after sanitisation.
- Fix: use `randomUUID().slice(0,8)` and/or check `fs.existsSync(worktreePath)` before calling git, retry on conflict.

### P1-RUN-SHELL-TOKENISER - `runShellLine` mishandles single quotes nested in double quotes and escapes

- Location: `app/src/main/core/git/git-ops.ts:115-124`
- Evidence:
  ```ts
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  ```
  The regex does not support `\"` escapes, does not handle backticks, and silently drops empty quoted segments (`m[1] ?? m[2] ?? m[3] ?? ''`). A user running `git commit -m "It's working"` will be tokenised as `["git","commit","-m","It"]`, dropping `s working"`. This RPC is exposed to the renderer (`git.runCommand`) so any future UI that lets users type git commands will hit this.
- Fix: use a real shell-style tokeniser (e.g. `shell-quote` package) or refuse to expose `runCommand` to the renderer at all (it has no current caller).

### P1-RUN-SHELL-EXEC-WIN - `runShellLine` fails on Windows for `.cmd` tools

- Location: `app/src/main/core/git/git-ops.ts:121-122`
- Evidence: identical class to P0 and P1-PROBE-EXEC-WIN. `execCmd(cmd, args)` will not resolve PATHEXT, so a UI invocation of `runShellLine(cwd, "npm install")` would fail because `npm` on Windows is `npm.cmd`. Git itself ships as `git.exe` so today's only callsite (`worktreeRemove` indirectly) works.

### P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST - Preload exposes generic invoke to any channel name

- Location: `app/electron/preload.ts:6-13`; `app/src/main/rpc-router.ts:166-183`
- Evidence: preload exposes `invoke(channel, ...args)` with no allowlist. In the current code the renderer is loaded from the dev server (or local file://); compromise of any imported npm package that runs in the renderer can call any channel including `git.runCommand` (arbitrary command execution in arbitrary cwd) and `workspaces.launch` (spawns processes). The compromise vector is small (no remote content is loaded) but the blast radius is large.
- Fix: define `ALLOWED_CHANNELS` in preload (a literal array derived from `router-shape.ts`) and reject anything else; or expose a typed surface (`window.sigma.app.getVersion`) instead of generic `invoke`.

### P1-DB-NEVER-CLOSED - SQLite handle and WAL never flushed on quit

- Location: `app/electron/main.ts:59-61`; `app/src/main/core/db/client.ts:50-63`
- Evidence: `app.on('window-all-closed')` calls `app.quit()` directly. There is no `app.on('before-quit')` handler that closes `rawDb`. better-sqlite3 WAL mode survives a hard quit but a graceful close is best-practice and would also let us call `worktreePool.remove` and `pty.kill` for any survivor sessions.
- Fix: register a `before-quit` handler that calls `rawDb.close()`, marks any `running` sessions `'error'`, and removes orphan worktrees.

---

## P2 — Polish / Functional but Acceptable

### P2-PTY-CWD-NOT-VALIDATED - cwd not checked before spawn

- Location: `app/src/main/core/pty/local-pty.ts:67-68`
- Evidence: `cwd: input.cwd || os.homedir()`. If the caller passes a non-existent path, ConPTY also fails with code 2/3. The launcher constructs `cwd` from `worktreePath ?? wsRow.rootPath`; both are validated upstream, but a future caller could pass a stale path.
- Fix: `if (!fs.existsSync(input.cwd)) throw`.

### P2-PTY-COLS-CLAMP-LOW - 20-col floor truncates JetBrains-style narrow panes

- Location: `app/src/main/core/pty/local-pty.ts:69`
- Evidence: `Math.max(20, input.cols | 0)`. For a 16-pane mosaic on a 1480-wide window each pane gets ~92 cols; not a problem today, but the `| 0` truncates floats silently which is fine and the floor is fine. Cosmetic only.

### P2-RING-BUFFER-CHAR-LIMIT - Limit measured in `string.length`, not bytes

- Location: `app/src/main/core/pty/ring-buffer.ts:14-28`
- Evidence: `this.size += chunk.length` where `chunk.length` is UTF-16 code units. For agents that emit emoji or CJK, the byte size can exceed the nominal 256 KiB by ~2-4x. Not catastrophic but the comment claims "256 KiB per session" which is misleading.
- Fix: clarify comment or use `Buffer.byteLength(chunk, 'utf8')`.

### P2-RING-BUFFER-UNICODE-SPLIT - Hard-trim can split a multi-unit codepoint

- Location: `app/src/main/core/pty/ring-buffer.ts:22-26`
- Evidence: `only.slice(only.length - this.limit)` may slice in the middle of a surrogate pair, producing a lone high or low surrogate that xterm renders as a replacement character.
- Fix: walk back to a surrogate boundary before slicing.

### P2-TERMINAL-FIT-DURING-OPEN - First fit can throw silently

- Location: `app/src/renderer/features/command-room/Terminal.tsx:67-71`
- Evidence: try/catch swallows the error. Often happens because the container has zero height during initial render. Effect dependencies don't re-run on container size change; only ResizeObserver picks it up.
- Fix: defer first fit to a microtask or use `requestAnimationFrame`.

### P2-TERMINAL-INPUT-BEFORE-SUBSCRIBE - Local typing before history arrives is sent ahead of replay

- Location: `app/src/renderer/features/command-room/Terminal.tsx:90-98`
- Evidence: `term.onData` is wired before the snapshot is written. Typing during the (small) window between mount and `subscribe` resolution sends bytes to the PTY but the user sees their characters replayed *before* the historical buffer; ordering looks fine in practice because the snapshot is usually empty for a freshly-launched session, but for a returning Terminal mount it can produce confusing scrollback.
- Fix: queue input until `disposed===false && history written`.

### P2-RESIZE-DEBOUNCE - Resize fires on every observer tick

- Location: `app/src/renderer/features/command-room/Terminal.tsx:101-110`
- Evidence: every observer tick calls `fit.fit()` and then `rpc.pty.resize`. Dragging the window edge produces dozens of IPC calls per second.
- Fix: debounce by ~50ms or only resize when `cols`/`rows` actually change.

### P2-RPC-CACHE-MEMORY - Per-namespace Proxy cache never released

- Location: `app/src/renderer/lib/rpc.ts:29-46`; `app/src/shared/rpc.ts:29-44`
- Evidence: `cache: Map<string, unknown>` lives forever per renderer module; tiny but worth noting.

### P2-LOGGER-ABSENT - No structured logging in main process

- Location: `app/src/main/**/*.ts`
- Evidence: `console.log` is used nowhere outside `state.tsx:96`. PTY spawn failures, DB errors, worktree errors are silently swallowed.
- Fix: add a tiny `log.ts` and route catches through it, including timestamps and session ids.

### P2-RPC-ERROR-STACK-LOST - Errors lose stack trace across IPC

- Location: `app/src/main/rpc-router.ts:172-180`
- Evidence:
  ```ts
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: message };
  ```
  Only the message is forwarded. Renderer-side `Error` has no stack. Hard to debug in production.
- Fix: include `stack` in dev builds.

### P2-PROBE-VERSION-REGEX - `(\d+\.\d+(?:\.\d+)*(?:[\w.+-]*)?)` matches inside dates

- Location: `app/src/main/core/providers/probe.ts:7`
- Evidence: a CLI banner like `Released 2025.11.01` would match `2025.11.01` as a version. Cosmetic.

### P2-WORKTREE-SANITIZER-LOSES-DOTS - dotted paths collapse

- Location: `app/src/main/core/git/git-ops.ts:27-33`
- Evidence: `replace(/^[-./]+|[-./]+$/g, '')` strips leading/trailing dots; OK for branches, but the same function is reused as a *directory* segment in `pathForBranch`. A hint like `.tmp` becomes empty, then `'agent-session'`. Multiple panes with hint `.tmp` collide.

### P2-LAUNCH-IGNORES-WORKSPACE-ROW-MISSING - Error wording shows path

- Location: `app/src/main/core/workspaces/launcher.ts:38-43`
- Evidence: `throw new Error('Workspace not opened: ' + plan.workspaceRoot)`. UX-only: surface this in the launcher form, currently shown only via `setError(message)` which does succeed but the message is technical.

### P2-COMMAND-ROOM-EMPTY-STATE-BUG - Empty grid renders Empty after kill

- Location: `app/src/renderer/features/command-room/CommandRoom.tsx:42-48`
- Evidence: `if (sessions.length === 0)` short-circuits to RoomEmpty. After all sessions exit, the user is stuck on "No agents launched yet" and there's no way back to Workspaces other than the sidebar. This is fine, but the message "head back to Workspaces" is the only clue; the sidebar Workspaces tile is enabled so it works, but there is no in-room CTA.

### P2-FOCUS-MGMT - No keyboard shortcut to switch panes

- Location: `app/src/renderer/features/command-room/CommandRoom.tsx`
- Evidence: focus is mouse-only. No `Ctrl+1..9` to jump panes, no Tab navigation between terminals.
- Fix: add keyboard handlers.

### P2-A11Y-MISSING-LABELS - Several buttons lack accessible labels

- Location: `app/src/renderer/features/workspace-launcher/Launcher.tsx:166-173` (Trash2 icon button); `app/src/renderer/features/sidebar/Sidebar.tsx:51-71` (active item lacks `aria-current`).
- Evidence: only the close icon has `aria-label="Forget workspace"`. Layout buttons (Mosaic/Columns/Focus) are bare buttons.
- Fix: add `aria-label`/`aria-pressed` per button.

### P2-EVENT-PAYLOAD-CASTING - Renderer casts unknown payloads with `as`

- Location: `app/src/renderer/app/state.tsx:107-112`; `app/src/renderer/features/command-room/Terminal.tsx:76-86`
- Evidence: `(raw as { sessionId: string; exitCode: number })` with no runtime check. A misnamed payload from main would crash silently.
- Fix: zod-validate or at minimum guard `typeof p === 'object' && p !== null && 'sessionId' in p`.

### P2-NPM-DEPS-UNUSED - Many shadcn-ui dep packages installed but not imported

- Location: `app/package.json:31-55` (Radix packages)
- Evidence: only `Button`, `Card` are imported in renderer (Phase 1). The rest balloon `node_modules` and the asar.
- Fix: prune for Phase 1 ship; reintroduce as Phase 2-4 features land.

---

## P3 — Future / Hygiene

### P3-NO-TESTS - No unit tests at all

- Location: repo-wide
- Evidence: no `*.test.ts`, no `vitest.config`, `package.json` has no test script. Ring-buffer, branch sanitiser, tokeniser, workspace factory all have pure logic that should be covered.
- Fix: add `vitest`, start with the pure helpers.

### P3-LEGACY-TREE-STILL-PRESENT - `src/_legacy` shipped in vite root

- Location: `app/src/_legacy/**`
- Evidence: nothing imports it but it is included in tsc/vite globs. Slows builds.
- Fix: remove or move outside `src/`.

### P3-PRELOAD-INTERFACE-DRIFT - `electron.d.ts` imports preload from a relative path that won't survive a bundle move

- Location: `app/src/types/electron.d.ts:1-3`
- Evidence: `import type { SigmaPreloadApi } from '../../electron/preload';`. Works during dev; if `electron/` is moved, the alias breaks.

### P3-NATIVE-DEPS-REBUILD - electron-builder install-app-deps not exercised in docs

- Location: `package.json:22` (`postinstall`)
- Evidence: `electron-builder install-app-deps` does the right thing at install time but is not idempotent across electron version bumps. The team should document `npx electron-rebuild` as a fallback for `better-sqlite3` and `node-pty`.

### P3-WIN-IA32-SUPPORT - electron-builder targets ia32 but better-sqlite3 binaries may not exist

- Location: `app/electron-builder.yml:24`; `app/package.json:151-156`
- Evidence: `arch: [x64, ia32]` is configured. better-sqlite3 prebuilt binaries for ia32 Electron are not always available on every release; an ia32 NSIS will fail at runtime.
- Fix: drop ia32 or test the matrix and pin better-sqlite3 to a version that publishes ia32-electron binaries.

### P3-EVENT-PAYLOAD-NULL-FROM-MAIN - main events fan out without per-window subscription bookkeeping

- Location: `app/src/main/rpc-router.ts:20-24`
- Evidence: every webContents receives every event. With multiple windows this becomes O(windows*sessions).

### P3-GIT-DIFF-MAX-BUFFER - 16 MiB cap silently truncates large diffs

- Location: `app/src/main/core/git/git-ops.ts:99-101`
- Evidence: stdout over 16 MiB stops being collected. UI sees a clean truncated diff with no warning.

### P3-PROBE-CONCURRENCY - probeAll fires `where` for every provider in parallel

- Location: `app/src/main/core/providers/probe.ts:41-43`
- Evidence: 9 detectable providers x N altCommands x `where` -> Windows spawns ~9-15 cmd processes at startup. Fine on modern hardware but a small startup hitch.

### P3-RPC-NAMING-COLLISION - Renderer cache keyed by namespace string only

- Location: `app/src/shared/rpc.ts:29-44`; `app/src/renderer/lib/rpc.ts:29-46`
- Evidence: a misuse like `rpc['constructor']()` would attempt to invoke channel `constructor.<key>`. Defensive only.

### P3-GIT-OPS-PATH-SEP - Worktree pool uses `path.join` which is fine

- Location: `app/src/main/core/git/worktree.ts:18-25`
- Evidence: looks correct - the only potential issue is `branch.split('/')` which is fine because git branch names use `/` regardless of OS. No bug.

---

## Notes by Category

**Windows-specific (P0/P1 group):** PTY spawn (P0), probe exec (P1), runShellLine exec (P1), ia32 binaries (P3), CRLF in xterm: `convertEol: true` already set (`Terminal.tsx:60`), so line-ending is handled.

**Race conditions (P1/P2 group):** PTY-FAILURE-NOT-DETECTED, IPC-EVENT-RACE-CROSSWINDOW, TERMINAL-FIT-DURING-OPEN, TERMINAL-INPUT-BEFORE-SUBSCRIBE, INITIAL-PROMPT-DOUBLE.

**Memory leaks:** PTY-REGISTRY-LEAK (P1), DB-NEVER-CLOSED (P1), RING-BUFFER-CHAR-LIMIT (P2), RPC-CACHE-MEMORY (P2).

**Type/runtime mismatches:** EVENT-PAYLOAD-CASTING (P2), RPC-ERROR-STACK-LOST (P2).

**DB lifecycle:** DB-EXIT-DUPLICATE-LISTENER (P1), DB-NEVER-CLOSED (P1), DRIZZLE-DEFAULT-OVERRIDE (P1), `factory.ts:24-57` correctly handles re-open via `existing` lookup so opening the same workspace twice updates `lastOpenedAt` and is idempotent.

**Worktree leaks:** WORKTREE-LEAK (P1), WORKTREE-PATH-COLLISION (P1), WORKTREE-SANITIZER-LOSES-DOTS (P2).

**UI bugs:** NO-CLOSE-PANE (P1), COMMAND-ROOM-EMPTY-STATE-BUG (P2), FOCUS-MGMT (P2), A11Y-MISSING-LABELS (P2).

**Build/packaging:** electron-builder is configured for `better-sqlite3`/`node-pty` rebuild via `postinstall: electron-builder install-app-deps`. The `extraResources` block duplicates `dist` into `extraResources/dist` (`electron-builder.yml:11-13`) which is redundant because `dist/**/*` is already in `files`. Not a bug, just bloat.

**Security:** PRELOAD-NO-CHANNEL-ALLOWLIST (P1), context isolation is on, sandbox is off (`electron/main.ts:29`) which is necessary for the preload to use `webUtils` but widens the renderer's privilege should it be compromised.
