# SigmaLink Codebase Audit Report

**Generated:** 2026-05-12  
**Scope:** Full codebase (`src/`, `electron/`, `native/`, `scripts/`, config)  
**Lines Analyzed:** ~56,628 TypeScript / TSX  
**Method:** Ruflo agent swarm — 5 parallel specialized agents (App Core, Features, Electron/Main, Build/Config, Shared/Remaining)  
**Constraint:** Investigation & documentation only. No edits applied.

---

## Executive Summary

| Category | Count | Critical | Warning | Suggestion |
|----------|-------|----------|---------|------------|
| Bugs | 38 | 4 | 22 | 12 |
| Dead Code | 23 | 0 | 6 | 17 |
| Optimizations | 35 | 0 | 16 | 19 |
| Better Logic | 33 | 1 | 8 | 24 |
| **Total** | **129** | **5** | **52** | **72** |

> **Top 5 Immediate Concerns**
> 1. **Native module crash risk** — `voice-mac` disables C++ exceptions but `node-addon-api` throws on `ThreadSafeFunction` failures.
> 2. **State desync** — `useWorkspaceMirror` silently swallows async errors, leaving renderer state permanently out of sync with main.
> 3. **Timer leak** — `useExitedSessionGc` fires timers after component unmount, dispatching into torn-down providers.
> 4. **Orphaned voice recognizer** — `MissionStep` voice-capture cleanup closes over initial `null` handle; recognizer keeps running after unmount.
> 5. **No CI/CD** — No `.github/workflows`; releases are fully manual with zero automated testing gating.

---

## 1. Critical Issues

### C1. Native Voice Module — `std::terminate()` Risk
- **File:** `native/voice-mac/binding.gyp:9`
- **Issue:** `NAPI_DISABLE_CPP_EXCEPTIONS` and `GCC_ENABLE_CPP_EXCEPTIONS: "NO"` are both defined, yet `node-addon-api` `ThreadSafeFunction::New` (used in `tsfn_bridge.mm` and `sigmavoice_mac.mm`) can throw C++ exceptions on failure. With exceptions disabled, this triggers `std::terminate()` and crashes the host process.
- **Suggested Fix:** Remove exception-disabling flags and add proper `try/catch` wrappers around N-API calls, or switch to `node-addon-api` exception-free APIs if available.

### C2. State Desync on Async Error
- **File:** `src/renderer/app/state-hooks/use-workspace-mirror.ts:35-44`
- **Function:** `useWorkspaceMirror` (listener callback)
- **Issue:** If `rpc.workspaces.list()` throws inside the async callback, the function returns early **without dispatching** `SYNC_OPEN_WORKSPACES`. Main already changed open workspaces, so renderer state becomes permanently out of sync.
- **Suggested Fix:** Wrap the RPC call in `try/catch` and dispatch a fallback/empty list or retry logic in the catch block.

### C3. Timer Leak on Unmount
- **File:** `src/renderer/app/state-hooks/use-exited-session-gc.ts:22-40`
- **Function:** `useExitedSessionGc`
- **Issue:** First effect does **not return a cleanup function**, so if component unmounts while a timer callback is queued, the timer still fires and dispatches into a torn-down provider. Second effect only clears on unmount, not between re-runs.
- **Suggested Fix:** Return cleanup functions from both effects that clear pending timers.

### C4. Orphaned Voice Recognizer on Unmount
- **File:** `src/renderer/features/swarm-room/MissionStep.tsx:224-229`
- **Function:** `MissionStep` (voice-capture cleanup)
- **Issue:** Cleanup effect has an empty dependency array. The cleanup function closes over the initial `voiceHandle` value (`null`). If the user starts capture and the component unmounts, `null?.stop()` is a no-op — the Web Speech recognizer keeps running and the `VoiceCaptureHandle` is orphaned.
- **Suggested Fix:** Include `voiceHandle` in the effect dependency array so the cleanup always references the current handle.

### C5. No CI/CD Pipeline
- **File:** `.github/workflows/` (missing)
- **Issue:** There is no `.github` directory and no CI/CD workflows. There is no automated testing, linting, building, or releasing. Every release is manual, increasing risk of shipping broken builds.
- **Suggested Fix:** Add GitHub Actions workflows for test, lint, typecheck, build, and release.

---

## 2. Bugs

### `src/renderer/app/state-hooks/use-session-restore.ts`
- **Line 124-130** — `useSessionRestore` snapshot effect saves the **current global room** for **all** open workspaces, losing per-workspace room state. If user has workspace A in "command" and workspace B in "swarm", restore forces both into the same room. *(Warning)*

### `src/renderer/app/state.reducer.ts`
- **Line 102-117** — `SET_ACTIVE_WORKSPACE_ID`: If `action.workspaceId` is provided but not found in `openWorkspaces`, returns `state` unchanged — silently ignoring invalid IDs without feedback or fallback. *(Suggestion)*
- **Line 176-188** — `REMOVE_SESSION`: When active session is removed, fallback `activeSessionId` selects `sessions[0]?.id` without filtering for live/non-error sessions. An exited/error session can become active. *(Warning)*
- **Line 199-208** — `UPSERT_SWARM`: Auto-sets `activeSwarmId` to the upserted swarm if `state.activeSwarmId` is null, overriding intentional user deselection. *(Warning)*

### `src/shared/rpc-channels.ts`
- **Line 188** — `CHANNELS` allowlist contains `'voice.diagnostics.run'` which does **not exist** in `AppRouter`. If called, preload allows it but main will fail with unregistered handler. *(Warning)*

### `src/renderer/app/state-hooks/use-live-events.ts`
- **Line 89-101** — `useLiveEvents`: Review refresh depends on `state.sessions.length`, causing `runRefreshOnEvent` to teardown/setup + immediate RPC fetch on **every** session add/remove. Rapid session churn will spam `rpc.review.list`. *(Warning)*

