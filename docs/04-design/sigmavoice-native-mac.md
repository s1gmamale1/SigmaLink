# SigmaVoice — Native macOS Speech Module + Dispatcher Pipeline

**Author:** voice-architect (system-architect agent)
**Date:** 2026-05-10
**Phase:** 4, Step 3 (Step 4 wake-word DEFERRED to v1.2)
**Status:** Design — ready for coder agent to implement
**Source research:** `agentdb_pattern-search` namespace `phase4-voice-research`, key `macos-speech-framework-napi-2026-05-10`
**Plan reference:** `~/.claude/plans/download-a-skill-plugin-that-lexical-pinwheel.md` Step 3

---

## 1. Goals & Non-Goals

**Goals**
- Replace renderer-only Web Speech API on macOS with a native, on-device Speech.framework recognizer that supports continuous (always-on) capture beyond the ~60 s server cap.
- Provide a **single ABI-stable Node-API binary per arch** (`darwin-x64`, `darwin-arm64`) so end users do not need Xcode.
- Funnel finalized transcripts through a deterministic **regex intent classifier**, falling through to the Bridge Assistant when no rule matches.
- Preserve every existing voice-busy semantic in `app/src/main/core/voice/adapter.ts` (single-session, source-tagged, idempotent stop).

**Non-Goals (v1.1)**
- Wake-word ("Hey Sigma") — Porcupine licensing blocker; deferred to v1.2 with BYO-AccessKey UX.
- Windows SAPI / Linux native engines — Web Speech API renderer fallback still ships there.
- Speaker diarization, custom vocabularies, or LM customization.
- Code signing of the native binary (handled by the existing `electron-builder` macOS sign step on the .app bundle).

---

## 2. Module Layout

```
app/
├── native/
│   └── voice-mac/
│       ├── binding.gyp              # node-gyp build descriptor (cflags_cc, frameworks, ARC)
│       ├── package.json             # name: "@sigmalink/voice-mac", scripts: install, prebuild
│       ├── README.md                # "Builds only on darwin; falls back to no-op on other OS"
│       ├── index.js                 # Loads prebuild via `node-gyp-build`; exports stub on non-darwin
│       ├── index.d.ts               # TypeScript contract (see §3)
│       ├── src/
│       │   ├── sigmavoice_mac.mm    # Objective-C++ entrypoint (Napi::Object Init)
│       │   ├── recognizer.mm        # SFSpeechRecognizer wrapper + AVAudioEngine glue
│       │   ├── recognizer.h
│       │   ├── tsfn_bridge.mm       # ThreadSafeFunction queue (audio thread → JS thread)
│       │   └── tsfn_bridge.h
│       └── prebuilds/               # populated by CI; committed for end-user installs
│           ├── darwin-x64/
│           │   └── node.napi.node
│           └── darwin-arm64/
│               └── node.napi.node
```

**Workspace integration:** `app/native/voice-mac` is added to the root `pnpm-workspace.yaml` packages array. The main process imports it as `import voiceMac from '@sigmalink/voice-mac'` (via workspace alias) to avoid brittle relative paths and to let `pnpm` symlink the package into `node_modules`.

**Why a workspace package over a relative `require('../../native/voice-mac')`?**
- TypeScript path mapping stays clean (no `../../../` chains).
- `node-gyp-build` resolution works the same in dev and production (looks for `prebuilds/<platform>-<arch>/`).
- Prebuilt binaries can be conditionally `optionalDependencies`-skipped on non-darwin platforms in a future iteration.

**Postinstall:** `package.json` declares `"install": "node-gyp-build"` which is a no-op when a prebuild matches the current `darwin-{x64,arm64}` triplet. On `linux`/`win32`, `index.js` returns a stub object whose `isAvailable()` returns `false` so dispatcher fall-through is automatic.

---

## 3. TypeScript Contract — `index.d.ts`

