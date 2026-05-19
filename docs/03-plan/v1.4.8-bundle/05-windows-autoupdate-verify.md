# Packet 05 — Windows auto-update verification (v1.4.8 review)

> **Effort**: XS (~1-2hr). **Tier**: v1.3 platform (no code changes needed).
> **Delegate**: Sonnet (cross-platform). **Status**: ready-to-dispatch — blocked only on Windows VM access.
> **Blocks**: nothing. **Blocked by**: Windows 11 VM or physical machine for manual smoke.

---

## Original brief summary (v1.4.7)

The v1.4.7 brief was written under the assumption that Windows auto-update had NOT yet been implemented. It specified:

1. Enabling `electron-updater` for win32 with a GitHub Releases feed — adding `publish:` to `electron-builder.yml` and gating via a `kv['app.autoupdate.enabled.win32']` opt-in key (defaulting to `false`).
2. A new `UpdatesTab.tsx` renderer toggle informing users "Windows auto-update will prompt for admin permission on each update."
3. UAC failure handling — catch error code 5 from `autoUpdater.downloadUpdate()` and surface a toast redirecting to the GitHub Releases page.
4. A 5-step manual smoke on a Windows 11 VM: install prior version, tag an RC, verify "Update available" appears within 5 minutes, confirm UAC prompt, confirm post-update version, confirm UAC-deny toast.
5. A new `electron/auto-updater.test.ts` unit test file for the error handler.

The brief was **pre-implementation** — all of the above was described as future work.

---

## v1.4.8 review

### State validation: what has actually shipped

The implementation from v1.4.7 brief was completed as part of v1.2.4. Current codebase state (all files confirmed by direct read):

**`app/electron-builder.yml` (line 84)**
```yaml
win:
  verifyUpdateCodeSignature: false  # v1.2.4: skip signature check for unsigned adhoc builds
```
The flag is already in place. Additionally, the `nsis:` block has a v1.3.x fix:
```yaml
nsis:
  artifactName: ${productName}-Setup-${version}.${ext}
```
This resolves a v1.3.0/v1.3.1 regression where electron-updater's `latest.yml` referenced the dashed artifact name but the builder produced dots, causing 404s on auto-update. This is already fixed.

**`publish:` block (lines 117-120)**
```yaml
publish:
  provider: github
  owner: s1gmamale1
  repo: SigmaLink
```
Already present and targeting the correct repo.

**`app/electron/auto-update.ts` — fully implemented (179 lines)**
- `autoUpdater.autoDownload = false`
- `update-available` handler: on `win32` calls `autoUpdater.downloadUpdate()`; on `darwin` fetches DMG manually via `httpDownload`
- `download-progress` handler: broadcasts `app:update-win-progress`
- `update-downloaded` handler: broadcasts `app:update-win-ready`
- `error` handler: broadcasts `app:update-error`
- `quitAndInstallImpl()`: on win32 calls `autoUpdater.quitAndInstall()`; on darwin opens `macDmgPath` via `shell.openPath()`
- `maybeCheckOnBoot()`: gates on `kv['updates.optIn'] === '1'` with 3s delay

**`app/src/renderer/features/settings/UpdatesTab.tsx` — fully implemented (366 lines)**
- 5-state machine: `idle | checking | downloading | ready | error`
- All 6 event subscriptions wired with cleanup
- Progress bar with byte-level display
- Platform-aware install buttons ("Quit & Install" on win32, "Open DMG" on darwin)
- Opt-in toggle via `kv['updates.optIn']`
- `rpc.app.checkForUpdates()` and `rpc.app.quitAndInstall()` wired

**`app/src/main/rpc-router.ts`**
- `checkForUpdates`, `quitAndInstall`, `getVersion`, `getPlatform` all present at lines 446-480

**`release-windows.yml`**
- Builds and uploads `*.exe`, `*.exe.blockmap`, and `latest.yml` to GitHub Releases on every `v*` tag push
- `--publish never` flag during the build step + explicit `softprops/action-gh-release` attachment — the manifest lands correctly

### Drift from v1.4.7 brief

| Item in v1.4.7 brief | Current state |
|---|---|
| Enable `electron-updater` for win32 | **Already shipped v1.2.4** — no work needed |
| Add `publish:` to `electron-builder.yml` | **Already present** since v1.2.4 |
| `kv['app.autoupdate.enabled.win32']` opt-in key | **Shipped as `kv['updates.optIn']`** — shared key for both platforms, not win32-specific |
| "UAC prompt" warning copy in UpdatesTab | **NOT present** — the UpdatesTab copy does not specifically warn about UAC; it says "no silent installs" generically. Minor gap. |
| UAC error code 5 explicit catch | **NOT present** — `autoUpdater.on('error')` broadcasts generically; no specific UAC error handling with "re-run installer" fallback toast |
| New `electron/auto-updater.test.ts` | **NOT present** — unit tests for the Windows error path exist in `UpdatesTab.test.tsx` but there is no standalone `electron/auto-update.test.ts` |
| v1.3.x artifact name 404 bug | **Fixed in v1.3.x** — `artifactName` pinned to dashed form |

### Updated approach for v1.4.8

The core implementation is complete. This packet reduces to **verification + two minor polish items**:

**Item A (XS, ~20min): UAC-specific error copy**
In `electron/auto-update.ts`, the `error` handler broadcasts raw `err.message`. On Windows, NSIS installer permission errors surface as `Error code: 5` or `EACCES`. Add a platform-specific check:
```typescript
// In autoUpdater.on('error', ...) handler
if (process.platform === 'win32' && /code[:\s]*5|EACCES/i.test(err.message)) {
  broadcast('app:update-error', {
    error: 'Admin permission required. Re-run the SigmaLink installer to upgrade: https://github.com/s1gmamale1/SigmaLink/releases/latest',
    isUacDenied: true,
  });
} else {
  broadcast('app:update-error', { error: err.message });
}
```
Renderer `UpdatesTab.tsx` should render an "Open latest release" external link when `isUacDenied: true`.

**Item B (XS, ~15min): UAC warning copy in UpdatesTab**
Add a single line of muted helper text beneath the win32 opt-in toggle:
```tsx
{platform === 'win32' && (
  <div className="mt-1 text-[11px] text-muted-foreground">
    Each update will request admin permission via a Windows UAC prompt.
  </div>
)}
```

**Item C (primary): Manual smoke on Windows VM**
This is the gate. Items A and B are polish; the smoke test is the actual deliverable. No Windows hardware is required if a GitHub Actions `windows-latest` runner is used for a headless partial smoke (network check + `latest.yml` resolution). Full UAC interaction requires an interactive Windows session.

### Risks

- **R-1**: `verifyUpdateCodeSignature: false` was introduced in v1.2.4 with the accepted risk that a compromised GitHub Releases channel could serve a malicious EXE. Mitigation already noted in the YAML comment: publish is over HTTPS to a 2FA-protected repo. No new risk.
- **R-2**: The artifact name fix (dashed form) in `nsis.artifactName` was patched in v1.3.x after two broken releases (v1.3.0, v1.3.1). The fix is stable — but if a future release changes `productName` in `electron-builder.yml`, the dashed template will still produce the correct name.
- **R-3**: No Windows VM is currently in the project's CI or dev environment. The verification step for UAC interactive flow requires one. `windows-latest` GitHub Actions runner can test download + `latest.yml` parse but cannot simulate UAC.
- **R-4**: `latest.yml` SHA512 hash mismatch would cause a silent rejection without a clear user-visible error. Confirm the uploaded `latest.yml` hash matches the actual artifact on the next release.

### Gate

Packet is considered closed when:
1. Build passes on `windows-latest` CI runner with the new polish items.
2. Manual smoke steps 1-6 below are completed on a Windows 11 interactive session.
3. UAC-deny error path explicitly tested (step 6).

---

## Final delegation brief

**Title**: `fix(v1.4.8): Windows auto-update UAC error copy + verification smoke`

**Model**: Sonnet (cross-platform, no architecture decisions needed)

**Scope** (HARD):
- `app/electron/auto-update.ts` — UAC error detection in `error` handler only
- `app/src/renderer/features/settings/UpdatesTab.tsx` — UAC warning copy under win32 toggle + `isUacDenied` link branch in error state
- Manual smoke steps below

**Do NOT touch**: `electron-builder.yml`, `release-windows.yml`, RPC schemas, anything else.

**Verification steps (Windows 11 VM required for steps 4-6)**:

1. `pnpm exec tsc -b && pnpm exec vitest run && pnpm exec eslint .` — all clean.
2. Trigger `release-windows.yml` via `workflow_dispatch` on the current tag.
3. Confirm `*.exe`, `*.exe.blockmap`, and `latest.yml` are attached to the GitHub Release.
4. On Windows 11: install the prior release, toggle opt-in ON in Settings → Updates.
5. Trigger a new patch tag — confirm "Update available" toast appears within ~10s, progress bar fills, "Quit & Install" button appears on completion.
6. Repeat step 5 but decline the UAC prompt — confirm the error toast contains the "Open latest release" link pointing to `https://github.com/s1gmamale1/SigmaLink/releases/latest`.

**PR title**: `fix(v1.4.8): Windows auto-update UAC denied fallback + UpdatesTab UAC warning`

---

## Open questions

1. **Windows VM**: does the team have access to a Windows 11 interactive session (Parallels, Azure VM, or physical)? If not, steps 4-6 cannot be executed and the packet should be marked `smoke-deferred` until VM access is arranged.
2. **`isUacDenied` in event payload**: the `app:update-error` event schema is currently an untyped `{ error: string }`. Adding `isUacDenied?: boolean` is backward-compatible, but if there is a zod schema in `rpc/schemas.ts` for this event it needs updating.
3. **Shared opt-in key**: v1.4.7 brief specified a win32-specific `kv['app.autoupdate.enabled.win32']` key. The shipped implementation uses the single `kv['updates.optIn']` for both platforms. This is intentional (simpler UX) but means disabling auto-update on macOS also disables it on Windows for a user switching platforms. Confirm this is the desired behaviour before closing.
4. **Delta updates (blockmap)**: `release-windows.yml` confirms `.blockmap` files are uploaded. The first live upgrade that exercises the block-map diff will be from whatever version follows v1.4.8. No action needed now, but note for post-v1.4.8 observability.
