# BridgeVoice

Standalone system-wide dictation app powered by `@sigmalink/voice-core`.

**Hotkey → capture → whisper transcribe → clipboard / AX-paste into any focused app.**

No workspace/pane/session logic — pure dictation, runs in the system tray.

## Development

```bash
# From app/
pnpm install
pnpm --filter @sigmalink/bridge-voice dev
```

## Building

```bash
# From app/apps/bridge-voice/ — bundle main + preload only (fast, no installer)
pnpm run build

# From app/apps/bridge-voice/ — produce macOS DMG (unsigned / ad-hoc signed)
pnpm run pack:mac

# From app/apps/bridge-voice/ — produce Windows NSIS installer (unsigned)
pnpm run pack:win
```

Output lands in `app/apps/bridge-voice/release/`.

## Packaging (done)

### electron-builder configuration

- `electron-builder.yml` — macOS DMG (arm64 + x64) + Windows NSIS.
- `appId`: `ai.sigma.bridgevoice`
- `productName`: `BridgeVoice`
- `mac.category`: `public.app-category.productivity`

### macOS entitlements (`build/entitlements.mac.plist`)

Entitlements shipped:

- `com.apple.security.cs.allow-jit` — Electron V8 JIT
- `com.apple.security.cs.allow-unsigned-executable-memory` — native modules
- `com.apple.security.device.audio-input` — microphone (dictation)
- `com.apple.security.speech-recognition` — Apple Speech.framework fallback
- `com.apple.security.automation.apple-events` — AX paste (CGEventPost)

Corresponding `Info.plist` keys injected via `electron-builder.yml extendInfo`:

- `NSMicrophoneUsageDescription` — "BridgeVoice needs microphone access for system-wide dictation."
- `NSSpeechRecognitionUsageDescription` — "BridgeVoice uses speech recognition to transcribe your voice into any app."

### Code-signing (unsigned / internal-use)

BridgeVoice ships UNSIGNED — matching SigmaLink's internal-use distribution model:

- **macOS**: `identity: null` + `afterSign` hook runs `codesign --force --deep --sign -`
  (ad-hoc). Gatekeeper shows "unidentified developer" (recoverable) rather than
  "damaged" (not recoverable). Users run `xattr -cr /Applications/BridgeVoice.app`
  or use System Settings → Privacy & Security → Open Anyway.
- **Windows**: No Authenticode cert. SmartScreen shows on first launch only.
  Users click "More info" → "Run anyway" once.

When a Developer ID / Authenticode cert is acquired: drop the `afterSign` hook,
set `mac.identity` to the cert CN, flip `hardenedRuntime: true`, add `notarize: true`.

### CI lane (`release-bridge-voice.yml`)

Trigger: push tag matching `bridgevoice-v*` (e.g. `git tag bridgevoice-v0.1.0 && git push --tags`).

This tag pattern is intentionally distinct from `v*` (SigmaLink main releases) so the
two apps never trigger each other's CI.

Pipeline:
1. macOS job (macos-14): rebuild voice native modules (`sigmavoice_mac`, `whisper_bridge`),
   bundle with esbuild, produce unsigned DMG.
2. Windows job (windows-latest): rebuild voice natives, bundle, produce NSIS `.exe`.
3. Both jobs upload artefacts to GitHub Actions and attach to the GitHub Release.

`CSC_IDENTITY_AUTO_DISCOVERY=false` is set on both jobs to guarantee no accidental
keychain signing.

The whisper.cpp submodule init step has `continue-on-error: true` (same as
`release-macos.yml`) — when vendor source is absent, voice-whisper falls back to
the stub and Apple Speech.framework remains active.

## Unsigned-install UX

Users who download the DMG/EXE from GitHub Releases see `com.apple.quarantine`
set by their browser.  The Gatekeeper text inside the DMG (`build/dmg/README — Open BridgeVoice.txt`)
explains the two workarounds (Terminal `xattr -cr` or System Settings).

Users who install via a `curl | bash` script get no quarantine xattr at all
(same approach as SigmaLink's `scripts/install-macos.sh`).

## Deferred items

- Electron auto-updater (`electron-updater`) wiring — requires a release server / S3 bucket.
- `@sigmalink/voice-win` native `sendPasteKeystroke` equivalent (deferred to voice-win Cluster B PR).
- Linux AppImage (optional, deferred to v1.5).
- DMG background art.