### `src/renderer/app/state-hooks/parsers.ts`
- **Line 120** — `parseSwarmMessage`: `kind` field is cast via `as SwarmMessage['kind']` without runtime validation. Invalid/malicious `kind` strings enter state unchecked. *(Warning)*

### `src/renderer/app/state.tsx`
- **Line 41-43** — `AppStateProvider`: `useLayoutEffect` syncs `appStateStore` after React commits, but `useSyncExternalStore` (`useAppStateSelector`) reads during render. Causes **double renders** for every state change in components using `useAppStateSelector`. *(Warning)*
- **Line 62-84** — Test-only `sigma:test:activate-workspace` listener adds event listener overhead unconditionally in production. *(Suggestion — dead-code-adjacent)*

### `src/renderer/app/App.tsx`
- **Line 91-142** — `RoomSwitch`: `let body: ReactElement | null;` is declared but `default` case returns `null` directly without assigning to `body`. Inconsistent control flow. *(Suggestion)*

### `src/renderer/features/swarm-room/RoleRoster.tsx`
- **Line ~116** — `useCanDo('swarm.maxSize')` may return `undefined`; `Math.min(CUSTOM_ROSTER_CAP, undefined)` → `NaN`, disabling the roster cap entirely. *(Warning)*

### `src/renderer/features/bridge-agent/Composer.tsx`
- **Line ~40** — Comment says gate key is `bridgevoice.enabled` but code uses `'sigmavoice.enabled'`. Mismatch between documentation and implementation. *(Warning)*

### `src/renderer/features/settings/VoiceTab.tsx`
- **Line ~77** — `wireModeToUi` maps wire value `'web-speech'` to UI mode `'on'`, contradicting the "Auto (recommended)" option. Radio button may jump to "On" unexpectedly. *(Warning)*

### `src/renderer/features/memory/MemoryRoom.tsx`
- **Line ~68** — Graph refresh `useEffect` depends on `memories` array. Every note edit creates a new array reference, triggering expensive `getGraph` RPC on every keystroke. *(Warning)*

### `src/renderer/features/swarm-room/SwarmRoom.tsx`
- **Line ~45** — Tail `useEffect` depends on entire `swarmMessages` object. Any message in any swarm re-runs the effect. *(Warning)*

### `src/renderer/features/bridge-agent/BridgeRoom.tsx`
- **Line ~365** — `assistant:dispatch-echo` listener effect depends on `state.workspaces` array reference. Any workspace mutation tears down and recreates the listener, risking missed events during the gap. *(Warning)*

### `src/renderer/features/tasks/TaskDetailDrawer.tsx`
- **Line ~68** — `useEffect` depends only on `taskId` but accesses `props.task` inside. If parent passes a new object with same id but mutated fields, drawer won't refresh. *(Warning)*

### `src/renderer/features/editor/EditorTab.tsx`
- **Line ~81** — `useEffect` for `EDITOR_FOCUS_EVENT` depends on `[editor]`. `useEditor()` returns a new object reference on every render. Listener removed and re-added on **every render**. *(Warning)*

### `src/renderer/features/editor/useEditor.ts`
- **Line ~85** — Return object `{ file, buffer, setBuffer, dirty, loading, error, open, save }` is constructed fresh on every call. Breaks memoization in all consumers. *(Warning)*

### `src/renderer/features/review/NotesTab.tsx`
- **Line ~18** — `useEffect` syncs `value` from `session.notes` whenever `session.notes` changes. If notes are updated externally while user is typing, local edits are overwritten and lost. *(Warning)*

### `src/renderer/features/browser/DesignOverlay.tsx`
- **Line ~45** — `useEffect` depends on `[workspaceId, tabId, onActiveChange]`. `onActiveChange` is a prop function; if parent doesn't memoize it, effect rebinds on every render. *(Warning)*

### `src/renderer/features/operator-console/Constellation.tsx`
- **Line 226-240** — RAF `useEffect` depends on `[agents, edges, filter]`, but `step` / `draw` are `useCallback`s that also close over `hoverId`. When `hoverId` changes (mouse moves), the effect does **not** re-run, so hover highlights and status halos never update until an agent/edge change forces a re-mount. *(Warning)*

### `src/renderer/features/memory/MemoryGraph.tsx`
- **Line 104-119** — Same stale-closure bug as Constellation. Animation loop only lists `[graph]` in deps, but `draw` depends on `hoverId`. Node hover highlighting is broken. *(Warning)*

### `src/renderer/features/operator-console/ReplayScrubber.tsx`
- **Line 87-110** — Effect that resets frame/bookmarks on `activeSwarmId` change omits `onFrameChange` from its dependency array. Scrubber continues to invoke stale callback. *(Warning)*
- **Line 150-151** — `onKeyDown` (ArrowRight): `Math.min(frame.totalFrames, frame.frameIdx + 1)` allows scrubbing to index `totalFrames`, which is out of bounds (valid indices are `0..totalFrames-1`). The slider `max` is also set to `totalFrames`, compounding the off-by-one. *(Warning)*

### `src/renderer/features/memory/MemoryEditor.tsx`
- **Line 41-52** — Hydration effect only watches `memory?.id`. If the memory body/tags are updated externally while the same note is selected, the local state stays stale. *(Warning)*

### `src/renderer/features/browser/BrowserRoom.tsx`
- **Line 63-95** — Hydration effect depends on `[ws, dispatch]`. `ws` is the entire `activeWorkspace` object, which the reducer spreads into a new object on **every** action. Causes effect teardown/recreation on every global state change. *(Warning)*