```ts
// app/native/voice-mac/index.d.ts
//
// SigmaVoice native macOS speech recognition module.
// All callbacks are invoked on the JS event loop via N-API ThreadSafeFunction;
// callers do not need to worry about thread safety.

export type AuthStatus =
  | 'granted'
  | 'denied'
  | 'restricted'      // parental controls / MDM
  | 'not-determined'; // prompt has not been shown yet

export interface StartOptions {
  /** BCP-47 locale; default: navigator.language fallback "en-US". */
  locale?: string;
  /** Force on-device recognition (required for continuous > 60s). Default: true. */
  onDevice?: boolean;
  /**
   * Add punctuation when supported (macOS 13+). Default: true.
   * Silently ignored on older OS versions.
   */
  addPunctuation?: boolean;
}

export interface VoiceError {
  /** Stable, ASCII-kebab-case code: 'no-permission' | 'unsupported-locale' |
   *  'audio-engine-failure' | 'recognizer-cancelled' | 'unknown'. */
  code: string;
  /** Human-readable detail; safe to surface in toasts. */
  message: string;
}

export type UnsubscribeFn = () => void;

export interface SigmaVoiceMac {
  /**
   * True when the module loaded a native binary (darwin only) AND
   * `[SFSpeechRecognizer supportedLocales]` is non-empty.
   */
  isAvailable(): boolean;

  /**
   * Triggers the macOS authorization prompt the first time. Subsequent calls
   * resolve immediately with the cached status.
   */
  requestPermission(): Promise<AuthStatus>;

  /** Current cached auth status without prompting. */
  getAuthStatus(): AuthStatus;

  /**
   * Start continuous capture. Rejects with `voice-busy` if a session is in
   * flight, `no-permission` if auth was denied, or `unsupported-locale` if
   * the requested locale is not in `supportedLocales`.
   */
  start(opts?: StartOptions): Promise<void>;

  /** Idempotent. Resolves once the audio engine has fully torn down. */
  stop(): Promise<void>;

  /** Live partial transcript while speaking. May fire many times per utterance. */
  onPartial(cb: (text: string) => void): UnsubscribeFn;

  /**
   * Final transcript at end-of-utterance. In on-device continuous mode the
   * recognizer fires `final` for each natural pause segment, then keeps going.
   */
  onFinal(cb: (text: string) => void): UnsubscribeFn;

  /** Recognizer or audio-engine error. After an error, the session is dead. */
  onError(cb: (err: VoiceError) => void): UnsubscribeFn;

  /**
   * Lifecycle state for cross-window UI sync. Mirrors the renderer enum.
   * 'idle' → 'listening' → 'partial' → 'final' → 'dispatching' → 'idle'
   */
  onState(cb: (state: NativeVoiceState) => void): UnsubscribeFn;
}

export type NativeVoiceState =
  | 'idle'
  | 'listening'
  | 'partial'
  | 'final'
  | 'error';

declare const voiceMac: SigmaVoiceMac;
export default voiceMac;
```

The main-process wrapper at `app/src/main/core/voice/native-mac.ts` thinly adapts this contract into the existing `defineController` shape, adding:
- IPC event emission on `voice:state` (already in `EVENTS` allowlist).
- Dispatcher invocation on `final`.
- Translation of `code: 'no-permission'` → renderer toast hint.

---

## 4. Objective-C++ Skeleton (Pseudo-code)

