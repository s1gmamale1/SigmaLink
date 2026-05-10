# @sigmalink/voice-mac

Native macOS speech recognition module for SigmaLink (BridgeVoice). Wraps
`SFSpeechRecognizer` + `AVAudioEngine` behind a thin Node-API surface and
emits live partial / final transcripts back to JS via
`Napi::ThreadSafeFunction`.

## Platform support

| Platform | Behaviour |
|----------|-----------|
| **macOS** (darwin x64 / arm64) | Loads the prebuilt N-API binary from `prebuilds/<platform>-<arch>/`. Continuous on-device recognition. |
| **Windows / Linux** | `index.js` returns a stub object whose `isAvailable()` returns `false`. The main process automatically falls back to the renderer's Web Speech API. |

## Build

End users do not build anything — releases ship with prebuilds committed
to `prebuilds/`. CI (`.github/workflows/native-prebuild-mac.yml`) refreshes
them on every release tag.

For local development on macOS:

```bash
cd app/native/voice-mac
npx node-gyp rebuild
```

Requirements:

- Xcode Command Line Tools (`xcode-select --install`)
- Node.js >= 18
- macOS 10.15 (Catalina) or later

If `node-gyp rebuild` fails because Xcode is not installed, that is OK —
the TypeScript wrapper in `app/src/main/core/voice/native-mac.ts` checks
`isAvailable()` at runtime and falls back to the renderer Web Speech API
when the binary cannot be loaded.

## Architecture

```
JS (main process)
  ↑ ThreadSafeFunction (non-blocking)
  │
Audio thread ──► SFSpeechAudioBufferRecognitionRequest ──► SFSpeechRecognitionTask
  │                                                          │
  └── AVAudioEngine.inputNode tap pushes PCM buffers          └── partial / final / error
```

The recognizer runs in **on-device mode** (`requiresOnDeviceRecognition = YES`)
which removes the 60-second server cap and keeps audio off Apple servers.
A continuous capture session emits one or more `final` events at natural
pause boundaries while keeping the audio engine running; the JS adapter is
responsible for stopping when the user is done.

## Permissions

First call to `requestPermission()` triggers the macOS authorization prompt
for both Microphone (`AVAudioSession`) and Speech Recognition
(`SFSpeechRecognizer`). The `electron-builder` config injects the matching
`NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription`
strings into Info.plist, plus `com.apple.security.device.audio-input`
into the entitlements plist (required when hardened runtime is enabled).

## Threading & safety

All public callbacks (`onPartial`, `onFinal`, `onError`, `onState`) are
delivered on the JS event loop via N-API `ThreadSafeFunction`. The native
side uses **non-blocking** TSFN calls so a slow JS handler can never stall
the realtime audio pipeline — at worst we drop intermediate partials.

## TypeScript

See `index.d.ts` for the full contract. The module exports a default
singleton with this surface:

```ts
voiceMac.isAvailable(): boolean
voiceMac.requestPermission(): Promise<AuthStatus>
voiceMac.getAuthStatus(): AuthStatus
voiceMac.start(opts?: StartOptions): Promise<void>
voiceMac.stop(): Promise<void>
voiceMac.onPartial(cb): UnsubscribeFn
voiceMac.onFinal(cb):   UnsubscribeFn
voiceMac.onError(cb):   UnsubscribeFn
voiceMac.onState(cb):   UnsubscribeFn
```