### `electron/main.ts`
- **Line 216** — `showDiagnosticWindow`: Creates a `BrowserWindow` but never attaches a `'closed'` listener to null out the reference. V8 wrapper and native resources may linger until GC. *(Warning)*
- **Line 365** — `app.on('activate', ...)` is registered *inside* the `whenReady` callback. On macOS, `activate` can fire **before** `ready`. Handler is missed and no window is created. *(Warning)*
- **Line 242** — `sandbox: false` in `webPreferences`. While `contextIsolation: true` and `nodeIntegration: false` mitigate risks, disabling the sandbox exposes a larger attack surface. *(Warning)*
- **Line 339** — `app:session-snapshot` handler is registered in `main.ts` rather than inside `rpc-router.ts`, splitting IPC registration across two files. *(Suggestion — better-logic)*

### `native/voice-mac/src/sigmavoice_mac.mm`
- **Line 100** — `BindCallback`: The unsubscribe function returned to JS is a no-op. It does **not** rebind a no-op to the native emitter, so the `Napi::ThreadSafeFunction` and the captured JS callback are never released. Leaks native TSFN resources. *(Warning)*

### `native/voice-mac/src/recognizer.mm`
- **Line 42** — `g_impl()`: `static SVRecognizerImpl* impl` is a raw pointer in an ARC compilation unit. `[[SVRecognizerImpl alloc] init]` returns a +1 retain count, but a raw `static` pointer is not `__strong`, so ARC may autorelease the object. Lifetime is undefined and could become a dangling pointer. *(Warning)*

### `native/voice-mac/src/tsfn_bridge.mm`
- **Line 17** — `StringEmitter::Bind`: `max_queue_size: 0` means **unlimited** queue. The comment claims "dropping a stale partial is cheaper than stalling," but an unlimited queue will **never drop** — it will grow unbounded if the JS thread is slow. *(Warning)*

### `native/voice-mac/index.js`
- **Line 58** — Only validates `typeof native.start === 'function'`. If other exported methods (e.g., `onPartial`, `stop`) are missing due to a partial build, the module is accepted and will crash at runtime when those methods are called. *(Warning)*

### `scripts/ruflo-mcp-filter.mjs`
- **Line 4** — Hardcodes `/opt/homebrew/bin/ruflo`. This path is only valid for Apple Silicon Homebrew. Will fail on Intel Macs (`/usr/local/bin/ruflo`), Linux, or any custom prefix. *(Warning)*
- **Line 32** — On child exit, any remaining `stdoutBuffer` that contains a JSON-RPC message but does **not** start exactly with `{"jsonrpc"` (e.g., leading whitespace) is silently discarded instead of flushed. *(Warning)*
- **Missing** — No `child.on('error', ...)` handler. If `ruflo` is not found, the unhandled `error` event will crash the filter process. *(Warning)*

### `scripts/install-macos.sh`
- **Line 165** — If `xattr -cr` fails (and the sudo fallback also fails), the error is swallowed (`|| true`). The installed `.app` may retain `com.apple.quarantine` attributes and Gatekeeper will block launch. *(Warning)*
- **Line 47** — The installer rejects Intel Macs (`x64`), but `electron-builder.yml` (line 74) explicitly builds an `x64` DMG target. The build matrix and installer gate are inconsistent. *(Warning)*

### `src/main/core/browser/manager.ts`
- **Line 96, 121, 408** — `hydrateFromDb`, `openTab`, `detachView`: `view: null as unknown as TWebContentsView` papers over nullability. If `ensureView` throws or is skipped, downstream code may dereference a null `WebContentsView` without TypeScript catching it. *(Warning)*
- **Line 402** — `detachView`: Attempts `wc.close()` on a `WebContents`, which is not a standard method. It then falls back to `wc.destroy()`, which is deprecated. Modern Electron recommends letting the view be GC'd after `removeChildView`. *(Suggestion)*

### `electron/auto-update.ts`
- **Missing** — No `autoUpdater.on('error', ...)` handler registered. `electron-updater` can emit unhandled `error` events (network failure, bad feed URL) that will crash the main process. *(Warning)*

### `src/main/rpc-router.ts`
- **Line 819** — `ipcMain.handle` wrapper: `event.senderFrame` / `event.sender` is never validated. If the app ever introduces a `<webview>` or `BrowserView`, those contexts could invoke privileged main-process channels through the same preload bridge. *(Warning)*
- **Line 734** — `voiceCtl.dispatcher.controllers`: `swarmCreate` is commented as "left unwired in v1.1" and points to a non-existent implementation. *(Suggestion — dead-code)*

### `src/main/lib/exec.ts`
- **Line 48-57** — `execCmd`: When `bytes > maxBuffer`, chunks are silently dropped but the child process is **not** killed. Caller receives a partial result with `timedOut: false`, making truncation undetectable. *(Warning)*

### `src/main/core/session/session-restore.ts`
- **Line 25-43** — `SessionSnapshotSchema` uses `z.string().optional()` for `workspaceId` / `room`, but the renderer-side parser (`parsers.ts`) treats them as nullable strings. Mixing `optional` and `nullable` across the snapshot→parser boundary is inconsistent under strict null checks. *(Suggestion)*

### `src/main/core/pty/local-pty.ts`
- **Line 207-235** — `spawnLocalPty` (catch path): On spawn failure, a synthetic `PtyHandle` with `pid: -1` is returned. Downstream consumers cannot distinguish "spawn failed" from "process exited with -1". *(Suggestion)*

### `components.json`
- **Line ~7** — `tailwind.config` key points to `postcss.config.js` instead of `tailwind.config.js`. Future `npx shadcn add` commands may fail or write to incorrect locations. *(Warning)*

### `electron-builder.yml`
- **Line ~30-32** — `extraResources` copies `dist` to `dist`, but `files` already includes `dist/**/*`. Bloats the final package with a redundant copy of the renderer bundle. *(Warning)*