```objc
// recognizer.mm — high-level structure, not full source.

#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>
#include <napi.h>

@interface SVRecognizer : NSObject
  @property SFSpeechRecognizer       *recognizer;
  @property SFSpeechAudioBufferRecognitionRequest *request;
  @property SFSpeechRecognitionTask  *task;
  @property AVAudioEngine            *engine;
  // weak refs into ThreadSafeFunctions for partial/final/error/state callbacks
@end

@implementation SVRecognizer
- (BOOL)startWithLocale:(NSString*)bcp47
              onDevice:(BOOL)onDevice
                  err:(NSError**)err {
  // 1. Build recognizer for locale; fail-fast if not in supportedLocales.
  // 2. Configure AVAudioSession (category .record, mode .measurement).
  // 3. Install tap on AVAudioEngine.inputNode that pushes buffers to request.
  // 4. Set request.requiresOnDeviceRecognition = YES (REQUIRED for continuous).
  // 5. Set request.shouldReportPartialResults = YES.
  // 6. Kick off recognitionTaskWithRequest:resultHandler: — the handler:
  //      • onPartial → tsfn_partial.NonBlockingCall(transcript)
  //      • onFinal   → tsfn_final.NonBlockingCall(transcript)
  //      • onError   → tsfn_error.NonBlockingCall({code, message})
  // 7. [engine prepare] / [engine startAndReturnError:err]
  return *err == nil;
}
@end

// N-API surface
Napi::Value Start(const Napi::CallbackInfo& info) {
  // Parse opts, request auth synchronously if not-determined,
  // hand off to [SVRecognizer startWithLocale:onDevice:err:] on the
  // AVAudioEngine's serial queue. Return a Napi::Promise resolved
  // when engine.isRunning == YES.
}
Napi::Value Stop(const Napi::CallbackInfo& info)         { /* tear down */ }
Napi::Value RequestPermission(const Napi::CallbackInfo&) { /* SFSpeechRecognizer requestAuthorization: */ }
Napi::Value OnPartial(const Napi::CallbackInfo& info)    { /* register tsfn */ }
// ... onFinal, onError, onState, isAvailable, getAuthStatus

NAPI_MODULE_INIT() { /* exports.start = ... etc. */ }
```

**Threading model**
- Audio buffers arrive on a real-time CoreAudio thread.
- `SFSpeechRecognitionTask`'s result handler fires on a private Speech.framework queue.
- Both queues marshal into JS via `Napi::ThreadSafeFunction`. We use **non-blocking** calls so a slow JS handler can never stall the audio engine — at worst, partials drop and we still get the next final.

**ARC + frameworks (binding.gyp excerpt)**
```python
{ "target_name": "sigmavoice_mac",
  "sources": [ "src/sigmavoice_mac.mm", "src/recognizer.mm", "src/tsfn_bridge.mm" ],
  "include_dirs": [ "<!(node -p \"require('node-addon-api').include_dir\")" ],
  "conditions": [
    [ 'OS=="mac"', {
        "xcode_settings": {
          "CLANG_ENABLE_OBJC_ARC": "YES",
          "MACOSX_DEPLOYMENT_TARGET": "10.15",
          "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17", "-stdlib=libc++" ]
        },
        "link_settings": {
          "libraries": [
            "$(SDKROOT)/System/Library/Frameworks/Speech.framework",
            "$(SDKROOT)/System/Library/Frameworks/AVFoundation.framework",
            "$(SDKROOT)/System/Library/Frameworks/AudioToolbox.framework"
          ]
        }
      } ]
  ]
}
```

---

## 5. Dispatcher Pipeline

```
                  ┌───────────────────────────────┐
                  │ voice-mac.onFinal(transcript) │
                  └──────────────┬────────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────────┐
                │ adapter.ts: state = 'dispatching'   │
                │   broadcast voice:state             │
                └──────────────┬─────────────────────┘
                               │
                               ▼
                ┌──────────────────────────────────┐
                │ dispatcher.ts: regex classifier  │
                └──┬─────────────────────────────┬─┘
                   │ match                       │ no match
                   ▼                             ▼
        ┌──────────────────────┐      ┌─────────────────────────┐
        │ controllers.invoke() │      │ assistant.send({ text })│
        │ (typed RPC)          │      │ (free-text turn)        │
        └────────────┬─────────┘      └────────────┬────────────┘
                     │                              │
                     └──────────────┬───────────────┘
                                    ▼
                ┌───────────────────────────────────┐
                │ emit 'voice:dispatch-echo'         │
                │   { intent, controller, args }     │
                └───────────────────────────────────┘
                                    │
                                    ▼
                       VoicePill toast: "Routing → coordinator..."
```

