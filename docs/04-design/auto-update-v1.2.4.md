# Auto-Update Architecture v1.2.4

## Overview

v1.2.4 ships a platform-aware auto-update path that works **without code-signing certificates**.

| Platform | Mechanism | User action |
|----------|-----------|-------------|
| Windows | `electron-updater` NSIS auto-install | One-click "Quit & Install" |
| macOS   | Manual DMG handoff | Download → `shell.openPath` → user drags to Applications |

Both paths are gated behind an **opt-in toggle** (`kv['updates.optIn']='1'`, default OFF).

---

## Windows flow

1. `checkForUpdates()` calls `autoUpdater.checkForUpdates()`.
2. `electron-updater` resolves `latest.yml` from the GitHub Release.
3. On `update-available`, the main process calls `autoUpdater.downloadUpdate()`.
4. Download progress is forwarded to the renderer as `app:update-win-progress`.
5. When `update-downloaded` fires, the renderer shows `app:update-win-ready`.
6. The user clicks "Quit & Install"; `quitAndInstall()` calls `autoUpdater.quitAndInstall()` which swaps the NSIS EXE and restarts the app.

### Unsigned bypass

`electron-builder.yml` sets:

```yaml
win:
  verifyUpdateCodeSignature: false
```

This disables the Authenticode signature check that would otherwise reject every unsigned build. SmartScreen warnings are still shown on first run (documented in the installer README).

---

## macOS flow

1. `checkForUpdates()` calls `autoUpdater.checkForUpdates()`.
2. `electron-updater` resolves `latest-mac.yml` from the GitHub Release.
3. On `update-available`, the main process **does not** use Squirrel.Mac (it would fail because the app is ad-hoc signed, not Developer-ID signed).
4. Instead, it extracts the `.dmg` URL from `info.files`, downloads the DMG via the shared `http-download.ts` utility (Node `https` with redirect following and atomic `.part` → final rename), and streams progress to the renderer as `app:update-mac-dmg-progress`.
5. When the download finishes, the renderer receives `app:update-mac-dmg-ready` with the local file path.
6. The user clicks "Open DMG"; `quitAndInstall()` calls `shell.openPath(macDmgPath)` and then `app.quit()`. The user drags the new `.app` into `/Applications` manually.

### Why not Squirrel.Mac?

Squirrel.Mac requires a valid Developer ID signature and notarisation. SigmaLink v1.x ships ad-hoc signed (`codesign --sign -`) with no Apple Developer Program membership. Attempting an auto-install via Squirrel.Mac would produce a Gatekeeper "damaged" verdict.

---

## Events table

| Event name | Direction | Payload | When fired |
|------------|-----------|---------|------------|
| `app:update-available` | main → renderer | `{ version: string }` | `electron-updater` finds a newer release |
| `app:update-mac-dmg-progress` | main → renderer | `{ version: string; downloaded: number; total: number }` | Chunk received during DMG download (macOS) |
| `app:update-mac-dmg-ready` | main → renderer | `{ version: string; path: string }` | DMG download completed successfully (macOS) |
| `app:update-win-progress` | main → renderer | `{ version?: string; downloaded: number; total: number }` | `electron-updater` download progress (Windows) |
| `app:update-win-ready` | main → renderer | `{ version: string }` | NSIS update fully downloaded (Windows) |
| `app:update-error` | main → renderer | `{ error: string }` | Any updater or download failure |

---

## RPC methods

| Method | Signature | Behaviour |
|--------|-----------|-----------|
| `app.checkForUpdates` | `() => Promise<{ ok: boolean; version?: string; error?: string }>` | Triggers `autoUpdater.checkForUpdates()`; returns the discovered version or an error. Silently no-ops and returns an error message when the app is not packaged (dev mode). |
| `app.quitAndInstall` | `() => Promise<void>` | Windows: calls `autoUpdater.quitAndInstall()`. macOS: calls `shell.openPath(macDmgPath)` then `app.quit()`. Does nothing on other platforms. |

Both methods are allow-listed in `rpc-channels.ts` and typed in `router-shape.ts`.

---

## Security considerations

1. **Unsigned builds** — Windows and macOS binaries carry no Authenticode or Developer ID signature. Users must bypass SmartScreen (Windows) or Gatekeeper (macOS) on first install. The auto-update path inherits the same trust model: we verify the payload comes from the project's own GitHub Releases feed, not a third-party CA.
2. **MITM on DMG download** — The macOS manual handoff downloads the DMG over HTTPS via Node's `https` module. Redirects are followed (max 5 hops). No additional signature check is performed on the downloaded DMG itself; the user relies on the TLS certificate of `github.com` and the GitHub Releases CDN.
3. **Opt-in toggle** — Update checks are disabled by default. The renderer Settings → Updates tab requires the user to explicitly enable `kv['updates.optIn']='1'` before any network request is issued.
4. **No automatic install on macOS** — Because the DMG is opened but not mounted and replaced automatically, the user is always in the loop and can inspect the bundle before overwriting `/Applications/SigmaLink.app`.

---

## Backfill note

Releases v1.1.4 through v1.2.2 did not attach `latest-mac.yml` to the GitHub Release (the macOS CI workflow landed after those tags). `electron-updater` on macOS needs this manifest to resolve the DMG URL.

- **v1.2.3** re-tagged from main so that the active `release-macos.yml` workflow attached the DMG, ZIP, blockmap, and `latest-mac.yml` to the same Release that already contained the Windows EXE.
- macOS users on v1.1.4–v1.2.2 who have already opted in will see `update-available` fail silently (no manifest). They must manually install v1.2.3 or later once; from that point on the auto-update channel works.