### `package.json`
- **Line ~24** — `postinstall` runs `electron-builder install-app-deps`, but `electron-builder` is listed under `devDependencies`. If `npm install --production` is ever run, the hook will crash. *(Warning)*

### `vite.config.ts`
- **Line ~21-38** — Missing `build.sourcemap` option. Vite defaults to `false` for production, so the renderer bundle ships with zero source maps. Debugging production crashes is extremely difficult. *(Warning)*

### `tsconfig.app.json` / `tsconfig.node.json`
- **`electron/main.ts`** is not included in any `tsconfig.json` `include` array. It is bundled by esbuild but never type-checked by `tsc -b`. Type errors in the main-process bootstrap will only surface at esbuild time or runtime. *(Warning)*

### `eslint.config.js`
- **Line ~11** — `files` glob is `**/*.{ts,tsx}`. Excludes `.js`, `.cjs`, and `.mjs` files in `scripts/`, `electron/`, and the project root. Build scripts and the preload bridge receive zero lint coverage. *(Warning)*

---

## 3. Dead Code

### `src/types/index.ts`
- **Line 1-83** — Entire file appears **unimported** across the codebase. Contains `Room`, `AgentProvider`, `TerminalSession`, `SubTask`, `OrchestratorTask`, `VerificationResult`, `AgentMessage`, `WorktreeInfo`, `ThemeMode` — all superseded by `src/shared/types.ts` and `src/shared/providers.ts`. *(Warning)*

### `src/renderer/app/state.test.ts`
- **Line 3-5** — `vi.mock('../lib/rpc', ...)` is unnecessary — the reducer tests are pure and never touch RPC. *(Suggestion)*

### `src/renderer/app/state-hooks/parsers.ts`
- **Line 43** — `VALID_ROOMS` set duplicates the `RoomId` union defined in `state.types.ts`. Changes to `RoomId` require manual sync here. *(Suggestion)*

### `src/main/lib/exec.ts`
- **Line 73-77** — `resolveCommand`: Exported function that simply returns its input unchanged. Never imported anywhere. Superseded by `resolveWindowsCommand` in `local-pty.ts`. *(Suggestion)*

### `src/renderer/lib/shortcuts.ts`
- **Line 44-51** — `matches` (export): Exported but never imported outside the module. Only `bindShortcut` (which uses it internally) is consumed. *(Suggestion)*

### `src/main/core/memory/manager.ts`
- **Line 369-371** — `outgoingLinks`: Exported wrapper around `uniqueLinkTargets`. Never imported by any other module. *(Suggestion)*

### `src/main/core/memory/db.ts`
- **Line 279** — `restoreDeletedMemory` parameter `workspaceId` is immediately voided (`void workspaceId;`). Unnecessary. *(Suggestion)*

### `electron/main.ts`
- **Line 157** — `escapeHtml`: The `default` case in the switch statement is unreachable because the regex `/[&<>"']/g` only ever matches those 5 characters. *(Suggestion)*
- **Line 178** — `buildDiagnosticHtml`: `rebuildCmd` uses a ternary with identical branches for `win32` and else. One branch is redundant. *(Suggestion)*

### `scripts/rename-preload.cjs`
- **Entire file** — The script renames `preload.js` → `preload.cjs`, but `scripts/build-electron.cjs` already writes `preload.cjs` directly. Never referenced in `package.json` scripts. *(Suggestion)*

### `scripts/install-macos.sh`
- **Line 148** — `SUDO_USED=1` is set but never read anywhere in the script. *(Suggestion)*

### `package.json`
- **`tw-animate-css`** — Unused devDependency. The project uses `tailwindcss-animate` (in `tailwind.config.js`) instead. *(Suggestion)*
- **`react-arborist`** — Listed in `dependencies` but has zero imports anywhere in `src/`, `tests/`, or `scripts/`. *(Warning)*
- **`date-fns`** — In `dependencies` but never imported. `react-day-picker` v9 no longer requires it. *(Warning)*
- **`@hookform/resolvers`** — Installed but never imported. `react-hook-form` is used directly without resolver integration. *(Warning)*
- **`@electron/rebuild`** — Redundant with `electron-builder`. The `postinstall` script already runs `electron-builder install-app-deps`. *(Suggestion)*
- **`preview` script** — `"preview": "vite preview"` starts a static web server for the production renderer build. For an Electron app, this is not useful. *(Suggestion)*

### `src/main/rpc-router.ts`
- **Line 734** — `voiceCtl.dispatcher.controllers`: `swarmCreate` is commented as "left unwired in v1.1." *(Suggestion)*

### `src/renderer/features/workspace-launcher/Launcher.tsx`
- **BottomActionRow** — "New terminal" and "Split right" buttons have `onClick={() => undefined}` stubs. *(Suggestion)*

### `src/renderer/features/workspace-launcher/AgentsStep.tsx`
- Both "Enable all" and "Split evenly" buttons call the same `fillEvenly()` function. One is redundant. *(Suggestion)*

### `src/renderer/features/command-room/PaneHeader.tsx` & `PaneSplash.tsx`
- Hardcoded `DEFAULT_MODELS` / `DEFAULT_MODEL_LABEL` mirror main-process registry. Risk of drift. *(Suggestion)*

### `src/renderer/features/swarm-room/RoleRoster.tsx`
- Model `<select>` only renders a single `<option>` equal to the current value; user cannot actually change models through the UI. *(Suggestion)*

---

## 4. Optimization Opportunities

### `src/renderer/app/App.tsx`
- **Line 155-170** — `MainBody` calls `useAppState()` (full state subscription) but only needs `state.room`. Should use `useAppStateSelector(s => s.room)` to avoid re-rendering on unrelated state changes. *(Suggestion)*
- **Line 91-142** — `RoomSwitch` calls `useAppState()` (full state) but only needs `state.room`. Should use `useAppStateSelector(s => s.room)`. *(Suggestion)*