**Intent table (v1)**

| # | Regex | Resolved Intent | Args | Target Controller |
|---|-------|-----------------|------|-------------------|
| 1 | `/^(spawn\|launch\|create\|start)\s+(\d+)?\s*(coder\|tester\|reviewer\|coordinator\|builder\|scout)s?\b/i` | `create_swarm` | `{ count, role }` | `swarms.create` |
| 2 | `/^(open\|navigate to\|switch to)\s+(?:the\s+)?(swarm\|browser\|review\|tasks\|memory\|operator\|workspaces\|command\|bridge\|skills\|settings)\b/i` | `app.navigate` | `{ pane }` | renderer event `app:navigate` |
| 3 | `/^(send\|broadcast)\s+["'](.+?)["'](?:\s+to\s+(\w+))?$/i` | `swarms.broadcast` | `{ message, target? }` | `swarms.broadcast` |
| 4 | `/^(roll call\|status check\|who'?s running\|who is running)\b/i` | `swarms.rollCall` | `{}` | `swarms.rollCall` |
| 5 | _no match_ | `assistant.freeform` | `{ text }` | `assistant.send` |

The classifier function returns `{ intent, controller, args, raw }` for telemetry; `dispatcher.ts` then calls the appropriate RPC. **No** intent ever throws — unrecognized text is *always* a valid free-text turn for Bridge Assistant. The dispatch-echo event lets `VoicePill` show "Routing → coordinator..." (matched intent) or "Asking Bridge..." (free-text fallback).

**New RPC channels** (add to `app/src/shared/rpc-channels.ts`):
```ts
'voice.dispatch',     // renderer-initiated test hook (e.g. "send 'foo' to coordinator" without speech)
'voice.setMode',      // 'auto' | 'web-speech' | 'native-mac' | 'off'
```
**New event** (add to `EVENTS` set):
```ts
'voice:dispatch-echo',
```

---

## 6. Adapter State Machine Extension

Existing states (`adapter.ts`): implicit `idle | active`.
New states: `idle → listening → partial → final → dispatching → done(idle)`.

```
   ┌────────┐  start()  ┌───────────┐  onPartial  ┌──────────┐
   │ idle   ├──────────▶│ listening ├────────────▶│ partial  │
   └────▲───┘           └─────┬─────┘             └────┬─────┘
        │                     │ stop() / error          │ onFinal
        │                     ▼                         ▼
        │              ┌──────────┐  dispatch()   ┌──────────┐
        └──────────────┤ idle/err │◀──────────────┤dispatching│
                       └──────────┘               └──────────┘
```

The single-session enforcer in `buildVoiceController` continues to reject concurrent `start` with `voice-busy`. The dispatching state is visible to `VoicePill` so the orb spinner can show a distinct "routing" animation between recognition end and controller resolution.

**Platform routing inside `adapter.ts`:**
```ts
const NATIVE_MAC = process.platform === 'darwin' && nativeMac.isAvailable();
// On `start({ source })`:
if (NATIVE_MAC) {
  await nativeMac.start({ locale: 'en-US', onDevice: true });
  // hookups: nativeMac.onPartial → emit; onFinal → dispatcher.dispatch(text)
} else {
  // unchanged: renderer drives Web Speech API; main only tracks session ID.
}
```

---

## 7. electron-builder Config Diff

```yml
# electron-builder.yml
mac:
  category: public.app-category.developer-tools
  hardenedRuntime: true                        # NEW — required for entitlements
  gatekeeperAssess: false                      # NEW — keep until notarisation lands
  entitlements: build/entitlements.mac.plist        # NEW
  entitlementsInherit: build/entitlements.mac.plist # NEW
  extendInfo:                                  # NEW
    NSMicrophoneUsageDescription: "SigmaLink uses your microphone for voice commands."
    NSSpeechRecognitionUsageDescription: "SigmaLink uses speech recognition to dispatch commands to AI agents."
  target:
    - target: dmg
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]

# Keep `asar: false` (v1.0.1 native-module fix). When asar returns in v1.1,
# add: asarUnpack: ["**/native/voice-mac/prebuilds/**/*.node", "**/*.node"]
```

