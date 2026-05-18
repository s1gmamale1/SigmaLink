# Packet 05 — Windows auto-update verification flow

> **Effort**: S (~3-4hr). **Tier**: v1.3 platform. **Delegate**: Sonnet (cross-platform).
> **Blocks**: nothing. **Blocked by**: nothing.

## Problem

`docs/03-plan/v1.2.4-auto-update-without-signing.md` shipped macOS auto-update without a code-signing cert by relying on the ad-hoc-signed DMG + Sparkle's `dsa_signature` feed. Windows path was deferred — `autoUpdater` for Windows needs either:
- Signed Microsoft Store distribution (gated on EV cert, no funding), OR
- Self-hosted `electron-updater` differential feed (no signing required, but the user sees a UAC prompt on each update)

The current state: Windows users have NO auto-update path. They re-run `iwr https://sigmalink.dev/install.ps1 -UseB | iex` to upgrade.

This packet ships **option 2** (self-hosted differential feed) with a clear UX warning about the UAC prompt + a fallback "re-run installer" button when the user declines the prompt.

## Reference material

- macOS auto-update implementation: `app/electron/auto-updater.ts` (if exists; otherwise the inline `autoUpdater.checkForUpdates()` in `electron/main.ts`)
- electron-updater docs: https://www.electron.build/auto-update
- v1.2.4 plan: `docs/03-plan/v1.2.4-auto-update-without-signing.md` "Known limitations"

## Fix sketch

1. Enable `electron-updater` for win32 with a self-hosted feed:
   ```yaml
   # electron-builder.yml
   publish:
     - provider: github
       owner: s1gmamale1
       repo: SigmaLink
   win:
     publisherName: SigmaLink  # placeholder
     # No `certificateFile` — we stay unsigned. autoUpdater works without it.
   ```
2. Renderer Settings toggle: `kv['app.autoupdate.enabled.win32']` defaults to `false` (opt-in). Inform the user "Windows auto-update will prompt for admin permission on each update."
3. Update check on app boot (if enabled): `autoUpdater.checkForUpdatesAndNotify()` via the existing dispatcher in `electron/main.ts`.
4. UAC fail handling: catch `UAC denied` / `code 5` from `autoUpdater.downloadUpdate()` and surface a toast: "Update download requires admin. Click here to re-run the installer manually." → opens `https://github.com/s1gmamale1/SigmaLink/releases/latest` in browser.

## Files to touch

- `app/electron-builder.yml` — `win.publish` config
- `app/electron/main.ts` — gate `autoUpdater` calls behind platform + kv toggle
- `app/electron/auto-updater.ts` (NEW or modified) — Windows error handler
- `app/src/renderer/features/settings/UpdatesTab.tsx` (NEW or extended) — Windows toggle row + warning copy
- `app/src/main/core/rpc/schemas.ts` — `kv['app.autoupdate.enabled.win32']` schema

## Verification

Manual smoke on a Windows 11 VM:
1. Install v1.4.6 (or whatever prior version exists)
2. Tag a v1.4.7-rc.1 release with the feed enabled
3. Confirm the app surfaces "Update available" within 5 minutes of v1.4.7-rc.1 publish
4. Click "Install update" — confirm UAC prompt appears
5. Confirm post-update launch shows v1.4.7-rc.1
6. Confirm denying UAC surfaces the toast + browser fallback link

Automated:
```bash
cd /Users/aisigma/projects/SigmaLink/app
pnpm exec vitest run electron/auto-updater.test.ts  # NEW test file
```

## Risk

- electron-updater silently writes `app-update.yml` next to the EXE. Make sure NSIS installer permissions allow this. Test with a non-admin user account.
- The `differential update` mode requires a `.blockmap` file alongside the .exe in the GitHub release. Confirm `electron-builder` is generating these.

## Reporting back

PR title: `feat(v1.4.7): Windows auto-update via self-hosted electron-updater feed (opt-in)`. Include the manual smoke recording + the Settings tab screenshot.