### `src/renderer/app/state.tsx`
- **Line 91** — `AppStateProvider` re-renders on every state change, causing **entire app tree** below it to re-render. Shell components should be wrapped in `React.memo` to benefit from `useAppStateSelector` in descendants. *(Warning)*

### `src/renderer/app/state.reducer.ts`
- **Line 36-42, 44-50** — `groupSessionsByWorkspace`, `groupSwarmsByWorkspace` recompute grouping maps from scratch on every action. For large arrays this is O(n) per action. *(Suggestion)*
- **Line 150-161** — `ADD_SESSIONS`: `sessionsByWorkspace` is rebuilt from scratch via `groupSessionsByWorkspace(sessions)` even if only one session was added/updated. Same for swarms. *(Suggestion)*

### `src/renderer/app/state-hooks/use-live-events.ts`
- **Line 56-68, 72-84, 89-101, 104-116** — Multiple `runRefreshOnEvent` calls fire **simultaneous RPC requests** on workspace switch (skills, memory, review, tasks, swarms). Could batch or stagger initial fetches to reduce IPC pressure. *(Suggestion)*

### `src/renderer/app/state-hooks/use-session-restore.ts`
- **Line 114-141** — Snapshot effect fires on every `state.openWorkspaces` reference change, even though `key` check prevents timer creation. The cleanup/setup of the effect is wasteful. *(Suggestion)*

### `src/renderer/app/state.hook.ts`
- **Line 58-66** — `useAppStateSelector`: Callers must ensure `selector` is stable and returns primitive values. No documentation warns about this; inline arrow selectors will cause re-renders if they return new object references. *(Suggestion)*

### `src/renderer/app/ThemeProvider.tsx`
- **Line 56-60** — `setTheme` is not wrapped in `useCallback`. If passed to memoized children via context, it triggers re-renders. *(Suggestion)*

### `src/renderer/features/sidebar/WorkspacesPanel.tsx`
- `pickerMenu` JSX is rebuilt on every render. Memoize with `useMemo` or extract to a sub-component. *(Suggestion)*

### `src/renderer/features/memory/MemoryEditor.tsx`
- `saveNow` callback is recreated on every body/tag change, causing auto-save `useEffect` to clear/restart timeout on every keystroke. Stabilize with `useCallback` and a ref for latest values, or use a debounce hook. *(Suggestion)*

### `src/renderer/features/operator-console/Constellation.tsx`
- O(n²) repulsion physics in RAF loop. Cap iterations or implement spatial indexing (Barnes-Hut) for swarms >50 agents. *(Warning)*
- Canvas does not check `document.visibilityState` to pause animation when the user is in another room. Force-directed simulation continues burning CPU/GPU while hidden. *(Suggestion)*

### `src/renderer/features/memory/MemoryGraph.tsx`
- Same O(n²) issue as Constellation for large graphs (>500 nodes). Consider web worker or spatial indexing. *(Warning)*
- Same `visibilityState` issue — animation loop runs while hidden. *(Suggestion)*

### `src/renderer/features/right-rail/RightRailTabs.tsx`
- Mounts all three tab bodies simultaneously; inactive tabs hidden via CSS. `BrowserRoom` stays alive and holds a `WebContentsView` even when hidden. Verify memory impact. *(Warning)*

### `src/renderer/features/command-room/CommandRoom.tsx`
- `PaneCell` and its callbacks are not memoized; recreated every render. Wrap `PaneCell` in `React.memo` and memoize handlers. *(Suggestion)*

### `src/renderer/features/bridge-agent/ChatTranscript.tsx`
- `ChatRow` is not wrapped in `React.memo`. Every streaming delta causes all messages to re-render. *(Warning)*

### `src/renderer/features/tasks/TasksRoom.tsx`
- `handleDragEnd` is not memoized. Recreated every render; wrap in `useCallback`. *(Suggestion)*

### `src/renderer/features/review/SessionList.tsx`
- Not wrapped in `React.memo`. Every `ReviewRoom` render re-renders the full list. *(Suggestion)*

### `src/renderer/features/operator-console/OperatorConsole.tsx`
- `visibleAgents` filter runs on every render. Memoize with `useMemo` keyed on `activeSwarm?.agents` and `filter`. *(Suggestion)*

### `src/renderer/features/command-palette/CommandPalette.tsx`
- **Line 247-450** — `items` useMemo depends on `setTheme`, which is a plain (non-memoized) function recreated on every render in `ThemeProvider`. Invalidates the cache and rebuilds the entire 30+ item command list on **every keystroke or state update**. *(Warning)*

### `src/renderer/lib/notifications.ts`
- **Line 33-69** — `playDing` creates a fresh `AudioContext` on every call. Rapid completions spawn overlapping contexts. A single lazily-initialized module-level context would be far cheaper. *(Suggestion)*

### `src/main/core/memory/index.ts`
- **Line 112-138** — `MemoryIndex.search` performs an O(n·m) linear scan over all entries for every query. No inverted index is used. A `Map<token, Set<entryId>>` would reduce this to O(m·log n). *(Suggestion)*

### `src/main/core/memory/manager.ts`
- **Line 271-278** — `requireRoot` queries the SQLite `workspaces` table on **every** memory operation. Since workspace roots are static, caching the result per `workspaceId` would eliminate redundant DB hits during batch operations. *(Suggestion)*

### `electron-builder.yml`
- **Line 29** — `asar: false` disables the entire asar archive. The DMG is ~50 MB larger and cold-start file I/O is slower. This was a v1.0.1 workaround for `better-sqlite3` packing issues; should be revisited with modern `asarUnpack` globs. *(Warning)*