**New file** `build/entitlements.mac.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
</dict>
</plist>
```

---

## 8. prebuildify CI Workflow

`.github/workflows/native-prebuild-mac.yml` (new):
```yaml
name: Native prebuild — voice-mac
on:
  push:
    paths: [ 'app/native/voice-mac/**', '.github/workflows/native-prebuild-mac.yml' ]
    tags:  [ 'v*' ]
  pull_request:
    paths: [ 'app/native/voice-mac/**' ]

jobs:
  build:
    runs-on: macos-14   # Apple Silicon runner; cross-builds x64 via -arch
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: corepack enable && pnpm install --frozen-lockfile
      - name: Prebuild arm64 + x64
        working-directory: app/native/voice-mac
        run: |
          pnpm exec prebuildify --napi --strip --arch=arm64
          pnpm exec prebuildify --napi --strip --arch=x64
      - name: Smoke load (arm64)
        working-directory: app/native/voice-mac
        run: node -e "console.log(require('./index.js').isAvailable())"
      - uses: actions/upload-artifact@v4
        with:
          name: voice-mac-prebuilds
          path: app/native/voice-mac/prebuilds/**
      - name: Commit prebuilds (release tags only)
        if: startsWith(github.ref, 'refs/tags/v')
        run: |
          git config user.name "sigma-bot"
          git config user.email "bot@sigmalink.dev"
          git add app/native/voice-mac/prebuilds
          git commit -m "chore(voice-mac): refresh prebuilds for ${GITHUB_REF_NAME}" || true
          git push origin HEAD:main || true
```

End users running `pnpm install` after a fresh clone get `node-gyp-build` resolving the committed prebuild — no Xcode required.

---

## 9. Error / Permission UX Matrix

| Trigger | Native module behaviour | Adapter action | VoicePill / Toast |
|---|---|---|---|
| `requestPermission()` returns `denied` | Reject `start()` with `code: 'no-permission'` | Emit `voice:state { active:false, error:'no-permission' }` | Toast: "Microphone permission denied — enable in System Settings → Privacy → Microphone." Action button: `shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')` |
| `requestPermission()` → `restricted` | Reject `start()` with `code: 'no-permission'` | Same as denied | Toast: "Microphone access is restricted by your administrator." (no Settings link) |
| `SFSpeechRecognizer supportedLocales` does not include `opts.locale` | Reject with `code: 'unsupported-locale'` | Adapter falls back to Web Speech API (renderer) | Subtle info toast: "Using browser speech (locale unsupported on-device)." |
| `AVAudioEngine startAndReturnError:` fails | Reject with `code: 'audio-engine-failure'` | Emit error; teardown native session | Toast: "Audio engine failed: <message>" — destructive variant |
| User runs Win/Linux build | `index.js` returns no-op stub; `isAvailable()` false | Adapter never selects native; uses renderer Web Speech | No toast — silent fallback |
| Concurrent `start({ source: 'mission' })` while `assistant` is active | Adapter rejects with `voice-busy` (existing behaviour preserved) | No state change | Toast (existing): "Voice already active in <other source>." |
| Speech.framework cancels recognition mid-stream (e.g. AirPods disconnect) | `onError({ code: 'recognizer-cancelled' })` | Adapter clears `dispatching` state, returns to idle | Toast: "Voice session ended unexpectedly." |
| User says nothing for 30 s | `SFSpeechRecognitionTask` issues final empty result; classifier sees empty string and bails | Adapter returns to idle, no dispatch | No toast (matches Web Speech `no-speech` silence treatment) |

---

## 10. Test Strategy (signposts only — owned by tester agent)

