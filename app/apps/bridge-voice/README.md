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

## Deferred packaging work

The following items are explicitly deferred from v1.4.8 Cluster B:

### electron-builder configuration

- `electron-builder.yml` target for macOS (`.dmg`) and Windows (`.nsis`).
- `appId`: `com.sigmalink.bridgevoice`
- `productName`: `BridgeVoice`
- `mac.category`: `public.app-category.productivity`

### macOS entitlements (`build/entitlements.mac.plist`)

Required entitlements for the sandboxed `.app` bundle:

```xml
<key>com.apple.security.device.audio-input</key><true/>
<key>com.apple.security.speech-recognition</key><true/>
```

Corresponding `Info.plist` keys in the `.app`:

- `NSMicrophoneUsageDescription` — "BridgeVoice needs microphone access for dictation."
- `NSSpeechRecognitionUsageDescription` — "BridgeVoice uses Apple Speech Recognition to transcribe your voice."

### Code-signing

- macOS: Developer ID Application certificate; `hardened-runtime` flag; notarization via `notarytool`.
- Windows: EV code-signing certificate for SmartScreen bypass.

### Build matrix / CI lane

- macOS universal binary (x64 + arm64 via `--arch universal`).
- Windows x64 NSIS installer.
- Linux AppImage (optional, deferred to v1.5).
- GitHub Actions lane: trigger on tag `bridge-voice/v*`; upload artifacts to GitHub Releases.

### Other

- Electron auto-updater (`electron-updater`) wiring — requires a release server / S3 bucket.
- DMG background art and NSIS installer script.
- `@sigmalink/voice-win` native `sendPasteKeystroke` equivalent (deferred to voice-win Cluster B PR).