### `scripts/build-electron.cjs`
- **Line ~15-20** — esbuild defaults `minify: false` for `platform: 'node'`. The resulting `main.js` is ~1.9 MB unminified. Adding `minify: true` would significantly reduce binary size. *(Warning)*

### `vite.config.ts`
- **Line ~10-40** — No `build.target` specified. Vite defaults to modern ES modules. Explicitly setting `build.target` to a Chromium version matching Electron 30 (e.g., `chrome124`) would allow slightly more aggressive transpilation. *(Suggestion)*
- **Line ~24-36** — Manual chunks strategy produces several sub-1KB chunks (`canDo`, `card`, `input`, `switch`, `tabs`). Tuning `manualChunks` to coalesce small UI primitives would reduce HTTP overhead during renderer load. *(Suggestion)*
- No `build.cssMinify` or `build.cssCodeSplit` configuration exists. For an Electron app with heavy theming (308-line `index.css`), explicit tuning could reduce stylesheet size. *(Suggestion)*

### `electron-builder.yml`
- **Line ~79-82** — Windows build targets `ia32` (32-bit x86) in addition to `x64`. 32-bit Windows is extremely rare in 2026 and building it doubles Windows CI/build time. *(Suggestion)*
- **Line ~89-95** — Linux only targets `x64`. Since macOS already builds for `arm64`, adding an `arm64` target is low-effort for ARM Linux devices. *(Suggestion)*

### `playwright.config.ts`
- **Line ~8** — `workers: 1` forces all E2E tests to run serially. For a suite of 6+ spec files, raising this would speed up local test runs significantly. *(Suggestion)*

### `vitest.config.ts`
- **Line ~27-32** — Coverage thresholds are set to 18-22%. These are so low they provide almost no regression protection. *(Suggestion)*

### `scripts/build-electron.cjs`
- **Line ~43-80** — All four esbuild calls use `buildSync`. This blocks the Node.js event loop during compilation. Switching to async `build()` would allow better resource utilization. *(Suggestion)*

### `electron/main.ts`
- **Line 280** — `ready-to-show` listener re-runs `checkNativeModules()` and sends `app:native-rebuild-needed` even though the boot-time check (line 350) already gated on the same condition. If the first check passed, this recheck is almost always redundant. *(Suggestion)*

### `src/main/rpc-router.ts`
- **Line 119** — `broadcast` iterates **all** windows for every event, even workspace-specific ones like `browser:state`. Could route events only to windows that have expressed interest. *(Suggestion)*
- **Line 713** — `resolveWorkspaceId` / `resolveSwarmId`: Identical `SELECT value FROM kv WHERE key = ?` query is duplicated twice inside `voiceCtl`. Could be a shared `kvGetString(key)` helper. *(Suggestion)*
- **Line 834** — `registerRouter` side-band `ipcMain.handle` registration is copy-pasted 4+ times. Could be collapsed into a single helper loop. *(Suggestion)*

### `electron/auto-update.ts`
- **Line 96** — `maybeCheckOnBoot`: `setTimeout` fires 3s after boot with no cleanup. If the user quits immediately, the timer still fires during teardown. *(Suggestion)*

### `src/main/core/pty/registry.ts`
- **Line 164** — `onExit` handler creates a `setTimeout` for every PTY exit to schedule `forget()`. If the app exits before the timer fires, these timers are abandoned. A centralized cleanup or shorter grace period would reduce memory pressure during rapid session churn. *(Suggestion)*

### `electron/main.ts`
- **Line 43** — `bootstrapShellPath` spawns an interactive login shell on **every** boot. The resolved PATH could be cached in `userData` and only refreshed when the app binary changes. *(Suggestion)*

---

## 5. Better Logic / Code Quality

### `src/renderer/app/state.reducer.ts`
- **Line 54-66, 70-82** — Identical logic for `openWorkspaces` reconciliation, `activeWorkspaceId` fallback, and `deriveActiveWorkspace` call is duplicated across `READY` and `SET_WORKSPACES`. Should extract to a shared helper. *(Suggestion)*
- **Line 248-253** — `SKILLS_BUSY` uses `delete next[action.key]` on a shallow copy. Could instead destructure conditionally: `const { [action.key]: _, ...rest } = state.skillsBusy` for immutability purity. *(Suggestion)*
- **Line 264-270, 307-319** — `.sort((a, b) => b.updatedAt - a.updatedAt)` is not stable — items with equal `updatedAt` may swap unpredictably. Should use a stable sort or secondary key. *(Suggestion)*

### `src/renderer/app/state-hooks/parsers.ts`
- **Line 128-163** — `parseBrowserState`: `createdAt` and `lastVisitedAt` fall back to `Date.now()`. Parsing the same raw payload at different times yields different results. Should default to `0` to ensure determinism. *(Suggestion)*
- **Line 65-71** — `parseOpenWorkspacesChanged` returns `null` if any ID is invalid, causing the entire event to be ignored. Could filter invalid IDs and process the rest. *(Suggestion)*

### `src/renderer/app/state-hooks/use-exited-session-gc.ts`
- **Line 16** — `EXITED_AUTO_REMOVE_MS` is hardcoded to `5_000ms`. Should be configurable via kv or constant exported to a config module. *(Suggestion)*

### `src/renderer/app/state-hooks/use-workspace-mirror.ts`
- **Line 55-56** — `key = workspaceIds.join('\0')` uses null byte delimiter. Safer to use `JSON.stringify` or a more explicit serialization. *(Suggestion)*

### `src/renderer/app/state.types.ts`
- **Line 53** — `activeSessionId` is global, not per-workspace. Switching workspaces can leave an active session from a different workspace selected, confusing the UI. *(Suggestion)*
- **Line 71** — `activeReviewSessionId` is global, not per-workspace. Same cross-workspace confusion risk. *(Suggestion)*