- **Unit (Vitest):** classifier covers each row of the intent table + 3 negative samples per row.
- **Integration:** mock `voiceMac` module exposing scripted `onPartial`/`onFinal` callbacks; assert dispatcher → controller wiring and `voice:dispatch-echo` payload.
- **Native smoke (CI macOS-only):** `node -e require('@sigmalink/voice-mac').isAvailable()` must print `true` after install.
- **Manual:** start mission voice → say "spawn three coders" → verify swarm pane shows 3 new agents.

---

## 11. Open Questions (need lead resolution)

1. **Workspace package vs. relative require** — the design picks workspace alias `@sigmalink/voice-mac`. If `pnpm-workspace.yaml` cannot reach into `app/native/`, fall back to a relative `require('../../../native/voice-mac')` from `native-mac.ts` and a `tsconfig` path alias.
2. **Locale list at startup** — should we cache `supportedLocales` once at app boot (cheaper) or on every `start` (always fresh)? Recommendation: cache for the process lifetime; locales do not change without a SIP-protected OS update.
3. **Dispatch-echo retention** — should the last 50 dispatches be persisted in `kv` for a Voice History panel later? Out of scope for v1.1; flag for v1.2 alongside wake-word.
4. **Continuous-mode UX** — when `requiresOnDeviceRecognition = YES` is enabled, the recognizer streams indefinitely. Do we expose a "stop after N seconds of silence" knob, or rely on user-driven stop? Recommendation: 30 s silence auto-stop, configurable via `kv['voice.autoStopSilenceMs']`.
5. **Notarisation timing** — hardened runtime + entitlements are necessary for the eventual notarised build; do we ship v1.1 unsigned (current state) and add Developer ID later, or block v1.1 until signing is in place? Recommendation: ship unsigned now; entitlements are inert without a signing identity but harmless.
6. **Error code `unknown`** — Speech.framework occasionally returns `kAFAssistantErrorDomain` codes that are not user-actionable. Map all of these to `code: 'unknown'` and rely on the human `message` field, or expose the raw NSError code? Recommendation: surface raw code as `nativeCode` numeric field for telemetry; `code` stays kebab-case for switch statements.

---

## 12. Coder Hand-off Checklist

Files the coder agent will create or modify (in dependency order):

1. **NEW** `app/native/voice-mac/{binding.gyp, package.json, README.md, index.js, index.d.ts, src/*.{mm,h}}`
2. **NEW** `build/entitlements.mac.plist`
3. **NEW** `.github/workflows/native-prebuild-mac.yml`
4. **NEW** `app/src/main/core/voice/native-mac.ts` (wrapper around the module)
5. **NEW** `app/src/main/core/voice/dispatcher.ts` (regex classifier + RPC fan-out)
6. **EDIT** `app/src/main/core/voice/adapter.ts` (add platform branch, dispatching state)
7. **EDIT** `app/src/shared/rpc-channels.ts` (add `voice.dispatch`, `voice.setMode`, event `voice:dispatch-echo`)
8. **EDIT** `app/electron-builder.yml` (hardenedRuntime, entitlements, extendInfo)
9. **EDIT** `app/src/renderer/features/voice/VoicePill.tsx` (subscribe to `voice:dispatch-echo`, show routing toast)
10. **EDIT** `pnpm-workspace.yaml` (add `app/native/*`)
11. **NO CHANGE** `app/electron/main.ts`, `app/src/renderer/lib/voice.ts` (Web Speech stays as fallback)

---

## 13. References

- node-addon-api ThreadSafeFunction: https://github.com/nodejs/node-addon-api/blob/main/doc/threadsafe.md
- prebuildify: https://github.com/prebuild/prebuildify
- codebytere/node-mac-permissions — auth + TSFN reference impl
- sveinbjornt/hear — full Speech.framework + AVAudioEngine pipeline in Swift (port to Obj-C++)
- Apple SFSpeechAudioBufferRecognitionRequest: https://developer.apple.com/documentation/speech/sfspeechaudiobufferrecognitionrequest
- Apple Hardened Runtime entitlements: https://developer.apple.com/documentation/security/hardened_runtime
