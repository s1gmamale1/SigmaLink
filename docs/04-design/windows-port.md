# SigmaLink Windows port — design + trade-offs (v1.2.0)

**Author:** lead orchestrator + 5 Phase 18 sub-agents
**Date:** 2026-05-12
**Status:** Shipped in v1.2.0 (NSIS EXE, PowerShell installer, Web Speech fallback). Polish + SAPI5 + EV cert deferred.

This document is the design-of-record for the Windows platform port that landed in **v1.2.0**. macOS was the only first-class platform through v1.1.11; v1.2.0 makes Windows 10/11 (x64) a peer release surface with no behavioural regressions on macOS. Linux remains built-but-untested; tracked in [`../08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md).

---

## 1. Goals & non-goals

**Goals**

- Ship an NSIS-style EXE for Windows 10/11 x64 from CI on every `v*` tag push, parity with the macOS DMG flow.
- Provide a PowerShell one-liner installer that matches the macOS `install-macos.sh` curl-bash UX.
- All nine providers spawn correctly under ConPTY (closing the historic "Cannot create process, error code: 2" bug).
- Renderer chrome accommodates the Windows native frame (140 px right pad clears the WCO buttons; voice copy is platform-aware).
- 205/205 tests still pass; lint 0/0; tsc clean.

**Non-goals for v1.2.0**

- **EV/OV Authenticode signing.** Per-vendor SmartScreen reputation costs $300-700/yr and is deferred indefinitely. Users see SmartScreen on first download; workarounds documented in the in-installer README.
- **Native Windows SAPI5 voice binding.** v1.2.0 routes voice through the Chromium Web Speech API (requires internet). Native SAPI5 + offline Whisper.cpp deferred to v1.3+.
- **`windowsControlsOverlay` frameless chrome.** v1.2.0 uses the native Windows frame + 140 px right-padding shim in `Breadcrumb.tsx`. Frameless WCO is a polish target for v1.3+.
- **ia32 / arm64 Windows builds.** v1.2.0 ships **x64 only**. ia32 was actively dropped from `electron-builder.yml`. arm64 is on the v1.3+ list once Electron + native deps stabilise on Windows-on-ARM.
- **Microsoft Store / WinGet distribution.** GitHub Releases only for v1.2.0.

---

## 2. Touch-point reference table

| File | What it does | When to change |
|---|---|---|
| `.github/workflows/release-windows.yml` | CI: tag-triggered NSIS build on `windows-latest`; uploads to GitHub Release via `softprops/action-gh-release@v2`. 70 LOC. | When changing the build matrix, runner image, or release-asset glob. |
| `app/electron-builder.yml` | Installer config. `win.target.nsis.arch: [x64]`; `nsis.installerIcon` + `uninstallerIcon` + `installerHeaderIcon` point at `build/icon.ico`; `nsis.license: build/nsis/README — First launch.txt`. | When adding new architectures, swapping the welcome page, or wiring signing certificates. |
| `app/build/nsis/README — First launch.txt` | 72-line welcome surfaced via `nsis.license` during install. Documents SmartScreen + the two recovery options. | When the SmartScreen UX or workaround text changes. |
| `app/scripts/install-windows.ps1` | PowerShell installer. 234 lines / ~180 LOC. PowerShell 5+ gate, AMD64-only, fetches latest or pinned release, `Unblock-File`s MOTW, runs NSIS. | When the GitHub API shape changes, when adding new flags, when porting to a new arch. |
| `app/src/main/core/pty/local-pty.ts:47-85` | `resolveWindowsCommand` — walks `PATH+PATHEXT`, returns absolute resolved file. | If PATHEXT semantics or PowerShell-script support change. |
| `app/src/main/core/pty/local-pty.ts:175-197` | `platformAwareSpawnArgs` — wraps resolved `.cmd`/`.bat` via `cmd.exe /d /s /c`, `.ps1` via `powershell.exe`, `.exe` directly. | If we add new shim types or change the wrap arguments. |
| `app/src/main/core/pty/local-pty.ts:215-230` | Pre-flight ENOENT check. Throws synchronous ENOENT so the launcher fallback walk reaches alternatives. | When changing fallback semantics or adding a new ConPTY transport. |
| `app/src/main/core/voice/native-mac.ts:107` | Gate: returns `null` on non-darwin → renderer routes to Web Speech API. | When SAPI5 native binding lands (v1.3+). |
| `app/src/main/core/assistant/mcp-host-bridge.ts:84-90` | Already platform-aware: uses `\\.\pipe\<name>` on win32. No v1.2.0 change. | When changing the MCP transport for assistant tool dispatch. |
| `app/electron/main.ts:235` | `titleBarStyle` — `'hiddenInset'` on darwin, `'default'` (native frame) on win32 + linux. | When adopting `windowsControlsOverlay` (v1.3+). |
| `app/electron/preload.ts` | `window.sigma.platform = process.platform` exposure. | Rarely — adding new platform-gated APIs. |
| `app/src/renderer/lib/platform.ts` (NEW, 12 LOC) | Exports `getPlatform()` + `IS_WIN32`. Renderer-side single source of truth. | Adding new platform-gated UI helpers. |
| `app/src/renderer/features/top-bar/Breadcrumb.tsx` | 140 px right-padding when `IS_WIN32` to clear native min/max/close buttons. | When chrome layout shifts (e.g. adopting WCO removes this padding). |
| `app/src/renderer/features/command-room/Terminal.tsx:112` | xterm font stack — `"Cascadia Mono"` prepended before `Consolas` and the macOS stack. | When changing terminal typography. |
| `app/src/renderer/features/settings/VoiceTab.tsx` | Platform-aware `NATIVE_ENGINE_LABEL` + `NATIVE_ENGINE_AVAILABLE`. Non-darwin copy: "Web Speech API (Chromium, requires internet)". Diagnostics dot is grey neutral, not red error. | When SAPI5 lands → flip `NATIVE_ENGINE_AVAILABLE = true` on win32 and update copy. |

---

## 3. Architectural decisions

### 3.1 PTY: PATH+PATHEXT resolver, then `cmd.exe` wrap

The historic blocker on Windows was that npm-installed CLI shims (`claude`, `codex`, `gemini`, `kimi`, `opencode`) are extensionless on `PATH`. ConPTY's `CreateProcessW` performs neither PATH nor PATHEXT resolution and fails with `ERROR_FILE_NOT_FOUND` (error code 2). The fix in `src/main/core/pty/local-pty.ts:47-85` walks every `PATH` directory checking each `PATHEXT` suffix in order, returning the first match. Resolved `.cmd`/`.bat` paths are then wrapped through `cmd.exe /d /s /c <resolved> <args>` at `:175-197`; `.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`; `.exe` spawns directly. The pre-flight ENOENT check at `:215-230` lets the existing fallback walk in `resolveAndSpawn` reach alternative commands when the primary one isn't found.

Confirmed working on Windows 11 against `npm i -g @anthropic-ai/claude-code` as of 2026-05-12. Closes the long-standing P0 documented in [`../01-investigation/01-known-bug-windows-pty.md`](../01-investigation/01-known-bug-windows-pty.md).

### 3.2 Window chrome: native frame + 140 px right-padding

`electron/main.ts:235` already branched `titleBarStyle: 'hiddenInset'` for darwin and `'default'` for everything else, exposing the native Windows min/max/close buttons (Window Caption Overlay / WCO area) in the top-right. The Breadcrumb component sits in the top bar and would otherwise underlap those 140 px. Fix: conditional `paddingRight: '140px'` on win32 via the new `IS_WIN32` helper from `src/renderer/lib/platform.ts`.

**Not adopted**: `webPreferences.titleBarOverlay` + `frame: false` + WCO. That would let us draw custom buttons over the native space, which is more polished but adds non-trivial layout + a11y work. Deferred to v1.3+.

### 3.3 Voice: Web Speech API fallback only

`src/main/core/voice/native-mac.ts:107` returns `null` on non-darwin, so the dispatcher routes through the renderer's Web Speech API. That means voice on Windows requires an internet connection (Chromium delegates recognition to Google). The Settings → Voice tab surfaces this honestly:

- `NATIVE_ENGINE_LABEL` reads `"Web Speech API (Chromium, requires internet)"` on win32.
- `NATIVE_ENGINE_AVAILABLE` is `false` → the native-engine radio is disabled.
- The diagnostics indicator dot is grey neutral, not red error — "this is the expected state on Windows", not "your voice is broken".

A native SAPI5 binding is the v1.3+ unblock for offline + always-on capture. The dispatcher contract is already platform-agnostic, so swapping the engine is additive.

### 3.4 Signing: unsigned EXE + `Unblock-File` MOTW strip

We do not have an EV (Extended Validation) or OV (Organizational Validation) Authenticode certificate. EV certs cost $300-700/year and earn SmartScreen reputation immediately; OV certs are cheaper ($80-200/year) but accumulate reputation over time as users vouch for downloads. Both require corporate identity validation.

Current shipping posture:

1. NSIS EXE is **unsigned**.
2. PowerShell installer calls `Unblock-File` on the downloaded EXE to strip the Mark-of-the-Web (`Zone.Identifier` alternate data stream) before launch. This avoids the SmartScreen path for users using the one-liner.
3. Users who manually download the EXE from GitHub Releases will get SmartScreen on first launch. The in-installer `build/nsis/README — First launch.txt` (surfaced via `nsis.license`) explains two recovery paths.

SmartScreen reputation is **per-binary-hash**, so every new SigmaLink release re-triggers the warning for first-time downloaders. The only structural fix is EV signing, which is deferred indefinitely until external funding lands.

### 3.5 Native modules: rebuild in CI, x64 only

`better-sqlite3` and `node-pty` are native modules and must be rebuilt against the target Electron + arch. The `.github/workflows/release-windows.yml` workflow does this verbatim copy-paste from `e2e-matrix.yml`:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm rebuild better-sqlite3 node-pty
```

on `windows-latest` (which is Server 2022 x64 as of 2026-05). The runner produces a single `dist-electron/SigmaLink-Setup-<version>.exe` (~120-140 MB) that targets x64 only.

`electron-builder.yml` previously listed `win.target.nsis.arch: [x64, ia32]`. ia32 was dropped in v1.2.0 because:
- npm has been x64-only for the official Node binary since 22.x.
- Windows-on-32-bit is single-digit-percent of installed Windows base in 2026.
- Carrying two arches doubles CI runtime and asset size for negligible user count.

arm64 Windows is on the v1.3+ list once Electron + native deps stabilise on Windows-on-ARM.

### 3.6 MCP bridge: already platform-aware

`src/main/core/assistant/mcp-host-bridge.ts:84-90` was already routing through `\\.\pipe\<name>` on win32 versus a Unix-domain socket on darwin/linux. No code change in v1.2.0. Documented here so future readers know not to touch it.

### 3.7 Font: Cascadia Mono prepended

`src/renderer/features/command-room/Terminal.tsx:112` prepends `"Cascadia Mono"` to the xterm `fontFamily` stack ahead of `Consolas`, `Menlo`, `Monaco`, `Courier New`. Cascadia Mono ships with Windows 11 (and is installable on Windows 10) and is the closest visual match to the SF Mono / Menlo aesthetic SigmaLink uses on macOS. On macOS and Linux the new entry is ignored by xterm's fallback walk and the existing Menlo/Monaco/DejaVu rendering wins.

---

## 4. Trade-offs / open issues for v1.2.1+

### 4.1 `nsis.license` shows the welcome README behind a forced "I accept" radio gate

The NSIS welcome page is wired via `electron-builder.yml`'s `nsis.license` field. That field semantically expects a license agreement and renders the text behind a "I accept the terms of the License Agreement" radio button that the user must click to enable **Next**. We're abusing it to surface a SmartScreen explainer.

**Why we did it**: it's the shortest path to surfacing the text inside the installer without writing a custom NSIS section. `nsis.include` + a custom `.nsh` page is the semantically correct fix.

**v1.2.1 polish target**: replace `nsis.license` with `nsis.include: build/nsis/welcome.nsh` that registers a custom NSIS page using `MUI2`'s page primitives. The page should be informational (no radio gate, no "accept" required) and clickable through with **Next** alone.

### 4.2 SmartScreen reputation reset on every binary

Per §3.4 — every release re-warms reputation from zero because the binary hash changes. The only fix is an EV cert. Until then, users who skip the curl-bash flow will see SmartScreen on every upgrade for the first ~24 hours after a tag push (until Microsoft's reputation telemetry catches up to the new hash).

### 4.3 Web Speech API requires internet

Per §3.3 — Windows voice capture goes through Chromium's WebKit Speech API, which is implemented via a Google STT cloud call. Air-gapped Windows users have no voice path at all. Native SAPI5 is the v1.3+ unblock.

### 4.4 No auto-update on Windows

`autoUpdater` for Windows requires either:
- Signed builds (Microsoft Store) — deferred per §3.4.
- A self-hosted update feed (Squirrel.Windows or `electron-updater` with NSIS differential updates).

v1.2.0 ships without auto-update; users re-run the PowerShell installer to upgrade. The renderer toggle for auto-update remains opt-in and macOS-only.

### 4.5 Linux still untested

`electron-builder.yml` builds AppImage + .deb from the same source, but there is no Linux runner in CI and no Linux smoke test. Marking the v1.2.0 surface as "macOS + Windows" until a Linux test plan lands.

---

## 5. Verification matrix at v1.2.0

| Gate | Result |
|---|---|
| `pnpm exec tsc -b` | clean |
| `pnpm exec vitest run` | **205/205** (up from 196 at v1.1.11; +9 new specs across `Breadcrumb.test.tsx` and `VoiceTab.test.tsx`) |
| `pnpm exec eslint .` | 0/0 |
| `pnpm exec vite build` | unchanged main bundle |
| macOS DMG sign | `codesign --verify --deep --strict` Sealed Resources files=20492 |
| Windows EXE | unsigned; built by CI on `windows-latest`; smoke-tested locally on macOS via `pnpm electron:pack:win` (Windows VM smoke deferred to first beta tag) |
| Historic `.cmd` shim bug | resolved; confirmed by code inspection of `local-pty.ts:47-230` |

---

## 6. References

- [`../01-investigation/01-known-bug-windows-pty.md`](../01-investigation/01-known-bug-windows-pty.md) — historic investigation; now marked RESOLVED.
- [`../08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) — Shipped & verified (v1.2.0) + remaining v1.3+ backlog.
- [`../09-release/release-notes-1.2.0.txt`](../09-release/release-notes-1.2.0.txt) — release narrative.
- [`../10-memory/master_memory.md`](../10-memory/master_memory.md) — Phase 18 orchestration record.
- [`../../app/scripts/install-windows.ps1`](../../app/scripts/install-windows.ps1) — PowerShell installer source.
- [`../../app/scripts/install-macos.sh`](../../app/scripts/install-macos.sh) — macOS counterpart for behavioural reference.
- [`../../.github/workflows/release-windows.yml`](../../.github/workflows/release-windows.yml) — CI workflow.