### `src/shared/providers.ts`
- **Line 46-165** — `AGENT_PROVIDERS` registry is a mutable array exported directly. Callers could accidentally mutate it. Should use `Object.freeze` or `as const`. *(Suggestion)*

### `electron/auto-update.ts`
- **Line 49** — `configureUpdater`: `autoUpdater.logger = console` logs to stdout, which in a packaged macOS app is invisible to the user and often not captured. A file-based logger would make update diagnostics accessible. *(Suggestion)*

### `scripts/adhoc-sign.cjs`
- **Line 31** — `adhocSign` is exported as `async` but only uses `execFileSync` (synchronous) operations. The `async` wrapper is unnecessary. *(Suggestion)*

### `src/main/core/workspaces/lifecycle.ts`
- **Line 34** — `broadcast` duplicates the `broadcast` helper from `rpc-router.ts` almost verbatim. A shared utility would keep both in sync. *(Suggestion)*

### `electron/preload.ts`
- **Line 17** — `eventOn`: When an event is disallowed, returns a noop `() => undefined`. Renderer code may still call this "unsubscribe" in cleanup effects, believing it removed a listener. Could cause confusion in memory-leak audits. *(Suggestion)*

### `src/renderer/lib/canDo.ts`
- **Line 25-35** — The renderer imports `@/main/core/plan/capabilities`. The file is pure data *today*, but living in `main/` creates a dangerous boundary violation — a future refactor could add a Node-only helper and silently break the renderer bundle. Move the matrix to `shared/` or `renderer/lib/`. *(Warning)*

### `src/renderer/app/App.tsx`
- **Line 141** — Comment claims the `Suspense` boundary is "keyed by room id", but no `key` prop is actually passed to `<Suspense>`. *(Suggestion)*

### `src/renderer/features/onboarding/OnboardingModal.tsx`
- **Line 116** — `onOpenChange={(o) => (!o && state.onboarded ? undefined : undefined)}` evaluates to `undefined` in both branches — a no-op ternary. Remove it or replace with an explicit comment. *(Suggestion)*

### `src/renderer/features/workspace-launcher/grid.ts`
- **Line 7-26** — `PRESETS` stops at `12`, but `GRID_DIMS` defines layouts for `14`, `16`, `18`, `20`. The `GridPreset` type includes all values, yet the UI offers no way to select the larger presets. *(Suggestion)*

### `package.json`
- **Missing** — No `engines` field specifies minimum Node.js version. No `packageManager` field records the pnpm version. *(Suggestion)*
- **`electron:dev`** — Runs `npm run build` (full production Vite build) then launches Electron. Every code change requires a full rebuild. A proper dev script should use `vite dev` with HMR. *(Warning)*
- **Missing common utility scripts** — No `clean`, `typecheck`, or `format` scripts. *(Suggestion)*
- **`electron:pack:all`** — Only builds `--win --mac`. If Linux is supported, should include `--linux` or be renamed. *(Suggestion)*

### `eslint.config.js`
- **Line ~19** — `ecmaVersion: 2020` is specified. The project uses TypeScript 5.9 and targets ES2022/ES2023. Bumping to `ecmaVersion: 2022` (or `latest`) would allow linting of modern syntax without false positives. *(Suggestion)*
- **Line ~9** — `globalIgnores` lists `dist`, `electron-dist`, `release`, `coverage`, `.claude`. It omits `.agents`, `.claude-flow`, `.gemini`, and `.swarm`, which are also per-machine runtime artifacts. *(Suggestion)*

### `tsconfig.app.json` / `tsconfig.node.json`
- `tsconfig.app.json` targets `ES2022` while `tsconfig.node.json` targets `ES2023`. Aligning both to the same target reduces mental overhead. *(Suggestion)*

### `package.json` — `@types/better-sqlite3`
- `better-sqlite3` is at `^12.9.0` but `@types/better-sqlite3` is at `^7.6.13`. The major version gap suggests the type definitions may lag behind the runtime API. *(Suggestion)*

### `electron-builder.yml`
- **Line ~11-28** — Long comment says "v1.1.0 will re-introduce asar with correct unpack patterns." Project is at v1.1.9 and `asar` is still `false`. Comment is misleading. *(Suggestion)*

### `scripts/build-electron.cjs`
- **Line ~18** — `target: 'node20'` is hard-coded. Electron 30 ships with Node ~20.13. While correct now, it will silently drift when Electron is upgraded. Deriving the target from `process.versions.node` or the `electron` package metadata would make the build self-correcting. *(Suggestion)*

### `playwright.config.ts`
- **Missing** — Lacks `use.baseURL`, `projects` (cross-browser testing), a `webServer` command, and meaningful reporters (only `['list']`). For an Electron app, should specify `electron.launch()` options. *(Warning)*

---

## 6. File Index

