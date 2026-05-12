# SigmaLink Desktop App

The Electron + Vite + React workspace inside `app/` is the SigmaLink desktop application. This directory holds everything that ships in the installer: the Electron main and preload sources under `electron/`, the renderer under `src/`, the build helpers under `scripts/`, and the `electron-builder` config in `electron-builder.yml`. The repository-level [README](../README.md) explains what SigmaLink is and where it is going; this README is the operational reference for working in this directory.

## End-user install (macOS Apple Silicon)

For installing a pre-built release on a target Mac (not for building from source), use the one-line installer from any Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash
```

The installer downloads the latest release via `curl` (which doesn't tag downloads with `com.apple.quarantine`), so the app installs into `/Applications` without triggering any macOS Gatekeeper "unverified developer" prompts. Source: [`scripts/install-macos.sh`](scripts/install-macos.sh) — POSIX Bash, 170 lines, no external dependencies beyond `curl` + `hdiutil` + `osascript`. Three install paths are documented in the repository-level [README](../README.md#install-options).

## End-user install (Windows 10/11 x64)

From any PowerShell prompt (admin or user — installer prompts for elevation only if the target dir requires it):

```powershell
iex (irm https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-windows.ps1)
```

Source: [`scripts/install-windows.ps1`](scripts/install-windows.ps1) — 234 lines (~180 LOC), zero external dependencies beyond PowerShell 5+ + `Invoke-RestMethod`. It detects AMD64, fetches the latest release tag (or a pinned tag via `-Version v1.2.0`), downloads `SigmaLink-Setup-<version>.exe` to `$env:TEMP`, calls `Unblock-File` to strip the Mark-of-the-Web tag before launch (this avoids the most common SmartScreen path), and runs the NSIS installer. Pass `-Quiet` to forward `/S` to NSIS, `-KeepInstaller` to retain the EXE after install.

The installer surfaces a 72-line `README — First launch.txt` welcome page during install ([`build/nsis/README — First launch.txt`](build/nsis/README%20%E2%80%94%20First%20launch.txt)) that documents the two SmartScreen recoveries available to users who download the EXE manually instead of via the PowerShell one-liner. Code-signing is deferred — see [`../docs/04-design/windows-port.md`](../docs/04-design/windows-port.md) for the full design and trade-off analysis.

## Windows: building locally

`pnpm electron:pack:win` produces an NSIS-style EXE in `dist-electron/`. On a non-Windows host the bundled `electron-builder` rebuilds native modules (`node-pty`, `better-sqlite3`) against the local Electron version but skips the Windows-specific code signing step. For a clean CI-equivalent x64 build, push a tag matching `v*` and let [`.github/workflows/release-windows.yml`](../.github/workflows/release-windows.yml) build on a `windows-latest` runner and upload to the GitHub Release.

```bash
pnpm electron:pack:win
# Output: dist-electron/SigmaLink-Setup-<version>.exe (NSIS, ~120-140 MB)
```

## Scripts

The scripts below are defined in [`package.json`](package.json) and are the entry points the project uses for development, packaging, and CI.

| Command | What it does |
|---|---|
| `npm run dev` | Run Vite alone against the renderer. Useful only when you do not need Electron. |
| `npm run build` | `tsc -b` then `vite build` — type-checks the workspace and produces the renderer bundle in `dist/`. |
| `npm run lint` | Run ESLint over the renderer and main process. |
| `npm run preview` | `vite preview` of the last renderer build. |
| `npm run electron:dev` | Full dev loop: builds the renderer, bundles `electron/main.ts` + `electron/preload.ts` via esbuild into `electron-dist/`, then launches Electron. This is the script you run day-to-day. |
| `npm run electron:build` | Production package: build, esbuild bundle, then `electron-builder` produces installers. |
| `npm run electron:compile` | esbuild bundle of `electron/main.ts` + `electron/preload.ts` only. |
| `npm run electron:pack:win` | `electron-builder --win`, after a renderer rebuild. |
| `npm run electron:pack:mac` | `electron-builder --mac`, after a renderer rebuild. |
| `npm run electron:pack:all` | `electron-builder --win --mac`, after a renderer rebuild. |
| `npm run postinstall` | Runs automatically after `npm install`; calls `electron-builder install-app-deps` to rebuild `node-pty` and `better-sqlite3` against the local Electron version. |
| `npm run product:check` | `build` + `electron:compile`. The pre-PR check. |

## Dev workflow

```bash
npm install
npm run electron:dev
```

`npm install` triggers `electron-builder install-app-deps`, which rebuilds the native modules (`node-pty` and `better-sqlite3`) against Electron 30. If a native module fails to load when Electron starts, run `npm install` again from a clean tree.

## Build pipeline

The build is split across three tools, with a fourth `afterSign` hook on macOS:

1. **esbuild** — bundles `electron/main.ts` and `electron/preload.ts` into `electron-dist/`. Driven by `scripts/build-electron.cjs` and exposed via `npm run electron:compile`.
2. **Vite** — builds the renderer (React 19 + Tailwind 3 + shadcn UI + xterm.js) into `dist/`. Driven by `npm run build`.
3. **electron-builder** — consumes both outputs and produces installers. Configuration lives in [`electron-builder.yml`](electron-builder.yml). Targets: macOS (DMG + zip), Windows (NSIS + portable), Linux (AppImage + deb).
4. **`scripts/adhoc-sign.cjs`** — `afterSign` hook for macOS only. Runs `codesign --force --deep --sign - --timestamp=none` over the packaged `.app` to write a proper `_CodeSignature/CodeResources` resource seal (electron-builder's auto-discovery doesn't produce a real seal without a paid Developer ID). Then runs `codesign --verify --deep --strict` and throws if verification fails — silent ship-with-broken-sig regressions are impossible.

The `npm run electron:dev` and `npm run electron:build` scripts run these steps in order, so you rarely invoke any of them by hand. Once a paid Apple Developer ID is available, drop `adhoc-sign.cjs` and flip `electron-builder.yml` mac block to `identity: <cert CN>`, `hardenedRuntime: true`, `notarize: true`.

## Source layout

The renderer and main process are organised by feature area, not by layer.

### `src/main/`

- `lib/` — shared utilities used across the main process.
- `core/db/` — Drizzle ORM schema, migrations, and the better-sqlite3 setup.
- `core/pty/` — ring-buffered PTY plumbing built on `node-pty`.
- `core/git/` — worktree pool, commit and merge ops, status and diff helpers.
- `core/providers/` — provider registry, PATH probe, and version detection.
- `core/workspaces/` — workspace factory and launcher presets.

### `src/renderer/`

- `app/` — root `App.tsx`, router, and theme setup.
- `features/` — one folder per room: `workspace-launcher/`, `command-room/`, `swarm-room/`, `review-room/`, `memory/`, `browser/`, `skills/`, `tasks/`, `command-palette/`, `settings/`.
- `lib/` — renderer-side utilities and the typed RPC client.
- `components/ui/` — the shadcn UI starter set (50+ components) seeded under here.
- `hooks/` — shared React hooks.
- `shared/` — types and schemas shared across renderer and main (RPC contracts, providers, swarm protocol, MCP catalog).

## Key dependencies

- `@xterm/xterm` and `@xterm/addon-fit` — terminal renderer.
- `node-pty` — native PTY in the main process.
- `drizzle-orm` and `better-sqlite3` — SQLite persistence layer.
- `esbuild` — bundles the Electron main and preload.
- `react-resizable-panels` — terminal grid layout primitives.
- `@dnd-kit/core` and `@dnd-kit/sortable` — drag-and-drop for the Kanban board and skill drop zone.

## Distribution

| Surface | Source of truth |
|---|---|
| macOS one-line installer | [`scripts/install-macos.sh`](scripts/install-macos.sh). POSIX Bash, downloads via `curl` (no quarantine), installs into `/Applications`, zero Gatekeeper prompts. |
| Windows one-line installer | [`scripts/install-windows.ps1`](scripts/install-windows.ps1). PowerShell 5+, downloads `SigmaLink-Setup-*.exe` to `$env:TEMP`, runs `Unblock-File` to strip MOTW, then launches the NSIS installer. Parity with the macOS curl-bash flow. |
| Windows 10/11 x64 NSIS EXE | Built by [`../.github/workflows/release-windows.yml`](../.github/workflows/release-windows.yml) on every `v*` tag push (also `workflow_dispatch`). NSIS targets `x64` only (ia32 dropped in v1.2.0). Unsigned (no EV/OV cert); SmartScreen workarounds documented in the in-installer welcome page. |
| In-DMG README | [`build/dmg/README — Open SigmaLink.txt`](build/dmg/README%20%E2%80%94%20Open%20SigmaLink.txt). Shown next to `SigmaLink.app` when the DMG mounts — covers the Terminal `xattr -cr` and System Settings → Privacy & Security workarounds for browser-downloaded DMGs. |
| In-NSIS README | [`build/nsis/README — First launch.txt`](build/nsis/README%20%E2%80%94%20First%20launch.txt). 72-line welcome page surfaced via `nsis.license` during install — covers the two SmartScreen recoveries (Option A: **More info → Run anyway**; Option B: right-click → **Properties → Unblock**). |
| Code signing (macOS) | [`scripts/adhoc-sign.cjs`](scripts/adhoc-sign.cjs) — `afterSign` hook ad-hoc signs every Mach-O + writes a real `_CodeSignature/CodeResources` seal. Without it, DMG launches surface as "is damaged". |
| Code signing (Windows) | None. Unsigned EXE. Mark-of-the-Web stripped via `Unblock-File` in the PowerShell installer. EV cert deferred — see [`../docs/04-design/windows-port.md`](../docs/04-design/windows-port.md). |
| Release notes | [`../docs/09-release/`](../docs/09-release/) — per-tag narrative; see `release-notes-1.1.7.txt` for the curl-bash rationale and `release-notes-1.2.0.txt` for the Windows port. |

## Known limitation

The historic Windows `.cmd` shim spawn bug ("Cannot create process, error code: 2") was resolved in v1.1.x — see [`../docs/01-investigation/01-known-bug-windows-pty.md`](../docs/01-investigation/01-known-bug-windows-pty.md) for the full investigation and the patch landing record. Voice capture on Windows currently routes through the Chromium Web Speech API (requires internet); a native SAPI5 binding is deferred to v1.3+. The full Windows-port design including all platform trade-offs lives at [`../docs/04-design/windows-port.md`](../docs/04-design/windows-port.md).
