# Changelog

All notable changes to SigmaLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once tagged releases begin.

## [Unreleased]

## [1.2.3] - 2026-05-12

No code changes. Re-tag from current main so the macOS release workflow (merged in PR #4 after v1.2.2 was tagged) builds + attaches the DMG + `latest-mac.yml` to the same Release as the Windows EXE. Restores the auto-update channel manifest that has been missing from every Mac release since v1.1.4.

### CI / Distribution

- **`.github/workflows/release-macos.yml`** (Kimi, PR #4) now active for tag pushes. v1.2.3 is the first release to attach all four macOS artefacts: `*.dmg`, `*.dmg.blockmap`, `*.zip`, `latest-mac.yml`.
- v1.2.2 Release on GitHub has the Windows EXE only; for macOS auto-update to start working, opted-in macOS users need to manually install v1.2.3 once. From v1.2.3 onwards `electron-updater` can resolve `latest-mac.yml` from GitHub Releases.

## [1.2.2] - 2026-05-12

Two-part Windows hotfix that closes both ends of the v1.2.0 install path.

### Fixed — install-script asset matching (PR #5)

The install one-liner failed against v1.2.1 because the script's regex looked for `SigmaLink-Setup-*.exe` (dashes), but `electron-builder` produces `SigmaLink.Setup.<version>.exe` (dots — Windows artifact-name default). Asset regex now accepts either separator and falls back to a portable-target pattern.

- **`app/scripts/install-windows.ps1`** — regex `^SigmaLink[-.]Setup[-.](.*)\.exe$` + portable fallback. Bonus quality-of-life: ARM64 emulation pass-through, PS5.1 download speedup (`$ProgressPreference = 'SilentlyContinue'`), informational admin pre-flight, distinct 403 rate-limit message.

### Fixed — runtime native-module loading (PR #6)

The v1.2.1 EXE built successfully but crashed on launch because the packaged bundle was missing native `.node` files. Root cause: pnpm's content-addressed / symlinked node_modules layout confuses electron-builder's pack-phase file matcher (same class of bug `asar: false` mitigated in v1.0.1).

- **`app/.npmrc`** — added `node-linker=hoisted` so pnpm uses flat npm-style node_modules layout that electron-builder packs correctly.
- **`app/electron-builder.yml`** — reverted v1.2.1's `npmRebuild: false`. Now safe with the hoisted layout, and ensures native modules cross-compile against Electron 30 ABI.
- **`app/package.json`** — added `@types/mocha` + `@types/jest` to devDependencies to satisfy node-pty 1.1.0's source-build tsc step during electron-builder's rebuild pass.

### Dev-environment note

After pulling, run `pnpm install --force` once locally — the `.npmrc` switch from pnpm's default isolated layout to hoisted requires a one-time re-link.

## [1.2.1] - 2026-05-12

Hotfix for the v1.2.0 Windows CI build. The v1.2.0 tag push triggered `release-windows.yml` correctly, but the EXE never built: `electron-builder`'s default `npmRebuild: true` ran a second `npm rebuild node-pty@1.1.0` during the pack phase, which on Windows tries to compile node-pty from source and trips over node-pty's own test files (`windowsPtyAgent.test.ts`, `windowsTerminal.test.ts`) needing `@types/mocha`. The workflow already rebuilds native modules in an earlier explicit step, so electron-builder's rebuild was redundant.

### Fixed

- **`app/electron-builder.yml`** — added `npmRebuild: false` so `electron-builder` skips its own rebuild pass. Our CI workflow's prior `pnpm rebuild better-sqlite3 node-pty` step covers Windows; macOS local builds are covered by `electron-builder install-app-deps` in the `package.json` postinstall.

### Distribution

- v1.2.0 release on GitHub was not created (workflow failed before reaching `softprops/action-gh-release@v2`). v1.2.1 is the first published Windows release. Users who tried the `install-windows.ps1` one-liner against v1.2.0 saw a "no matching `SigmaLink-Setup-*.exe`" error path; running it again after v1.2.1 lands works cleanly.

## [1.2.0] - 2026-05-12

Windows 10/11 (x64) is now a peer release surface to macOS arm64. NSIS installer ships from CI on every tag push; PowerShell one-liner installer mirrors the macOS curl-bash UX. Voice on Windows routes through the Chromium Web Speech API; native SAPI5 is deferred to v1.3+. Code-signing is deferred indefinitely; SmartScreen workarounds documented inside the installer. Vitest 196 → 205. Zero behavioural regressions on macOS.

### Added — distribution

- **`.github/workflows/release-windows.yml`** (70 LOC). Builds the NSIS EXE on `windows-latest` on every `v*` tag push (and `workflow_dispatch`); rebuilds native modules; uploads `SigmaLink-Setup-*.exe` to the GitHub Release via `softprops/action-gh-release@v2`. Concurrency group `release-windows-${{ github.ref }}` with `cancel-in-progress: false`; permissions `contents: write`.
- **`app/scripts/install-windows.ps1`** (234 lines / ~180 LOC). PowerShell 5+, AMD64-only, fetches latest or pinned release, downloads `SigmaLink-Setup-*.exe` to `$env:TEMP`, runs `Unblock-File` to strip MOTW, launches NSIS installer. Params: `-Version <tag>`, `-Quiet` (forwards NSIS `/S`), `-KeepInstaller`.
- **`app/build/nsis/README — First launch.txt`** (72 lines). Wired via `nsis.license` in `app/electron-builder.yml`; surfaced during install. Documents two SmartScreen recoveries for users who download the EXE manually (Option A: "More info → Run anyway"; Option B: right-click → Properties → Unblock).
- **`docs/04-design/windows-port.md`** (NEW). ~150 lines of architectural decisions + touch-point reference table + trade-offs covering PTY resolution, native frame chrome, Web Speech fallback, unsigned + Unblock-File strategy, native module CI rebuild, MCP pipe transport, Cascadia Mono font.
- **`docs/09-release/release-notes-1.2.0.txt`** (NEW).

### Added — renderer

- **`app/src/renderer/lib/platform.ts`** (NEW, 12 LOC). Exports `getPlatform()` + `IS_WIN32`. Single source of truth for renderer-side platform branches.
- **`app/electron/preload.ts`** — `window.sigma.platform = process.platform` exposure.
- **2 new test files** — `Breadcrumb.test.tsx` + `VoiceTab.test.tsx`. 9 new cases. Repo total **205/205** (was 196/196).

### Changed — installer

- **`app/electron-builder.yml`** — dropped `ia32` from `win.target.nsis.arch` (now `[x64]` only). Wired `nsis.installerIcon` + `nsis.uninstallerIcon` + `nsis.installerHeaderIcon` to `build/icon.ico`. Wired `nsis.license` to surface the SmartScreen explainer during install.

### Changed — renderer

- **`app/src/renderer/features/top-bar/Breadcrumb.tsx`** — conditional 140px right-padding on win32 via `IS_WIN32` to clear the native min/max/close buttons (WCO area).
- **`app/src/renderer/features/command-room/Terminal.tsx:112`** — prepended `"Cascadia Mono"` to the xterm fontFamily stack ahead of `Consolas`. macOS and Linux unaffected.
- **`app/src/renderer/features/settings/VoiceTab.tsx`** — platform-aware. `NATIVE_ENGINE_LABEL` reads "Web Speech API (Chromium, requires internet)" on non-darwin; `NATIVE_ENGINE_AVAILABLE` is `false`; diagnostics indicator dot is grey neutral instead of red error.

### Closed — historic bugs

- **Windows `.cmd` shim spawn ("Cannot create process, error code: 2")** — investigation at `docs/01-investigation/01-known-bug-windows-pty.md` marked **RESOLVED 2026-05-12**. Shipping fix lives at `app/src/main/core/pty/local-pty.ts:47-85` (`resolveWindowsCommand` PATH+PATHEXT walker), `:175-197` (resolved-then-wrap dispatcher), `:215-230` (pre-flight ENOENT for fallback walk). Original investigation preserved verbatim as the root-cause record.

### Deferred

- Native Windows SAPI5 voice binding → v1.3+ (offline + always-on capture).
- `windowsControlsOverlay` frameless chrome → v1.3+ (cosmetic polish; v1.2.0 ships with native frame + 140px Breadcrumb pad).
- EV/OV Authenticode certificate → indefinitely (funded-only; $300-700/yr).
- Linux AppImage / .deb test gating → v1.3+ (no CI runner yet).
- Microsoft Store / WinGet distribution → after EV cert.
- Windows auto-update → after signing.
- `nsis.license` → custom NSH welcome page → v1.2.1 (cosmetic; currently abuses the license-agreement field which forces an "I accept" radio gate).

### Known issues

- **SmartScreen first-run warning** for users who download the EXE manually (not via the PowerShell installer). Per-binary-hash reputation, so every release re-warms from zero. Workarounds documented in the in-installer README.
- **`nsis.license` welcome page** semantically odd — surfaced behind a forced "I accept" radio gate. v1.2.1 polish.
- **Web Speech API requires internet on Windows** — air-gapped users have no voice path until SAPI5 lands in v1.3+.

### Build hygiene

- `pnpm exec tsc -b` clean.
- `pnpm exec vitest run` → **205/205** (was 196/196 at v1.1.11; +9 new specs).
- `pnpm exec eslint .` → 0/0 (unchanged).
- `pnpm exec vite build` → unchanged main bundle.
- macOS DMG sign unchanged from v1.1.11.
- Windows EXE built by CI on `windows-latest` and uploaded to the GitHub Release automatically; smoke verified locally via `pnpm electron:pack:win` on macOS host.

## [1.1.11] - 2026-05-12

Kimi audit P1 fix wave. 10 of 11 verified findings closed + 37 new tests. Vitest 168→196.

### Fixed — native + critical state

- **C1 native voice-mac `std::terminate()` risk** (`binding.gyp` + `sigmavoice_mac.mm` + `tsfn_bridge.mm`): exception flags flipped ON, every `ThreadSafeFunction::New` call site wrapped in `try/catch (const Napi::Error&)` that propagates as JS exceptions instead of crashing the host. node-gyp rebuilds clean.
- **C2 useWorkspaceMirror state desync** (`use-workspace-mirror.ts:35-44`): `catch { return; }` replaced with `catch (err) { console.warn(...); }` + fall-through; `SYNC_OPEN_WORKSPACES` now always dispatches.
- **C3 useExitedSessionGc unmount race** (`use-exited-session-gc.ts:22-40`): `timers.has(sessionId)` guard inside the setTimeout callback. Unmount cleanup empties the Map → stale dispatches suppressed.
- **C4 MissionStep voice cleanup closure-over-null** (`MissionStep.tsx:228-233`): introduced `voiceHandleRef` mirroring `voiceHandle` via tracking useEffect; cleanup reads from ref. Removed `eslint-disable-next-line`.

### Fixed — state-hook + reducer warnings

- **Per-workspace room snapshot preserved** (`use-session-restore.ts`, `state.types.ts`, `state.reducer.ts`): added `roomByWorkspace: Record<string, RoomId>` + `SET_ROOM_FOR_WORKSPACE` action + WORKSPACE_OPEN/CLOSE/READY/SET_WORKSPACES/SYNC_OPEN_WORKSPACES maintenance. Workspaces in different rooms no longer share the active room on restore.
- **SET_ACTIVE_WORKSPACE_ID logs unknown IDs** (`state.reducer.ts:102-117`): `console.warn` before returning unchanged.
- **REMOVE_SESSION fallback prefers live sessions** (`state.reducer.ts:176-188`): filter `status === 'running'` first.
- **UPSERT_SWARM only auto-activates on first arrival** (`state.reducer.ts:199-208`): auto-set `activeSwarmId` only when post-upsert workspace has exactly one swarm. Deselected workspaces no longer jump on unrelated swarm updates.
- **Review hydration no-churn on session add/remove** (`use-live-events.ts:89-101`): dropped `state.sessions.length` from effect deps.
- **parseSwarmMessage runtime kind validation** (`parsers.ts:120`): `VALID_SWARM_KINDS` allowlist + `isSwarmMessageKind` guard; null/missing → `'OPERATOR'`; unknown → reject.

### False positives (verified, no code change)

- **C5 "No CI/CD pipeline"**: 3 workflows already exist (`lint-and-build.yml`, `e2e-matrix.yml`, `native-prebuild-mac.yml`).
- **Fix 5 `voice.diagnostics.run` channel missing handler**: handler IS registered at `rpc-router.ts:884-890`, schema-validated at `schemas.ts:369`.

### Deferred to v1.1.12

- **Fix 8 appStateStore double-render via useLayoutEffect** — real bug but needs paired refactor with `useSyncExternalStore` wiring.
- Kimi's ~100 warning-level findings across 20+ feature files.

### Build hygiene

- `pnpm exec tsc -b` clean; `pnpm exec vitest run` **196/196** (was 168/168, +28 specs); `pnpm run lint` 0/0; `pnpm exec vite build` 38.26 KB gzip main; `codesign --verify --deep --strict` Sealed Resources files=20492; native `node-gyp rebuild` clean with exceptions ON.

## [1.1.10] - 2026-05-12

Reliability hotfix from Gemini parallel audit. 6 P1 bugs + 4 perf wins + dead-code sweep. Vitest 130→168 (+38 new tests). Zero behavioural changes for the happy path; wins are all in failure modes (process leaks, race conditions, broadcast aborts, animation waste, hung child kills).

### Fixed — backend reliability

- **`resolveAndSpawn` fallback now tries alternatives on ENOENT** (`pty/local-pty.ts`). New `resolvePosixCommand` PATH pre-flight throws synchronous `ENOENT` so the launcher's existing fallback walk reaches the next candidate.
- **`pty.forget()` kills underlying PTY** (`pty/registry.ts`). Was leaking ghost processes. SIGTERM + 5s SIGKILL fallback.
- **`killAll()` uses ONE 5s timer regardless of session count** (`pty/registry.ts`). Was scheduling N timers (one per session) — verified via `vi.getTimerCount()`.
- **`execCmd` kills child on maxBuffer overflow** (`lib/exec.ts`). New `handleOverflow()` destroys stdio + SIGTERMs child + 5s SIGKILL fallback. New `maxBufferExceeded: boolean` field on ExecResult (additive).

### Fixed — orchestration reliability

- **Mailbox broadcast continues on per-recipient failure** (`swarms/mailbox.ts`). Per-recipient try/catch + `console.warn` with `swarmId` + key. `@all` / `@coordinators` no longer aborts on one destroyed PTY.
- **`addAgentToSwarm` role index atomic via `db.transaction()`** (`swarms/factory.ts`). Concurrent same-role adds now serialize on SQLite's write lock and produce contiguous indices instead of UNIQUE constraint violation.
- **`StdinWriter` per-write timeout** (`assistant/runClaudeCliTurn.emit.ts`). New `STDIN_WRITE_TIMEOUT_MS = 30_000` + `onTimeout` callback. Turn driver passes `() => child.kill('SIGTERM')` so a hung child doesn't outlive its broken stdin.

### Changed — frontend perf

- **Terminal, Sidebar, Launcher migrated to per-slice `useAppStateSelector`**. v1.1.9 introduced the selector hook and migrated 4 rooms; v1.1.10 covers these last three. Terminal subscribes to 1 slice (`activeWorkspace.id`); Sidebar to 5; Launcher to 2 + dispatch-only inner row. Unrelated dispatches no longer trigger re-renders.
- **Constellation animation gated by Page Visibility API + IntersectionObserver** (`operator-console/Constellation.tsx`). rAF loop pauses when either signal reports hidden; resumes when both visible. 6 new tests.

### Removed

- **`PhasePlaceholder.tsx` + `placeholders/` dir** — zero callers, pre-Electron remnant.
- **`RoomChrome.tsx`** — single caller (SettingsRoom) inlined; unused props dropped. Net -82 LOC across the dead-code sweep.

### Build hygiene

- `pnpm exec tsc -b` clean.
- `pnpm exec vitest run` 168/168 (was 130/130).
- `pnpm run lint` 0/0.
- `pnpm exec vite build` 38.26 KB gzip main (unchanged shape from v1.1.9).
- `codesign --verify --deep --strict` Sealed Resources files=20492.

### New test files

- `pty/local-pty.test.ts` (8), `pty/registry.test.ts` (7), `providers/launcher.test.ts` (4), `lib/exec.test.ts` (3), `runClaudeCliTurn.emit.test.ts` (6), `operator-console/Constellation.test.tsx` (6). Plus 4 new specs added to `mailbox.test.ts` + `factory.test.ts`.

### Source

Gemini audit at `app/docs/investigation/codebase-audit-v1.1.3.md`. 4-coder Ruflo swarm executed the fixes on disjoint file scopes.

## [1.1.9] - 2026-05-12

Two coordinated swarms shipped this release. PR #3 (Codex + Claude finalizer) landed the perf paired refactor + CI hardening + lint wave 32→0. A second 3-coder swarm landed the file-size targets that closed out the v1.1.9 backlog. Zero behavioural changes. Zero broken contracts.

### Performance

- **`useAppStateSelector<T>` + `useAppDispatch`** backed by `useSyncExternalStore`. Consumers subscribe to a per-selector slice of state. CommandRoom, CommandPalette, SwarmRoom, OperatorConsole migrated.
- **Precomputed slices**: `sessionsByWorkspace` + `swarmsByWorkspace`. Reducer maintains both on add/exit/remove/set-swarms/upsert/end. O(1) lookup replaces O(N) filter on every render.

### Changed — file-size budget

- `swarms/factory.ts` **713 → 396 LOC**. Private spawn helpers (`spawnAgentSession`, `pickCoordinatorId`, `buildExtraArgs`, `loadAgentSession`, `materializeRosterAgent`) moved to `factory-spawn.ts` (344 LOC). Public surface unchanged.
- `assistant/runClaudeCliTurn.ts` **709 → 348 LOC**. Stateless emit layer → `runClaudeCliTurn.emit.ts` (186 LOC). Tool routing + Ruflo trajectory + readline-loop → `runClaudeCliTurn.trajectory.ts` (193 LOC). Public surface preserved; `__resetProbeCache` + `__resetActiveChildren` test helpers intact.
- `renderer/app/state.tsx` **553 → 97 LOC**. 14 IPC-event listener effects extracted into custom hooks under `state-hooks/`: `use-session-restore.ts` (142), `use-workspace-mirror.ts` (65), `use-live-events.ts` (140), `use-exited-session-gc.ts` (49), plus shared `parsers.ts` (163) with deduplicated `runRefreshOnEvent` helper.

### CI / test infra

- GH Actions `cache-dependency-path` fixed (was stale).
- pnpm install: `--no-frozen-lockfile --ignore-scripts` + explicit `node node_modules/electron/install.js`.
- `pnpm run coverage` + `@vitest/coverage-v8` + thresholds (lines 22 / stmts 21 / fn 21 / br 18).
- ShellCheck CI step for `install-macos.sh`.
- `.claude` + `app/coverage/` + `docs/06-test/` added to ignore lists.

### Fixed

- **Lint baseline 32 → 0**. React-compiler structural family resolved: setState-in-effect deferred-to-next-tick, render-time `Math.random()` in sidebar skeleton replaced with deterministic sizing, `shared/rpc.ts` `any` typed, narrow file-level immutability disables for MemoryGraph + Constellation intentional-mutable-ref surfaces.

### Build hygiene

- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → **130/130** (was 128/130 at v1.1.8)
- `pnpm run lint` → **0/0** (was 32/1 at v1.1.8)
- `pnpm run coverage` → 21.92% stmts / 18.8% br / 21.23% fn / 22.72% lines (above baseline)
- `pnpm exec vite build` → 38.26 KB gzip main (unchanged from v1.1.8)
- `codesign --verify --deep --strict` → exit 0, `Sealed Resources files=20492`
- `bash -n scripts/install-macos.sh` → clean

### File-size budget compliance

All v1.1.x churn files now under the 500-LOC project rule. Four files still over budget are tracked for v1.2 (rpc-router.ts 985, router-shape.ts 770, sidebar.tsx 726, BridgeRoom.tsx 721).

## [1.1.8] - 2026-05-12

5-agent parallel optimization swarm. Zero behavioural changes. Zero broken contracts. Cold boot ~60% faster (bundle), all 6 NMV-blocked tests recovered (108/114 → 128/128 green), lint -28, state.tsx splits under budget.

### Performance

- **Main bundle 97.57 → 38.26 KB gzip (-61%, -59 KB)** — 10 rooms now `React.lazy()`-loaded (CommandRoom stays eager). BridgeRoom + OperatorConsole + MemoryRoom + SkillsRoom + BrowserRoom + ReviewRoom + TasksRoom + SettingsRoom + SwarmRoom + Launcher emitted as sibling chunks. BridgeTabPlaceholder + RightRail also converted to lazy (no vite "dynamic import will not move module" warnings).
- **BrowserRoom latch-on-first-activation** — instead of unconditionally mounting `<BrowserRoom visible={activeTab==='browser'}/>`, RightRail now only renders the subtree once `activeTab === 'browser'` has been true at least once. Keeps the browser:state listener + DesignOverlay + BrowserViewMount + BrowserRecents tree out of cold boot.
- **`renderer/lib/pty-data-bus.ts`** (88 lines) — new module routes `pty:data` events by sessionId through a `Map<string, Set<Listener>>`. With 16 panes, previously each chunk paid 32 `eventOn` dispatches + 32 sessionId string-compares + 31 drops; now: 1 dispatch + 1 Map.get + 1-2 actual listener calls. IPC + main-process untouched. 9 new bus tests cover routing, isolation, unsubscribe, install-once, mid-dispatch self-unsubscribe.

### Fixed

- **6 main-process tests recovered** — `src/main/core/swarms/mailbox.test.ts` + `src/main/core/assistant/tools.test.ts` were hitting better-sqlite3 NMV 123 ↔ 147 mismatch when run under host Node 26 (binding compiled for Electron 30.5.1). Both migrated to the canonical `vi.mock('../db/client')` + `fakeDb()` pattern already used by `session-restore.test.ts` and `manager.test.ts`.

### Added

- **`src/test-utils/db-fake.ts`** — new shared shim consolidating the `fakeDb()` + seed helpers previously inlined in 3+ tests. Future main-process tests can import instead of re-implementing.
- **`src/main/core/swarms/factory.test.ts`** — new test covering `paneIndex` derivation + 20-agent cap (the contract that v1.1.4 CommandRoom + tools dispatch both depend on).
- **`renderer/lib/pty-data-bus.test.ts`** — 9 specs (see Performance section above).

### Changed

- **state.tsx 996 → 553 LOC + 3 sibling modules**:
  - `src/renderer/app/state.types.ts` (157 LOC) — `RoomId`, `AppState`, `Action`, `initialAppState`, `selectActiveWorkspace`
  - `src/renderer/app/state.reducer.ts` (316 LOC) — `appStateReducer` + private helpers
  - `src/renderer/app/state.hook.ts` (19 LOC) — `useAppState` + `AppStateContext`
  - `src/renderer/app/state.tsx` keeps the `AppStateProvider` + IPC wiring; re-exports the types/reducer/hook from the new modules. Zero consumer changes.
- **3 stub schemas → real zod** (`src/main/core/rpc/schemas.ts`): `panes.resume`, `swarms.addAgent`, `skills.verifyForWorkspace`. Shapes drawn from actual controller types. `VALIDATION_MODE` stays `'warn'`. Caught a Role enum drift: actual is `'coordinator'|'builder'|'scout'|'reviewer'`, not the plan's hallucinated `'tester'|'researcher'`.
- **`.data.ts` sibling split for 8 files** — variants/types extracted from: `badge.tsx`, `button.tsx`, `button-group.tsx`, `form.tsx`, `navigation-menu.tsx`, `toggle.tsx`, `sidebar.tsx`, `RightRailContext.tsx`. Pattern mirrors `rooms-menu-items.ts` / `workspaces-summary.ts` from v1.1.4. Consumer-side import paths updated where the rule still flagged re-exports (alert-dialog, pagination, calendar, toggle-group, RightRailSwitcher, RightRail).

### Removed

- **Dead utility code from `src/lib/utils.ts`** — `parseAnsi` (owned all 19 `no-control-regex` errors), `mockPTYBridge`, `generateId`, `formatDuration` (all zero-caller). `cn` + `formatTimestamp` retained.
- **Orphan `PTYBridge` type** + `TerminalSession.pty` field from `src/types/index.ts`.

### Build hygiene

- `pnpm exec tsc -b` clean.
- `pnpm exec vitest run` 128/128 (was 108/114). +20 tests across 4 new files.
- `pnpm run lint` 32 problems (31 errors + 1 warning; was 60 → -28). The 31 remaining are React-compiler structural family (set-state-in-effect, immutability, exhaustive-deps) — scheduled for a dedicated v1.1.9 wave.
- `pnpm exec vite build` 38.26 KB gzip main + 10 sibling lazy chunks.
- `codesign --verify --deep --strict --verbose=2 SigmaLink.app` still passes with `Sealed Resources version=2 rules=13 files=20492` (adhoc-sign hook from v1.1.5 unchanged).

## [1.1.7] - 2026-05-12

Internal-distribution release. No code changes. No behavioural changes. The new `app/scripts/install-macos.sh` is a self-contained Bash installer that downloads + installs SigmaLink WITHOUT triggering any macOS Gatekeeper dialog. `curl` doesn't tag its downloads with `com.apple.quarantine`, so files it fetches are exempt from Gatekeeper's first-launch assessment — same pattern Rust/Homebrew/Docker installers use. Confirmed empirically on macOS 26.4 (Tahoe): `xattr` output is empty on curl-downloaded files.

### Added

- **`app/scripts/install-macos.sh`** — 170-line POSIX-Bash installer:
  - Platform + arch gate (macOS arm64 only for now).
  - Resolves latest release via GitHub API; accepts explicit `v1.1.X` tag arg to pin.
  - Downloads `SigmaLink-<version>-arm64.dmg` via curl.
  - Quits any running SigmaLink via AppleScript.
  - Replaces `/Applications/SigmaLink.app` (with sudo fallback if write-protected).
  - Strips xattrs defensively (`xattr -cr`) even though curl shouldn't have added any.
  - Unmounts the DMG, prints launch hint, optionally launches SigmaLink if invoked from a tty.
  - Exit codes: 0 success, 2 wrong platform/arch, 3 GitHub API failure, 4 download failure, 5 install/copy failure.
- **`README.md` Install section** — new top-level section above "Quickstart (build from source)" documenting the curl one-liner + how to pin a version + the fallback DMG path.

### Changed

- **`build/dmg/README — Open SigmaLink.txt`** — preamble points users at the curl one-liner first; the Terminal `xattr -cr` and System Settings workarounds stay as the manual fallback.

### One-liner install

```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash
```

Pin to a specific tag:
```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash -s v1.1.7
```

## [1.1.6] - 2026-05-12

Single-file documentation release on top of v1.1.5. No code changes. No behavioural changes. The mounted DMG now ships a clear `README — Open SigmaLink.txt` explaining how to recover from the macOS Sequoia/Tahoe Gatekeeper "Apple could not verify SigmaLink is free of malware" dialog. (Notarisation, which would eliminate the dialog entirely, requires Apple Developer Program membership at $99/year — held until SigmaLink is funded.)

### Added

- **`build/dmg/README — Open SigmaLink.txt`** — plain-ASCII first-launch walkthrough that appears as a third item next to `SigmaLink.app` + `Applications →` symlink when the DMG mounts. Covers both recoverable workarounds: the Terminal one-liner `xattr -cr /Applications/SigmaLink.app` AND the 6-step System Settings → Privacy & Security → "Open Anyway" flow that replaced the Sequoia-removed Control-click → Open shortcut.

### Changed

- **`electron-builder.yml` `dmg.contents`** — added a third coordinate entry pointing at the README. The DMG window now contains 3 items instead of 2.

### Path to permanent fix (v1.2 candidate)

Notarisation eliminates the dialog entirely. Requires:
1. Apple Developer Program membership ($99/year).
2. "Developer ID Application" certificate exported as .p12.
3. GitHub Actions secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`.
4. `electron-builder.yml` mac block: real `identity`, `hardenedRuntime: true`, `notarize: true`.
5. Remove `scripts/adhoc-sign.cjs` afterSign hook + the in-DMG README.

After that ships, SigmaLink is also eligible for Homebrew Cask (which is removing un-notarised casks by Sept 2026 anyway).

## [1.1.5] - 2026-05-12

Single-bug hotfix on top of v1.1.4. No new features. No behavioural changes. The macOS DMG can now be downloaded from GitHub and opened by drag-to-/Applications without the user being told the bundle is "damaged".

### Fixed

- **macOS Gatekeeper "damaged and can't be opened" on downloaded DMG** — root cause: v1.1.0 turned on `hardenedRuntime: true` in `electron-builder.yml` without a corresponding signing identity, with a comment claiming hardened runtime was "harmless without a Developer ID". It isn't. electron-builder's identity auto-discovery found no Developer ID, silently produced a bundle whose only signature was the linker-injected ad-hoc stamp ld(1) puts on every Mach-O, and the bundle never gained a `Contents/_CodeSignature/CodeResources` resource seal. Chrome attaches `com.apple.quarantine` to downloads, Gatekeeper checks the signature, sees a seal-asserting ad-hoc sig with no actual `CodeResources` directory, and rejects with "damaged" (the destructive verdict — vs the recoverable "unidentified developer" prompt). Every DMG from v1.1.0..v1.1.4 carries the same defect; only fresh local builds escaped because they had no quarantine flag.

### Added

- **`scripts/adhoc-sign.cjs`** — new electron-builder `afterSign` hook (~70 lines including header comment). After packaging, runs `codesign --force --deep --sign - --timestamp=none "<App>.app"` to re-sign every nested Mach-O (Electron Framework + 4 SigmaLink helper apps + Squirrel + Mantle + ReactiveObjC + every `.node` native module) AND write a real `_CodeSignature/CodeResources` seal (20492 files sealed in the v1.1.5 bundle). Then runs `codesign --verify --deep --strict` and throws if it fails — silent ship-with-broken-sig regressions are now impossible.

### Changed

- **`electron-builder.yml` mac block**: `identity: null` (skip builder's signing pass — adhoc-sign.cjs owns it), `hardenedRuntime: false` (with ad-hoc signing the hardened runtime can't survive trust checks anyway; SigmaVoice TCC prompts depend on Info.plist keys not on hardened runtime). Long comment in the YAML documents the regression history and the migration path when a Developer ID is eventually acquired.

### User workaround for v1.1.0..v1.1.4 DMGs already downloaded

```bash
xattr -cr ~/Downloads/SigmaLink-1.1.4-arm64.dmg
open ~/Downloads/SigmaLink-1.1.4-arm64.dmg
# drag to /Applications, then:
xattr -cr /Applications/SigmaLink.app
open /Applications/SigmaLink.app
```

`xattr -cr` strips `com.apple.quarantine`. Gatekeeper only enforces on quarantined apps; once stripped, the broken signature stops mattering.

### Build hygiene

- `pnpm exec tsc -b` clean. `pnpm exec vitest run` 108/114 (same pre-existing NMV-host-Node failures). `pnpm exec vite build` 354.95 KB raw / 97.57 KB gzip. `pnpm run lint` 59 (unchanged from v1.1.4).
- `codesign --verify --deep --strict --verbose=2 SigmaLink.app` returns exit 0 with `valid on disk` + `satisfies its Designated Requirement`. `Sealed Resources version=2 rules=13 files=20492`. v1.1.4 had `Sealed Resources=none`.

## [1.1.4] - 2026-05-11

V3 BridgeMind visual parity sweep. Frontend-only release; backend touches: zero. RPC channels touched: zero. The functional pipeline from v1.1.3 is preserved exactly; what changes is the chrome around it. (For v1.1.2 + v1.1.3 release narrative, see `docs/09-release/release-notes-1.1.2.txt` + `release-notes-1.1.3.txt`.)

### Added

- **Workspaces panel as full sidebar body** — new `WorkspacesPanel.tsx` (216 lines) lifts the workspace-tabs concept out of `Sidebar.tsx` and becomes the sidebar's only content. Scrollable list (no 8-tab cap, no overflow drawer). Each row shows a deterministic colour dot (`workspaceColor()` hashes id → 8-colour palette), the workspace name, a running-pane-count badge, and a close × visible on hover for the active row. New `workspace-color.ts` utility (27 lines) + tests. Sidebar.tsx drops from ~500 to 147 lines (drops the 12-item nav block + Cmd+K launcher card).
- **Top-left rooms menu dropdown** — new `RoomsMenuButton.tsx` (72 lines) rendered at the left edge of the Breadcrumb. Single `LayoutGrid` icon opens a Radix DropdownMenu listing all 11 rooms. Disabled-when-no-workspace logic mirrors the v1.1.3 sidebar behaviour exactly. The active room is marked with a check. Items + icons + labels are split into `rooms-menu-items.ts` so the component file stays Fast-Refresh-clean.
- **Top-right right-rail switcher + settings gear** — new `RightRailSwitcher.tsx` (86 lines) rendered at the right edge of the Breadcrumb. Three-button segmented control (Globe / FileCode2 / Bot icons labelled "Browser" / "Editor" / "Sigma") plus a sibling Settings gear. State lifted into a new `RightRailContext` so the top-bar switcher and the rail content stay in sync; kv persistence of the last-active tab is preserved. The in-rail tab strip is hidden via a new `tabsVisible={false}` prop.
- **Pane right-click context menu with Stop** — Stop functionality moved out of the pane header chrome and into a Radix context menu on the pane body. Stop item is destructive variant and disabled when the session is exited or errored.

### Changed

- **Per-pane header collapsed to single h-7 strip** — `PaneHeader.tsx` rewrites the previous h-7 + h-6 two-strip pattern into one row: 2px colour stripe → truncated `PROVIDER·index` label (max-w-80px) → spacer → 4 icon buttons (Focus / Split / Minimise / Close). Branch / model / effort / cwd labels move into a Radix tooltip on hover of the provider name. Stop button removed from header chrome (right-click menu instead). Pane index is appended to the label so adjacent same-provider panes stay distinguishable. Focus icon binds to the existing `paneFocus` state machine.
- **9-pane layout: 3×3, not 4×3** — `GridLayout.shapeFor(9)` now returns `{ cols: 3, rows: 3 }` (matches V3 reference, no empty trailing cell). 10/11/12-pane layouts unchanged at 4×3.

### Removed

- **`PaneStatusStrip.tsx` deleted** — its model / effort / cwd content is now inside the PaneHeader tooltip body. All references and imports removed.
- **Sidebar nav items, ITEMS array, Cmd+K launcher card, inline WorkspaceTabs** — superseded by the rooms-menu dropdown + WorkspacesPanel.

### Fixed

- **PaneHeader.test.tsx Element.prototype tsc narrowing** — `Element.prototype.hasPointerCapture` and `.scrollIntoView` polyfills now use a typed cast (`proto as unknown as { hasPointerCapture?: ... }`) instead of `'X' in Element.prototype` narrowing, which collapsed to `never` and broke tsc.

### Distribution scope

arm64-only macOS DMG, same as v1.1.1 through v1.1.3. The pre-build electron-rebuild dance against Electron 30.5.1 (NMV 123) is still required for each manual arm64 release. Intel-Mac users: stay on v1.0.1 or wait for v1.2.

### Carried forward

All v1.1.0 → v1.1.3 surfaces intact: multi-workspace tabs (now in the new WorkspacesPanel), pane resume via `--resume <session_id>`, growable swarms with `add_agent` Sigma tool, Ruflo pre-flight + readiness pill, per-CLI skills verification, MCP host server bridging Sigma tools to the spawned Claude CLI, voice diagnostics, single-instance lock, window drag.

## [1.1.1] - 2026-05-10

UX hotfix on top of v1.1.0-rc3. Four user-reported defects fixed in one pass: the window is now draggable, the "Bridge Assistant" rebrand to "Sigma Assistant" is complete across every user-visible surface, the assistant actually streams real Claude Code CLI responses (no more "stub mode for W13"), and SigmaVoice has a full diagnostics surface so the silent "voice not enabled" failure mode is finally visible to the user.

### Added

- **Sigma Assistant Claude Code CLI streaming** — new driver `app/src/main/core/assistant/runClaudeCliTurn.ts` (497 lines) spawns the local `claude` CLI binary in `--output-format stream-json --verbose` mode via `child_process.spawn` (not PTY) and bridges its envelopes onto the existing `assistant:state` + `assistant:tool-trace` IPC channels. Probe cached per main-process lifetime; falls back to a friendly stub (with install link) when the binary is missing. Cancellation via `cancelClaudeCliTurn(turnId)` kills the child with SIGTERM. New `cli-envelope.ts` parser (91 lines) with type guards for the streaming JSON shape; new `system-prompt.ts` (108 lines) building a ~1100-token SigmaLink-aware system prompt with workspace context, recent files, open swarms, and the 10 canonical Sigma tools. Critical discovery: `--verbose` is required alongside `--output-format stream-json` (added to spawn args). 8 unit tests via `spawnOverride`/`probeOverride` injection + 1 Playwright e2e (skip-on-no-claude). Live JSON shape verified against installed CLI v2.1.138. No raw API calls.

- **SigmaVoice diagnostics surface** — new `app/src/main/core/voice/diagnostics.ts` `runVoiceDiagnostics()` probes 4 stages independently (native loaded, permission status, dispatcher reachable, last error) in try/catch — never throws. New RPC channels `voice.diagnostics.run` + `voice.permissionRequest` allowlisted in `rpc-channels.ts` and zod-schema'd in `schemas.ts`. New `app/src/renderer/features/settings/VoiceTab.tsx` with mode radio (off/auto/on persisted to kv), permission row with Re-prompt button, and "Run diagnostics" button that renders 4 coloured stage dots with hover-tooltip detail. 7 unit tests + 1 Playwright e2e walking the Settings flow.

- **First-launch voice auto-enable on macOS** — adapter now bootstraps `voice.mode` from `kv['voice.mode']` and on first launch flips `'off'`→`'auto'` when the native module loads (persists `voice.firstLaunch=1` so idempotent). On non-macOS or when native fails to load, emits a `voice:unavailable` event with `{reason: 'no-native'|'platform'}` so the UI can explain the disabled state instead of going silent.

- **Drag-region helper** — new `app/src/renderer/lib/drag-region.ts` `dragStyle()` / `noDragStyle()` returning typed `CSSProperties` with the WebKit-prefixed `WebkitAppRegion` value. Single chokepoint replaces ad-hoc style objects.

- **`sigmavoice.enabled` capability key** — added to all three tier rows (basic=false, pro=true, ultra=true) in `capabilities.ts`. Composer reads the new key. Legacy `bridgevoice.enabled` retained for one release as an alias.

### Fixed

- **Multiple SigmaLink instances on agent spawn / second `.app` launch** — `electron/main.ts` was missing `app.requestSingleInstanceLock()`. Without the lock, every LaunchServices activation (a second double-click of the .app, an agent CLI registering a URL handler, drag-drops onto the dock icon) spawned a parallel SigmaLink with its own SQLite handle, its own PTY pool, and its own RPC router — the duplicates fought the original for the WAL lock and the user saw two SigmaLink icons in the dock. v1.1.1 acquires the lock at boot; if a second instance starts, it focuses the existing window and quits cleanly.

- **Window immovable on macOS** — only a 28-px sliver in the sidebar header had `WebkitAppRegion: 'drag'`; the rest of the chrome (breadcrumb, right-rail tab bar, sidebar wordmark) was non-draggable, so under `titleBarStyle: 'hiddenInset'` the user couldn't pick up the window from anywhere visible. Wired drag regions across all chrome containers + `no-drag` overrides on every interactive child (collapse button, tabs).

- **"Stub mode for W13" reply text** — the right-rail assistant has been a deterministic stub since W13. v1.1.1 wires it to the actual local `claude` CLI; the stub remains as the binary-missing fallback (with an install hint).

- **"Voice not enabled or something" silent failure** — root cause was a diagnostics gap, not a single bug: mode defaults to `'auto'`, native module loads fine, but on first mic press `requestPermission()` returns `not-determined` until the OS dialog is acknowledged, the adapter threw `no-permission`, and the orb reset silently. Fixed by the first-launch auto-enable + `voice:unavailable` event + the new Settings → Voice diagnostics surface.

### Changed

- **Bridge → Sigma rebrand** — 8 user-visible strings swapped (sidebar nav, right-rail tab, command-palette entry, BridgeRoom EmptyState + standalone header, OriginLink banner, Composer placeholder + aria-label, VoicePill label). Comments + `Voice input (W15)` button title also updated. Folder paths and IPC channel names (`assistant:*`, `voice:*`) unchanged — protocol-level, breaks the renderer to rename.

- **`vitest` added as a dev dependency** for the new unit-test files.

### Carried forward from v1.1.0-rc3

All Phase 4 work intact: Track A (agent IPC reliability + provider launcher façade), Track B (SigmaVoice native macOS Speech.framework), Track C (Ruflo MCP supervisor + 3 user-facing features), and Skills marketplace live install.

### Distribution scope

**arm64-only this release.** The x64 macOS DMG was pulled because it would have bundled arm64 native modules under `--config.npmRebuild=false` and crashed on first launch (caught locally by the rc3 diagnostic page). Apple Silicon users get `SigmaLink-1.1.1-arm64.dmg` / `SigmaLink-1.1.1-arm64-mac.zip`. Intel-Mac users should stay on v1.0.1 or wait for v1.2 (which will wire a CI matrix with per-arch native rebuilds).

Required pre-build dance for arm64 releases until the CI matrix lands:
```
cd app/node_modules/.pnpm/better-sqlite3@<ver>/node_modules/better-sqlite3 \
  && npx electron-rebuild --module-dir . --types prod -f
```

## [1.1.0-rc3] - 2026-05-10

Hotfix on rc2. The rc2 DMG crashed at first launch with `Cannot find module 'lazy-val'`. rc3 fixes the underlying packaging defect.

### Fixed

- **DMG runtime crash `Cannot find module 'lazy-val'`** — root cause: `lazy-val` (transitive dep of `electron-updater`) was on the esbuild externals list, so `main.js` did `require('lazy-val')` at runtime. The packaged app's `Resources/app/node_modules/lazy-val/` was an EMPTY directory left by pnpm's content-addressed hoist (the real package lives in `node_modules/.pnpm/lazy-val@1.0.5/...`). Same family of trap as the v1.0.0 `bindings` defect. Fix: drop `lazy-val` from `scripts/build-electron.cjs` externals so esbuild bundles it inline; replace the empty pnpm placeholder at `node_modules/lazy-val/` with a proper symlink to the .pnpm content store. The fixed `main.js` no longer issues `require('lazy-val')` at runtime — the resolver path that crashed is eliminated.

## [1.1.0-rc2] - 2026-05-10

Release-candidate iteration on top of rc1. Adds Phase 4 Step 5 (Skills marketplace live install) which landed on `main` after rc1 was tagged.

### Added

* **Skills marketplace live install from GitHub URL** (Phase 4 Step 5) — Marketplace tab Install button now downloads a GitHub tarball (streamed to temp file, no in-memory load), shells out to `tar -xzf`, walks for SKILL.md (root / subPath / `skills/` heuristic), and runs the result through the existing `manager.ingestFolder` pipeline (sha256 hash + atomic temp+rename + per-provider fanout to Claude/Codex/Gemini). Supports `owner/repo` shorthand, full GitHub URL, and SSH URL formats. Default branch resolved via GitHub API when ref omitted. Streamed progress events drive a per-card progress bar.
* **Marketplace catalog expanded 8 → 20 entries** — 6 entries point at the real public `anthropics/skills` repo; 14 are curated SigmaLink/community placeholders with `install: { ownerRepo, ref?, subPath? }` blocks. Older entries without an install block fall back to `repoUrl → owner/repo` parsing.
* 21/21 marketplace unit tests covering URL parsing, SKILL.md location heuristics, tarball-wrapper detection, and end-to-end installFromUrl flow (success, ref override, invalid URL, missing SKILL.md, invalid frontmatter, UPDATE_REQUIRED hint, download failure cleanup, progress sequence, metadata failure).

### Changed

* `app.tier` schema corrected to `enum(['basic','pro','ultra'])` to match the actual `Tier` union (was `['free','pro','ultra']` in plan).
* Vite main bundle 322 → 326 KB (+4 KB for the new MarketplaceTab UI surface). Still well under the 700 KB target.

### Carried forward from rc1

All Track A (IPC + provider hardening) + Track B (SigmaVoice) + Track C (Ruflo) work from rc1 is in this candidate unchanged.

## [1.1.0-rc1] - 2026-05-10

Phase 4 release candidate. Three feature tracks landed in one autonomous overnight run on top of v1.0.1: Agent IPC reliability, SigmaVoice native macOS module, and Ruflo MCP supervisor with three user-facing features. **rc1** because the new native voice module + lazy-download Ruflo path warrant real-world validation before the final v1.1.0 tag.

### Added

* **SigmaVoice native macOS** (Track B) — replaces renderer-only Web Speech API with on-device `SFSpeechRecognizer` via Objective-C++ NAPI module (`app/native/voice-mac/`). ABI-stable Node-API binary per arch (darwin-x64 + darwin-arm64); end users no longer need Xcode after CI ships prebuilds. Continuous mode with `requiresOnDeviceRecognition=YES` (server-side capped at ~60 s). New `dispatcher.ts` regex intent classifier routes finalized transcripts into broadcast / rollCall / app.navigate / assistant.send. macOS minimum bumped 10.12 → 10.15 (Speech.framework requirement). 17/17 dispatcher tests pass.

* **Ruflo MCP embed** (Track C) — three new user-facing features powered by an Option B lazy-download supervisor. **Semantic Memory Search** in Memory room runs `ruflo.embeddings.search` in parallel with token search; "Semantic" chip on Ruflo-sourced rows. **Bridge Assistant pattern surfacing** debounces composer input 800 ms → `ruflo.patterns.search`; ribbon at ≥0.7 confidence with Apply / dismiss. **Autopilot Command Palette** prefetches `ruflo.autopilot.predict` on cmdk open with 30 s cache. New Settings → Ruflo tab with download button (350 MB) + health row + telemetry opt-in. 14/14 proxy unit tests pass.

* **Provider launcher façade** — new `providers/launcher.ts` `resolveAndSpawn()` consolidates the three direct call sites; honors `comingSoon` + `fallbackProviderId` (BridgeCode → Claude with `provider_effective` populated), walks `[command, ...altCommands]` on ENOENT, appends `provider.autoApproveFlag` when `autoApprove=true`, re-checks `kv['providers.showLegacy']` main-side. 9/9 unit tests pass.

* **Migration 0010 — `agent_sessions.provider_effective`** column. Idempotent ALTER TABLE inside BEGIN/COMMIT/ROLLBACK. Populated by the launcher façade on every spawn so the renderer can render "BridgeCode (using claude)" chrome.

* **Group-recipient grammar** — `expandRecipient(swarmId, recipient)` resolves `*`/`@all`/`@coordinators`/`@builders`/`@scouts`/`@reviewers` end-to-end (mailbox row + JSONL mirror + PTY fan-out). Skill-toggle producer + SideChat sends to roles now actually reach all the role's PTYs.

### Fixed

* **macOS DMG PATH-truncation** (BUG-V1.1-03-PROV) — `electron/main.ts` `bootstrapShellPath()` now spawns `${SHELL} -ilc 'printf %s "$PATH"'` once at boot on darwin and prepends shell-resolved entries to `process.env.PATH`. Providers like `claude` / `codex` / `gemini` that live under `/opt/homebrew/bin` etc. now resolve when SigmaLink is launched from Finder/dock.

* **Cross-swarm directive leak** (BUG-V1.1-02-IPC) — `setPaneEcho` closure now scopes the DB lookup by `swarmId AND agentKey`. Operator → coordinator-1 directives no longer route into a different swarm's coordinator-1 PTY when both swarms have agents with the same name.

* **Cross-pane focus auto-sync** (BUG-V1.1-04-IPC) — Bridge dispatch echoes now perform workspace-switch + room-hop + active-session jump automatically; CommandRoom listens at room level and derives `activeIndex` from `state.activeSessionId`. Toast retained as confirmation.

* **Dead-PTY writes silenced** (BUG-V1.1-12-IPC) — `controller.writeToPtys` emits a `kind:'error_report'` mailbox row when a write target is dead.

* **Playwright Node 26 race** (BUG-V1.1-DF-01-PW) — defensive: `smoke.spec.ts` hoists `test.setTimeout(240_000)` into the test body, `dogfood.spec.ts` wraps in `test.describe('dogfood-v1', …)`. Proper fix (bump @playwright/test to ≥1.60) deferred to v1.2.

### Removed

* Dead `'droid'` and `'copilot'` from `ProviderId` union — never had registry entries; renderer stub references continue to work as plain strings.

### Build

* `tsc -b` clean. `vite build` 322 KB main + 6 vendor chunks (was 311 KB pre-Phase-4-tracks-B+C; +12 KB; well under 700 KB target). `electron:compile` clean. Lint **42 errors / 10 warnings** (was 54/10 baseline; tracks contributed 0 new errors — net DECREASE).
* `mac.hardenedRuntime: true` + `entitlements: build/entitlements.mac.plist` (3 entitlements: allow-jit, allow-unsigned-executable-memory, device.audio-input). `mac.extendInfo` adds NSMicrophoneUsageDescription + NSSpeechRecognitionUsageDescription. Hardened runtime is inert without a Developer ID signing identity (we still ship unsigned), but turning it on lets future notarisation work without an electron-builder churn round.

### Deferred to v1.2

* Wake-word "Hey Sigma" (Porcupine licensing forbids bundled key; needs BYO-AccessKey UX or enterprise license).
* Native voice CI workflow + cross-arch prebuilds (`app/native/voice-mac/prebuilds/`).
* Ruflo HTTP Range / resumable downloads.
* Ruflo native deps (@ruvector/sona-*, onnxruntime-node) — installer fetches top-level tarball only in v1.1.
* Roll-call main-process aggregation + timeout (BUG-V1.1-05-IPC).
* `console-controller.stop-all` + `factory.killSwarm` consolidation (BUG-V1.1-07-IPC).
* @playwright/test ≥1.60 bump to remove the Node-26 loader race.
* Bridge Assistant `roll_call` / `broadcast` tools dual-delivery (BUG-V1.1-06-IPC).
* Five P3 IPC follow-ups + 1 P3 PROV follow-up.

## [1.0.1] - 2026-05-10

Hotfix release. Tag + push gated on explicit user authorization. Body: `docs/09-release/release-notes-1.0.1.txt`.

### Fixed

- **DMG `Cannot find module 'bindings'`** at first launch — `electron-builder.yml` now adds `bindings`, `file-uri-to-path`, `prebuild-install`, `better-sqlite3/**`, and `node-pty/**` to `asarUnpack` so the native-module resolver finds the unpacked siblings. The v1.0.0 break came from the `--config.npmRebuild=false` build-flag workaround dropping transitive deps from the asar; the YAML-side fix means future rebuilds don't need that flag.
- **Boot self-check missed `bindings` resolution failures** — `app/electron/main.ts` `checkNativeModules()` now opens `new Database(':memory:')` and spawns a 1×1 `node-pty.spawn()` (then immediately kills) so the inner `require('bindings')` actually executes during the smoke test; the diagnostic page now appears at boot rather than the renderer white-screening on first DB write.
- **macOS traffic-light overlap on Sidebar** — title-bar buttons (close/min/zoom) overlapped the `SigmaLink` wordmark + Σ monogram on top-left of the sidebar. Added a 28-px draggable spacer at the top of the sidebar on macOS so the buttons sit in their own region (`Sidebar.tsx`); spacer hidden on Win/Linux.
- **CLI agent pane text misalignment on first render** — `Terminal.tsx` no longer relies on a `requestAnimationFrame`-deferred initial `fit.fit()` (the rAF could fire before GridLayout's flex-shrink stabilized, leaving cells one column off). The `ResizeObserver` now gates `fit()` on non-zero contentRect dimensions and runs the first fit synchronously when the container measures non-zero; subsequent resizes debounce 25 ms (was 50 ms).
- **BUG-DF-02** — `app.tier` and `design.shutdown` RPC channels now have zod schemas; the boot-time soft-launch warning `2 channel(s) have no zod schema entry` no longer fires.
- **BUG-DF-01** — Browser room data-room flicker on tab focus.

### Build

- `app/electron-builder.yml` `asarUnpack` block extended; no longer requires `--config.npmRebuild=false` at build time.
- `app/scripts/build-electron.cjs` adds `lazy-val` to esbuild externals to fix a pre-existing `electron:compile` break that surfaced when rebuilding a clean tree.
- `app/package.json` version `1.0.0` → `1.0.1`.

## [1.0.0] - 2026-05-10

V3 parity release. Tag + push gated on explicit user authorization. Body: `docs/09-release/release-notes-1.0.0.txt`. Acceptance: `docs/07-test/ACCEPTANCE_REPORT_V1.md`.

### Added

Wave 10 — boot self-check + Diagnostics:

- Boot self-check detects `better-sqlite3` ABI mismatches; `NativeRebuildModal` prompts `npm rebuild`; Re-probe banner re-runs provider PATH probes; Settings → Diagnostics tab. Closes critique R3 + risk A12.

Wave 11.5 — scope freeze:

- `docs/03-plan/V3_PARITY_BACKLOG.md` (45 tickets, W12-15); surgical PRODUCT_SPEC re-baseline (C-016, §2.2/2.3/3.10/3.12/3.13/3.14, §4 V3 9-provider matrix).

Wave 12 — V3 quick-wins + infrastructure (6 parallel agents):

- Workspace launcher: 3-card picker (BridgeSpace / Swarm / Canvas-ALPHA, `⌘T`/`⌘S`/`⌘K`) + Start → Layout → Agents stepper + tile grid 1/2/4/6/8/10/12 + recents autocomplete + preset row + sidebar status dot + agent-count pill + breadcrumb `Workspace <N> / <user>`.
- Provider matrix reset: BridgeCode stub (silent Claude fallback via `agent_sessions.providerEffective`); Kimi → OpenCode model option (`ModelOption` type, per-pane status strip `<model> <effort> <speed> · <cwd>`); Aider + Continue behind `kv['providers.showLegacy']`; wizard quick-fills (Enable all / One of each / Split evenly).
- Battalion 20 preset (3/11/3/3 [INFERRED]); cap 50→20; >20-agent swarms read-only with `legacy: true`.
- Role colour CSS tokens (`--role-coordinator/-builder/-scout/-reviewer`) across all themes; `bg-role-<n>` utilities.
- Swarm wizard 5-step shell (Roster → Mission → Directory → Context → Name); CLI-agent-for-all global provider strip; per-row Auto-approve + provider override + model + count -/+ + colour stripe.
- Operator Console TopBar (TERMINALS / CHAT / ACTIVITY tabs + STOP ALL + group filters fed by `swarm:counters`).
- 17 new RPC channels + 5 events; `assistant.*` / `design.*` / `voice:state` / new `swarm:*` allowlist groups.
- 9 mailbox envelope kinds: `escalation` (promoted), `review_request`, `quiet_tick`, `error_report`, `task_brief`, `board_post`, `bridge_dispatch`, `design_dispatch`, `skill_toggle`. Recipient grammar `@all`/`@coordinators`/`@builders`/`@scouts`/`@reviewers`. Per-kind zod soft-launch schemas.
- `swarm_messages.resolvedAt` (counters); `directive.echo='pane'` (operator → PTY).
- Drizzle Kit journal; new tables `boards`, `swarm_skills`, `canvases`; new columns `swarm_agents.coordinatorId`, `swarm_agents.autoApprove`.
- `safeStorage`-backed credentials (closes A5).

Wave 13 — V3 parity sweep + Bridge Assistant (5 parallel agents):

- Right-rail dock with Browser / Editor / Bridge tabs + resizable splitter; width in `kv['rightRail.width']`. Browser recents + click-link-in-pane routing.
- Per-pane chrome variants + provider splash + footer hints; multi-pane CSS-grid 1/2/4/6/8/10/12 with per-pane drag-resize + `Cmd+Alt+<N>`.
- Constellation graph (drag/zoom; multi-hub via `coordinatorId`); ActivityFeed sidebar; structured `task_brief` render (URGENT chip + indented headings + live links).
- Per-agent boards (`boards` table + atomic markdown under `<userData>/swarms/<swarmId>/boards/...`); `board_post` envelope DB + disk in one tx.
- Operator → agent DM echo into PTY when `directive.echo === 'pane'`. Mission `@<workspaceSlug>` autocomplete. Swarm Skills 12-tile grid persists to `swarm_skills` and fires `skill_toggle`.
- **Bridge Assistant fully built**: chat panel + 4-state orb (STANDBY / LISTENING / RECEIVING / THINKING) + char-by-char streaming.
- `assistant.*` RPC: `listen`, `state` (event), `dispatch-pane`, `dispatch-bulk`, `ref-resolve`, `turn-cancel`, `tool-trace` (event).
- 10 canonical tools: `launch_pane`, `prompt_agent`, `read_files`, `open_url`, `create_task`, `create_swarm`, `create_memory`, `search_memories`, `broadcast_to_swarm`, `roll_call`. Tool tracer + cross-workspace Jump-to-pane toast + completion ding (`app/public/sounds/ding.wav`).

Wave 14 — Bridge Canvas + Editor + auto-update (3 parallel agents):

- Bridge Canvas element-picker overlay; `design:start-pick / pick-result` carry `{ selector, outerHTML, computedStyles, screenshotPng }`.
- DesignDock with captured selector + collapsible outerHTML + screenshot thumbnail + "Paste source" pill.
- Per-prompt provider chips (Claude / Codex / Gemini / OpenCode) Shift-add / Alt-remove; persists per-canvas in `canvases.lastProviders`.
- Drag-and-drop asset staging into `<userData>/canvases/<canvasId>/staging/<ulid>.<ext>`.
- Live-DOM HMR poke: `design:patch-applied` on agent file writes; `location.reload()` fallback or no-op WebSocket nudge.
- BridgeCanvas card ALPHA chip until `kv['canvas.gaSign']='1'`.
- Editor right-rail tab: Monaco lazy-loaded as 14.57 KB chunk (separate from 990 KB main); CodeMirror fallback; file tree + click-path focus + `fs.readDir`/`readFile`/`writeFile` RPC.
- Auto-update via `electron-updater@6.8.3`; opt-in behind `kv['updates.optIn']='1'`; Settings → Updates tab with Check button + last-check timestamp.
- Re-probe agents button (Settings → Providers); `NativeRebuildModal` on `better-sqlite3` ABI mismatch.

Wave 15 — voice + CI matrix + plan capabilities (4 parallel agents):

- BridgeVoice intake: title-bar pill + global `voice:state { active, source: 'mission'|'assistant'|'palette' }`. Web Speech API stub; native bindings deferred to v1.1.
- Voice into swarm mission textarea, Bridge orb tap, Command Palette (`Cmd+Shift+K`).
- `.github/workflows/e2e-matrix.yml` runs the smoke on `windows-latest` / `macos-14` / `ubuntu-latest` under Node 20; per-OS artefacts; required PR check.
- Plan-gating matrix at `app/src/main/core/plan/capabilities.ts` + `canDo(cap)`; default tier `'ultra'` (free, local-only); QA override via `kv['plan.tier']`.
- Skills marketplace stub: read-only listing from `docs/marketplace/skills.json`.

### Changed

- Roster preset rename Legion → Battalion. Preset list = Squad 5 (1/2/1/1) · Team 10 (2/5/2/1) · Platoon 15 (2/7/3/3) · Battalion 20 (3/11/3/3 [INFERRED]) · Custom 1..20. `swarms.preset` CHECK constraint accepts `'battalion'`; existing `'legion'` rows survive but new swarms reject `legion`. Supersedes original PRODUCT_SPEC C-006.
- Provider matrix 11 → 9 default. BridgeCode added; Kimi demoted to OpenCode model option; Aider + Continue hidden behind legacy toggle; Custom row renamed to "Custom Command". Supersedes original PRODUCT_SPEC C-004.
- `[Unreleased]` section reset to empty after this release cuts.
- README status table flips Phase 9 to In progress (Waves 12–16) → Shipped pending W15 CI matrix completion.

### Fixed

W12 P3 sweep — 5 P3 bugs from W7 closed:

- `BUG-W7-007` (P3) — PowerShell upgrade banner suppressed: `-NoLogo` + `POWERSHELL_UPDATECHECK=Off` for the PowerShell family in `local-pty.ts`.
- `BUG-W7-009` (P3) — Tasks sidebar icon weight: `ListChecks` → `LayoutGrid` to match `Folder`/`Globe`/`Settings` stroke profile.
- `BUG-W7-010` (P3) — Test-only folder picker: `workspacesCtl.pickFolder` bypasses `dialog.showOpenDialog` when `process.env.SIGMA_TEST` is set, reading `kv['tests.fakePickerPath']`.
- `BUG-W7-012` (P3) — Onboarding Skip flake: `complete()` dispatches `SET_ONBOARDED` synchronously; kv write fires in background; Skip button forces `pointerEvents: 'auto'`.
- `BUG-W7-014` (P3) — Browser room test-coupling: `RoomSwitch` mirrors `state.room` to `document.body.dataset.room`; smoke embeds rendered room in filename.

### Deferred

- Dogfood cycle (V3-W15-006) — needs real human GUI session; queued for v1.1.
- Native voice bindings (macOS Speech / Windows SAPI / Linux PocketSphinx); Web Speech API stub ships in v1.0.0.
- macOS notarisation + Windows code-signing certificate (R10 Partial).
- Three-way merge editor + per-line review comments in Review Room.
- Manual reverify BUG-W7-003 + BUG-W7-006 (both hold `fixed` pending fresh-kv GUI cycle).
- Real CDP-attach / shared-Chromium Browser; per-workspace cookie isolation; hard-blocking `claimDriver` lock.
- Barnes-Hut quadtree for Memory graph >500 notes; token-overlap `suggest_connections`; real-time `memory:changed` IPC.
- Cloud sync, accounts, billing, SSH remote workspaces, ticketing integrations, mobile clients — out of scope for v1.
- Bernstein-style verifier loops (PRODUCT_SPEC C-008); multi-window concurrency (A11); telemetry (A16).

### Known issues

- Local Playwright `_electron` smoke gated on Node 26 + npm 11 install bug; W15 CI matrix on Node 20 is canonical.
- Lint at 80 errors / 3 warnings, nearly all in `_legacy/` archive code.
- BUG-W7-015 (P3) — Parchment "Launch N agents" CTA contrast nit (open).
- BUG-W7-000 (P0) — Electron node_modules install bug; bypassed by Node 20 CI matrix; tracked for v1.1.

Tagged and released: 2026-05-10.

## [0.1.0-alpha] - 2026-05-09

### Added

- Phase 1 foundation: Electron + Vite + React 19 + Tailwind 3 + shadcn UI shell with the Workspace launcher and Command Room rooms wired up.
- Provider registry of eleven CLI agents (Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Droid, Copilot, Aider, Continue, custom shell) with a PATH probe and install hints.
- Real PTY-backed terminal panes via `node-pty` and `@xterm/xterm`, with a ring-buffered history flushed to SQLite for cross-restart replay.
- Per-pane Git worktree pool under the Electron user-data directory, with branch namespace `sigmalink/<role>/<task>-<8char>`.
- SQLite persistence with Drizzle ORM and `better-sqlite3`; tables for `workspaces`, `agent_sessions`, `swarms`, `swarm_agents`, `swarm_messages`, `browser_tabs`, `skills`, `skill_provider_state`, `memories`, `memory_links`, `memory_tags`, `tasks`, `task_comments`, `session_review`, `kv`.
- Boot janitor that flips zombie `agent_sessions`/`swarms` rows on startup and best-effort `git worktree prune`s known repo roots.
- Cross-platform PTY plumbing: PATH+PATHEXT resolver routes `.cmd`/`.bat`/`.ps1` shims through their interpreters; default-shell preference order pwsh → powershell → cmd on Windows.
- Phase 2 Swarm Room: roster grid + side chat + recipient picker; `SIGMA::` line protocol with `SAY`/`ACK`/`STATUS`/`DONE`/`OPERATOR`/`ROLLCALL`/`SYSTEM` verbs; SQLite-backed `SwarmMailbox` with single-writer queue and JSONL debug mirrors; presets Squad/Team/Platoon/Legion with `defaultRoster()`.
- Phase 3 Browser Room: in-app `WebContentsView` per tab, address bar with URL normalization, tab strip, persisted `browser_tabs`; per-workspace Playwright MCP supervisor (`@playwright/mcp` over `npx -y`) with port discovery and 3-restart back-off; `claimDriver`/`releaseDriver` advisory lock with agent-driving overlay; per-provider MCP config writer (`.mcp.json`, `~/.codex/config.toml`, `~/.gemini/extensions/sigmalink-browser/`).
- Phase 4 Skills Room: drag-and-drop SKILL.md ingestion with frontmatter validation, deterministic per-folder content hash, atomic stage-then-rename to managed `<userData>/skills/<name>/`; per-provider fan-out to `~/.claude/skills/`, `~/.codex/skills/`, and synthesized Gemini extension manifests; per-provider toggle state and detail modal with built-in Markdown preview.
- Phase 5 Memory Room (SigmaMemory): wikilink notes stored as `<workspace>/.sigmamemory/<name>.md`; `memories`/`memory_links`/`memory_tags` schema with cascade deletes; in-memory inverted index; force-directed graph canvas (hand-rolled); in-process `sigmamemory` MCP server bundled as `electron-dist/mcp-memory-server.cjs` exposing 12 tools (`list_memories`, `read_memory`, `create_memory`, `update_memory`, `append_to_memory`, `delete_memory`, `search_memories`, `find_backlinks`, `list_orphans`, `suggest_connections`, `init_hub`, `hub_status`); per-workspace MCP supervisor with 3-restart linear back-off; combined browser+memory MCP entries written into provider configs.
- Phase 6 Review Room: session list with multi-select; unified/split diff renderer (no new deps); Tests/Notes/Conflicts tabs; `git merge-tree` conflict prediction with name-only intersection fallback; `commitAndMerge` + `batchCommitAndMerge` with worktree teardown; `dropChanges` and `pruneOrphans`.
- Phase 6 Tasks Room: 5-column Kanban (Backlog / In Progress / In Review / Done / Archived); `@dnd-kit/*` drag-and-drop card moves; swarm-roster drop rail that writes a `SAY` envelope `SIGMA::TASK <title>` into the assigned agent's mailbox; per-task comment thread.
- Phase 7 UI polish: four built-in themes (Obsidian, Parchment, Nord, Synthwave) driven by `:root[data-theme=...]` HSL tokens; first-run onboarding modal (welcome → detect agents → pick workspace); cmdk command palette bound to Cmd/Ctrl+K with nav, recent workspaces, theme switching, kill-all-PTY, ingest-skill, new-memory-note actions; sidebar with Σ monogram, manual + auto-collapse below 1100px, Radix tooltips on disabled rooms; universal `EmptyState` and `ErrorBanner` components; CSS-only motion (`sl-fade-in`, `sl-slide-up`, `sl-pane-enter`).
- Phase 8 visual test loop: `app/tests/e2e/smoke.spec.ts` Playwright `_electron` driver; 37-step visual sweep with screenshots committed to `docs/07-test/screenshots/` and machine-readable summary at `docs/07-test/visual-summary.json` / `visual-summary-acceptance.json`.
- IPC channel + event allowlists in `app/src/shared/rpc-channels.ts`; preload exposes a single generic `invoke` against the allowlist; renderer uses a typed Proxy bridge.
- Graceful shutdown on `before-quit`: `pty.killAll()`, MCP supervisor stops, `wal_checkpoint(TRUNCATE)`, DB close.
- Global RPC error toaster: any `{ok:false}` envelope from the preload bridge surfaces as a sonner toast; `rpcSilent` proxy for opt-out paths.

### Fixed

Phase 1.5 (Wave 5 — foundation patches):

- `P0-PTY-WIN-CMD` — Windows `.cmd`/`.bat`/`.ps1` shims now route through their interpreters via the PATH+PATHEXT resolver (`app/src/main/core/pty/local-pty.ts`).
- `P1-PROBE-EXEC-WIN` — provider `--version` probe uses the same resolver.
- `P1-PROBE-CMD-NOT-USED` — resolved `.cmd` path now used at spawn time.
- `P1-WORKTREE-LEAK` — launcher rolls back the worktree on PTY birth failure.
- `P1-PTY-FAILURE-NOT-DETECTED` — synthetic-exit path flips early-death panes to `status='error'` with surfaced text.
- `P1-DB-EXIT-DUPLICATE-LISTENER` — exit handler attached once per session.
- `P1-PTY-REGISTRY-LEAK` — graceful-exit `forget()` clears registry + listeners after a 200ms drain window; `killAll()` on `before-quit`.
- `P1-NO-CLOSE-PANE` — close button per pane + `REMOVE_SESSION` reducer action with auto-remove after 5s exit.
- `P1-INITIAL-PROMPT-DOUBLE` — initial prompt is now a single source-of-truth in the launcher.
- `P1-WORKTREE-PATH-COLLISION` — 8-char CSPRNG branch suffix + `fs.existsSync` retry.
- `P1-RUN-SHELL-TOKENISER` — state-machine tokenizer handles single/double quote escapes and concatenation.
- `P1-RUN-SHELL-EXEC-WIN` — `runShellLine` resolves Windows shims via the same PATH+PATHEXT helper.
- `P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST` — preload now rejects any invoke not in `CHANNELS`.
- `P1-DB-NEVER-CLOSED` — SQLite handle + WAL flushed on `before-quit`.
- `P2-PTY-CWD-NOT-VALIDATED` — cwd validated before spawn.
- `P2-EVENT-PAYLOAD-CASTING` — renderer guards on PTY data/exit payloads.
- `P2-RESIZE-DEBOUNCE` — terminal fit debounced on resize.
- `P2-TERMINAL-FIT-DURING-OPEN` — initial fit deferred until xterm finishes mounting.
- `P2-RPC-ERROR-STACK-LOST` — `RpcResult.stack?` carried through dev-only.

Wave 8 — visual-sweep bug-fix pass:

- `BUG-W7-001` (P1) — `workspaces.open` now activates the workspace; Launcher.tsx + state.tsx reducer aligned.
- `BUG-W7-005` (P1) — global sonner toaster on the renderer root surfaces every unhandled RPC rejection.
- `BUG-W7-006` (P1) — `wal_checkpoint(PASSIVE)` in `openWorkspace` so subsequent `workspaces.list` always sees the row; `swarms.create` returns a clearer error.
- `BUG-W7-002` (P2) — disabled sidebar buttons use `tabIndex={-1}`, no focus ring, Radix tooltip "Open a workspace to enable".
- `BUG-W7-003` (P2) — `ThemeProvider` validates kv via `isThemeId`; AppearanceTab gained "Reset to default" button.
- `BUG-W7-004` (P2) — sidebar tokens audited across all four themes; bg-sidebar resolves through `--sidebar-background`.
- `BUG-W7-008` (P2) — Tasks drawers gated on `state.room === 'tasks'`; cannot leak across rooms.
- `BUG-W7-011` (P2) — Launcher derives selection from `state.activeWorkspace`; single source of truth.
- `BUG-W7-013` (P2) — disabled-room rationale surfaced via the W7-002 tooltip.

### Deferred

- `P1-IPC-EVENT-RACE-CROSSWINDOW` — single-window product today; broadcast pattern only over-amplifies IPC under multiple BrowserWindows. Functional, not load-blocking.
- `P1-DRIZZLE-DEFAULT-OVERRIDE` — cosmetic clock-skew sub-second; no functional impact.
- Skills zip ingestion — would require a new dep (`adm-zip`/`unzipper`); controller surface and channel allowlist are wired and `ingestZip` throws a clear "drop the unzipped folder" error.
- `react-markdown` for SKILL.md preview — built a 60-line in-house renderer instead.
- Codex `allowed-tools` translation in Skills fan-out — `fm.allowedTools` is preserved verbatim; translation deferred.
- Project-scoped skills — v1 ships user-global skills only.
- Real CDP-attach / shared-Chromium for the Browser Room — v1 ships separate-Chromium mode behind the Playwright MCP supervisor.
- Per-workspace cookie/session isolation in the Browser Room — schema leaves room for `persist:ws-<id>` partitions.
- Hard-blocking lock on `claimDriver` — v1 surfaces the lock visually only.
- O(n²) repulsion in the Memory graph — Barnes-Hut quadtree deferred until workspaces routinely exceed 500 notes.
- Token-overlap variant of `suggest_connections` — current heuristic is co-tag overlap.
- Real-time `memory:changed` IPC from the spawned MCP child back to the GUI — GUI re-fetches on focus today.
- Three-way merge conflict editor and per-line review comments in the Review Room.
- `<Toaster>`-as-ack-channel for command-palette actions (only error toasts wired today).
- Cloud sync, account systems, billing, SSH remote workspaces, ticketing integrations (Linear/Jira/GitHub Issues), voice assistant, mobile clients — all out of scope for v1.
- Bernstein-style verifier loops on top of the swarm dispatcher — see PRODUCT_SPEC C-008.

### Known issues

- `BUG-W7-007` (P3) — PowerShell upgrade banner clutters every fresh shell pane; `POWERSHELL_UPDATECHECK=Off` not yet plumbed.
- `BUG-W7-009` (P3) — Tasks sidebar icon stroke weight inconsistent with siblings.
- `BUG-W7-010` (P3) — Test-only: native folder picker can't be scripted from Playwright; smoke harness substitutes `workspaces.open` and parses the raw envelope.
- `BUG-W7-012` (P3) — Onboarding Skip click occasionally drops mid-fade-in.
- `BUG-W7-014` (P3) — Browser room not reachable in test sweep when no workspace is activated; coupled to `BUG-W7-001` (now verified) but the test harness path remains.
- `BUG-W7-015` (P3) — Parchment "Launch N agents" CTA contrast nit.

[Unreleased]: https://github.com/s1gmamale1/SigmaLink/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/s1gmamale1/SigmaLink/compare/v0.1.0-alpha...v1.0.0
[0.1.0-alpha]: https://github.com/s1gmamale1/SigmaLink/releases/tag/v0.1.0-alpha