| File | Issues Found | Categories |
|------|-------------|------------|
| `src/renderer/app/App.tsx` | 3 | optimization, bug, better-logic |
| `src/renderer/app/state.tsx` | 3 | bug, optimization, dead-code |
| `src/renderer/app/state.reducer.ts` | 7 | bug, optimization, better-logic |
| `src/renderer/app/state.hook.ts` | 1 | optimization |
| `src/renderer/app/state.types.ts` | 2 | better-logic |
| `src/renderer/app/state.test.ts` | 1 | dead-code |
| `src/renderer/app/state-hooks/use-session-restore.ts` | 2 | bug, optimization |
| `src/renderer/app/state-hooks/use-workspace-mirror.ts` | 2 | bug (critical), better-logic |
| `src/renderer/app/state-hooks/use-live-events.ts` | 2 | bug, optimization |
| `src/renderer/app/state-hooks/use-exited-session-gc.ts` | 2 | bug (critical), better-logic |
| `src/renderer/app/state-hooks/parsers.ts` | 3 | bug, dead-code, better-logic |
| `src/renderer/app/ThemeProvider.tsx` | 1 | optimization |
| `src/shared/rpc-channels.ts` | 1 | bug |
| `src/shared/providers.ts` | 1 | better-logic |
| `src/types/index.ts` | 1 | dead-code |
| `src/shared/router-shape.ts` | 0 | referenced by bug in rpc-channels |
| `src/renderer/features/swarm-room/RoleRoster.tsx` | 2 | bug, dead-code |
| `src/renderer/features/swarm-room/SwarmRoom.tsx` | 2 | bug, optimization |
| `src/renderer/features/swarm-room/MissionStep.tsx` | 1 | bug (critical) |
| `src/renderer/features/bridge-agent/Composer.tsx` | 1 | bug |
| `src/renderer/features/bridge-agent/BridgeRoom.tsx` | 1 | bug |
| `src/renderer/features/bridge-agent/ChatTranscript.tsx` | 1 | optimization |
| `src/renderer/features/settings/VoiceTab.tsx` | 1 | bug |
| `src/renderer/features/memory/MemoryRoom.tsx` | 1 | bug |
| `src/renderer/features/memory/MemoryGraph.tsx` | 2 | bug, optimization |
| `src/renderer/features/memory/MemoryEditor.tsx` | 2 | bug, optimization |
| `src/renderer/features/tasks/TaskDetailDrawer.tsx` | 2 | bug |
| `src/renderer/features/tasks/TasksRoom.tsx` | 1 | optimization |
| `src/renderer/features/editor/EditorTab.tsx` | 1 | bug |
| `src/renderer/features/editor/useEditor.ts` | 1 | bug |
| `src/renderer/features/review/NotesTab.tsx` | 1 | bug |
| `src/renderer/features/review/SessionList.tsx` | 1 | optimization |
| `src/renderer/features/browser/BrowserRoom.tsx` | 1 | bug |
| `src/renderer/features/browser/DesignOverlay.tsx` | 1 | bug |
| `src/renderer/features/operator-console/Constellation.tsx` | 3 | bug, optimization |
| `src/renderer/features/operator-console/ReplayScrubber.tsx` | 2 | bug |
| `src/renderer/features/operator-console/OperatorConsole.tsx` | 1 | optimization |
| `src/renderer/features/command-room/CommandRoom.tsx` | 1 | optimization |
| `src/renderer/features/command-room/PaneHeader.tsx` | 1 | dead-code |
| `src/renderer/features/command-room/PaneSplash.tsx` | 1 | dead-code |
| `src/renderer/features/sidebar/WorkspacesPanel.tsx` | 1 | optimization |
| `src/renderer/features/command-palette/CommandPalette.tsx` | 1 | optimization |
| `src/renderer/features/workspace-launcher/Launcher.tsx` | 1 | dead-code |
| `src/renderer/features/workspace-launcher/AgentsStep.tsx` | 1 | dead-code |
| `src/renderer/features/workspace-launcher/grid.ts` | 1 | better-logic |
| `src/renderer/features/onboarding/OnboardingModal.tsx` | 1 | better-logic |
| `src/renderer/features/right-rail/RightRailTabs.tsx` | 1 | optimization |
| `src/renderer/lib/canDo.ts` | 1 | better-logic |
| `src/renderer/lib/shortcuts.ts` | 1 | dead-code |
| `src/renderer/lib/notifications.ts` | 1 | optimization |
| `electron/main.ts` | 7 | bug, optimization, dead-code, better-logic |
| `electron/preload.ts` | 1 | better-logic |
| `electron/auto-update.ts` | 3 | bug, optimization, better-logic |
| `native/voice-mac/binding.gyp` | 1 | bug (critical) |
| `native/voice-mac/src/sigmavoice_mac.mm` | 1 | bug |
| `native/voice-mac/src/recognizer.mm` | 1 | bug |
| `native/voice-mac/src/tsfn_bridge.mm` | 1 | bug |
| `native/voice-mac/index.js` | 1 | bug |
| `src/main/core/browser/manager.ts` | 3 | bug, better-logic |
| `src/main/core/memory/manager.ts` | 2 | optimization, dead-code |
| `src/main/core/memory/index.ts` | 1 | optimization |
| `src/main/core/memory/db.ts` | 1 | dead-code |
| `src/main/core/pty/local-pty.ts` | 1 | better-logic |
| `src/main/core/pty/registry.ts` | 1 | optimization |
| `src/main/core/session/session-restore.ts` | 1 | better-logic |
| `src/main/core/workspaces/lifecycle.ts` | 1 | better-logic |
| `src/main/lib/exec.ts` | 2 | bug, dead-code |
| `src/main/rpc-router.ts` | 5 | bug, optimization, dead-code |
| `scripts/ruflo-mcp-filter.mjs` | 3 | bug |
| `scripts/install-macos.sh` | 2 | bug, dead-code |
| `scripts/adhoc-sign.cjs` | 1 | better-logic |
| `scripts/rename-preload.cjs` | 1 | dead-code |
| `scripts/build-electron.cjs` | 2 | optimization, better-logic |
| `components.json` | 1 | bug |
| `electron-builder.yml` | 5 | bug, optimization, better-logic |
| `package.json` | 8 | bug, dead-code, better-logic |
| `vite.config.ts` | 4 | bug, optimization |
| `tsconfig.app.json` / `tsconfig.node.json` | 2 | bug, better-logic |
| `eslint.config.js` | 3 | bug, better-logic |
| `playwright.config.ts` | 2 | optimization, better-logic |
| `vitest.config.ts` | 1 | optimization |
| `.github/workflows/` | 1 | better-logic (critical) |

---

*Report generated by Ruflo agent swarm. No files were modified.*
