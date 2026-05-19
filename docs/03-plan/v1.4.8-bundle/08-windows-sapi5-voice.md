# Packet 08 — Native Windows SAPI5 voice binding

> **Effort**: L (~3-5d). **Tier**: v1.5.0 platform feature. **Delegate**: Sonnet (native code).
> **Blocks**: nothing. **Blocked by**: nothing.
> **Source brief**: `archive/v1.4.7-bundle/09-windows-sapi5-voice.md` (carried forward).
> **Status**: NOT STARTED — no skeleton created, no code touched.

---

## 1. Original brief summary (preserved)

The archived brief identified that Windows routes voice through Chromium's Web Speech API (requires internet, rate-limited, privacy-sensitive). SAPI5 ships with every Windows XP+ machine and supports fully offline TTS + STT. The brief proposed:

- `native/voice-win/` — new native module (C++/COM, mirroring `native/voice-mac/`)
- `native-win.ts` — TypeScript adapter, same shape as `native-mac.ts`
- Wire into `dispatcher.ts` with `win32` platform guard
- CI: `native-prebuild-win.yml` workflow, plus a prebuild step in `release-windows.yml`
- Tests: unit-mocked `native-win.test.ts`

Key SAPI5 interfaces identified:

| Need | Interface |
|------|-----------|
| TTS | `ISpVoice::Speak()` with `SPF_ASYNC` |
| Voice enumeration | `SpEnumTokens(SPCAT_VOICES, ...)` |
| STT | `ISpRecognizer` + `ISpRecoContext::CreateGrammar(SPGS_DICTATION)` |
| Mic input | `SpCreateDefaultObjectFromCategoryId(SPCAT_AUDIOIN, ...)` |

---

## 2. v1.4.8 review — what changed since the archive brief

### 2.1 voice-mac shipped in v1.4.7 — the reference implementation is now real

The `native/voice-mac/` module is production code, not a sketch. The actual shape (as of `main` post-v1.4.7) is:

```
native/voice-mac/
├── binding.gyp               ← node-gyp via node-addon-api 7.x, NAPI_VERSION=8
├── index.js                  ← node-gyp-build loader + buildStub() fallback
├── index.d.ts                ← full TypeScript surface contract
├── package.json              ← @sigmalink/voice-mac, private, os:[darwin,linux,win32]
└── src/
    ├── recognizer.h          ← C++ Recognizer singleton declaration
    ├── recognizer.mm         ← SFSpeechRecognizer + AVAudioEngine (ObjC++ / ARC)
    ├── sigmavoice_mac.mm     ← N-API entry point, exposes 9 exports
    ├── tsfn_bridge.h         ← RAII StringEmitter / ErrorEmitter for TSFNs
    └── tsfn_bridge.mm        ← TSFN bind/emit/release implementation
```

The JS contract exposed by `sigmavoice_mac.mm` is: `isAvailable`, `getAuthStatus`, `requestPermission`, `start`, `stop`, `onPartial`, `onFinal`, `onError`, `onState`. **voice-win must expose exactly the same surface** so `adapter.ts` + `native-win.ts` can share type definitions with `native-mac.ts`.

### 2.2 adapter.ts is mac-only — needs generalisation

`adapter.ts` (V1.1.1) is currently hardcoded for darwin:

- `selectEngine()` short-circuits with `if (process.platform !== 'darwin') return null;`
- `permissionRequest` returns `{ status: 'unsupported' }` on non-darwin
- `VoiceMode` union is `'auto' | 'web-speech' | 'native-mac' | 'off'` — needs `'native-win'`
- First-launch auto-enable path only fires on darwin

The adapter must be extended (not rewritten) to recognise `win32` + the win native module alongside the darwin path. The extension is additive: a new `loadNativeWin()` in `native-win.ts`, a `'native-win'` mode added to `VoiceMode`, and a platform-dispatch block in `selectEngine()`.

### 2.3 release-windows.yml — @electron/rebuild pattern confirmed

The existing release workflow already runs:

```yaml
- name: Rebuild native modules for Electron
  run: npx @electron/rebuild -f -w better-sqlite3 -w node-pty
```

This is the integration point. Add `voice-win` to the `-w` flag list once the module exists:

```yaml
run: npx @electron/rebuild -f -w better-sqlite3 -w node-pty -w @sigmalink/voice-win
```

This mirrors what v1.4.7 did for `voice-mac` on macOS (see `release-macos.yml`). The native module is compiled against Electron's bundled Node ABI at package time; end users never need Visual Studio tools.

### 2.4 native-prebuild-mac.yml — mirror for Windows, but tag-trigger caveat

The mac prebuild workflow uses `matrix: [macos-14 arm64, macos-13 x64]`. The `push: tags: ['v*']` trigger was **disabled** after 25 consecutive timeouts (see comment in `native-prebuild-mac.yml`, last line block). The Windows equivalent (`native-prebuild-win.yml`) should:

- Use only `workflow_dispatch` + `pull_request` path trigger for launch (same caution)
- Avoid `push: tags: ['v*']` until Windows runner availability is confirmed stable
- The prebuild commit-back job is optional for launch; the `release-windows.yml` rebuild step is the primary path

### 2.5 node-gyp-build loader pattern — use exactly voice-mac's loader

`index.js` in voice-mac uses `node-gyp-build` (not a hand-rolled `fs.existsSync` loop as in the original archived brief). The archived brief's `index.js` was a simpler draft. Use the `node-gyp-build` pattern instead:

```javascript
// native/voice-win/index.js  — authoritative pattern
'use strict';
const path = require('node:path');

function buildStub() {
  const noop = () => () => {};
  return {
    isAvailable() { return false; },
    requestPermission() { return Promise.resolve('not-determined'); },
    getAuthStatus() { return 'not-determined'; },
    start() {
      const err = new Error('voice-win unavailable on this platform');
      err.code = 'unsupported';
      return Promise.reject(err);
    },
    stop() { return Promise.resolve(); },
    onPartial: noop,
    onFinal: noop,
    onError: noop,
    onState: noop,
  };
}

let mod;
if (process.platform !== 'win32') {
  mod = buildStub();
} else {
  try {
    const loader = require('node-gyp-build');
    const native = loader(path.join(__dirname));
    mod = (native && typeof native.start === 'function') ? native : buildStub();
  } catch (_err) {
    mod = buildStub();
  }
}

module.exports = mod;
module.exports.default = mod;
```

---

## 3. COM threading model — STA vs MTA (critical design decision)

SAPI5 has a mandatory COM apartment requirement that has no macOS analogue. This must be decided before any code is written.

### 3.1 The rule

- `ISpVoice` (TTS): must be created and called from an **STA** (Single-Threaded Apartment) thread.
- `ISpRecognizer` (in-process, `CLSID_SpInprocRecognizer`): also STA. Created on the same thread as its `ISpRecoContext` and callbacks.
- `ISpRecognizer` (out-of-process, `CLSID_SpSharedRecognizer`): uses the Windows shared speech recognition service; COM marshalling handles cross-thread calls automatically. This is the **simpler** choice but gives less control over the audio pipeline.

### 3.2 Recommended approach — dedicated STA worker thread

The native module must spin exactly ONE dedicated STA thread at module init and marshal ALL SAPI5 calls through it. This is the same principle as voice-mac's audio thread isolation (where CoreAudio taps fire on a real-time queue, separate from the JS event loop).

```
JS thread (V8 / libuv)
    │
    │  N-API ThreadSafeFunction (non-blocking post)
    ▼
STA worker thread  ──→ CoInitialize(NULL)  [STA]
    │                  ISpVoice::Speak(text, SPF_ASYNC)
    │                  ISpRecognizer::CreateRecoContext()
    │                  Message pump: GetMessage / DispatchMessage
    │
    │  TSFN callback (back to JS thread)
    ▼
JS event loop  → onPartial / onFinal / onError / onState
```

The STA worker runs a Win32 message pump (`GetMessage` / `DispatchMessage`) because SAPI5 delivers recognition events via COM window messages on the creating STA thread. Without a message pump the `ISpRecoContext::SetNotifyWindowMessage` or `SetNotifyCallbackFunction` callbacks never fire.

### 3.3 Recognition callback strategy

Two options for SAPI5 STT event delivery:

| Option | Mechanism | Notes |
|--------|-----------|-------|
| **A — Window message (recommended)** | `ISpRecoContext::SetNotifyWindowMessage(hwnd, WM_APP+1, ...)` + `GetMessage` loop | Clean STA pattern; native window can be a hidden message-only `HWND_MESSAGE` window |
| **B — Win32 event** | `SetNotifyWin32Event()` + `WaitForSingleObject` in a loop | Avoids creating a window; slightly less idiomatic for COM |
| **C — Callback function** | `SetNotifyCallbackFunction(fn, ...)` | Fires on SAPI's internal thread — requires extra synchronisation back to STA |

**Option A** is recommended: create a hidden message-only window (`CreateWindowEx(0, ..., HWND_MESSAGE, ...)`) on the STA thread, register it with `SetNotifyWindowMessage`, and pump `GetMessage` in the thread loop. Each `WM_APP+1` arrival means a recognition event is ready; call `GetEvents` to drain the queue, then post results back to JS via TSFN.

### 3.4 In-process vs shared recogniser

- **Shared (`CLSID_SpSharedRecognizer`)**: uses the Windows speech recognition service that is already running. Lower resource use. Suitable for SigmaLink since we are not trying to own the microphone exclusively. COM marshalling is transparent. Downside: the shared service may be disabled by group policy in enterprise environments.
- **In-process (`CLSID_SpInprocRecognizer`)**: creates a private recogniser instance. Full control. Requires explicit audio input assignment (`ISpAudio`). Higher complexity.

**Recommend shared recogniser for v1.4.8**: matches the air-gap requirement (the Windows SR service is offline) and avoids owning the microphone exclusively, which reduces permission friction.

---

## 4. Cross-arch prebuild matrix

Windows ships on two architectures relevant to Electron 30 + Node 20:

| Arch | Runner | Notes |
|------|--------|-------|
| `x64` | `windows-latest` (default) | 90%+ of Windows user base |
| `arm64` | `windows-11-arm` (GitHub-hosted, available 2025+) | Surface Pro X / Copilot+ PCs |
| `ia32` | — | Do NOT support. Electron 30 dropped ia32 on Windows. |

The prebuild workflow matrix should mirror the mac pattern:

```yaml
matrix:
  include:
    - os: windows-latest
      arch: x64
    - os: windows-11-arm
      arch: arm64
```

`prebuildify --napi --strip --arch=${{ matrix.arch }}` produces:
- `prebuilds/win32-x64/node.napi.node`
- `prebuilds/win32-arm64/node.napi.node`

`node-gyp-build` resolves `${platform}-${arch}` automatically, so the loader is arch-agnostic.

**Note**: `windows-11-arm` runners were in public beta as of early 2026. Verify availability before enabling the arm64 matrix entry. A `continue-on-error: true` guard is acceptable for the arm64 row at launch.

---

## 5. Bundling strategy — ship prebuilds, not rebuild-on-install

The original brief offered a choice between prebuilds and rebuild-on-install. After observing the voice-mac approach in production:

- **Prebuilds are the only viable path for end users**: rebuilding requires Visual Studio Build Tools (~5 GB). Node-gyp on Windows without MSVS is a known support burden.
- The `release-windows.yml` `@electron/rebuild` step already handles the in-CI rebuild. The compiled `.node` binary ends up inside the asar/installer.
- The `node-gyp-build` loader in `index.js` finds `prebuilds/win32-${arch}/node.napi.node` first, then falls back to `build/Release/voice_win.node`. This means development builds (where a dev ran `node-gyp rebuild` locally) and packaged builds (prebuilds committed or rebuilt by CI) both work from the same loader.

**Decision**: commit prebuilds to `native/voice-win/prebuilds/` via `native-prebuild-win.yml` on `workflow_dispatch`. The release workflow's `@electron/rebuild` handles what ships in the installer.

---

## 6. File list (updated from archived brief)

| File | Status | Notes |
|------|--------|-------|
| `native/voice-win/binding.gyp` | NEW | Mirror mac binding.gyp; conditions `OS=="win"`, link `sapi.lib` |
| `native/voice-win/index.js` | NEW | `node-gyp-build` loader + buildStub (see §2.5) |
| `native/voice-win/index.d.ts` | NEW | Copy `voice-mac/index.d.ts`, rename type to `SigmaVoiceWin` |
| `native/voice-win/package.json` | NEW | `@sigmalink/voice-win`, `os: ["win32"]` |
| `native/voice-win/src/sigmavoice_win.cc` | NEW | N-API entry point (mirrors `sigmavoice_mac.mm`) |
| `native/voice-win/src/recognizer.h` | NEW | C++ Recognizer singleton declaration |
| `native/voice-win/src/recognizer.cc` | NEW | STA thread + SAPI5 ISpVoice/ISpRecognizer impl |
| `native/voice-win/src/tsfn_bridge.h` | NEW | Copy verbatim from voice-mac (C++, no ObjC) |
| `native/voice-win/src/tsfn_bridge.cc` | NEW | Copy verbatim from voice-mac (C++, no ObjC) |
| `app/src/main/core/voice/native-win.ts` | NEW | TypeScript adapter (mirrors `native-mac.ts`) |
| `app/src/main/core/voice/native-win.test.ts` | NEW | Unit tests with mocked native module |
| `app/src/main/core/voice/adapter.ts` | MODIFY | Add `'native-win'` to `VoiceMode`; extend `selectEngine()` for `win32` |
| `.github/workflows/native-prebuild-win.yml` | NEW | `workflow_dispatch` + PR trigger only at launch |
| `.github/workflows/release-windows.yml` | MODIFY | Add `-w @sigmalink/voice-win` to `@electron/rebuild` step |

**Do NOT touch**: `dispatcher.ts` (no changes needed — it operates on transcripts, not platform), `diagnostics.ts`, `types.ts` (no separate types.ts exists in the voice dir).

---

## 7. binding.gyp sketch (Windows conditions)

```gyp
{
  "targets": [
    {
      "target_name": "sigmavoice_win",
      "sources": [],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": [ "NAPI_VERSION=8" ],
      "conditions": [
        [ "OS==\"win\"", {
          "sources": [
            "src/sigmavoice_win.cc",
            "src/recognizer.cc",
            "src/tsfn_bridge.cc"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17", "/EHsc" ]
            }
          },
          "libraries": [
            "-lsapi.lib",
            "-lole32.lib",
            "-loleaut32.lib"
          ]
        }]
      ]
    }
  ]
}
```

Key differences from `voice-mac/binding.gyp`:
- `msvs_settings` replaces `xcode_settings`
- `sapi.lib`, `ole32.lib`, `oleaut32.lib` replace the `-framework` flags
- Source files are `.cc` (pure C++), not `.mm` (Objective-C++)
- No ARC; use smart pointers (`CComPtr<ISpVoice>`) from `<atlbase.h>` or manual `->Release()` pairs

---

## 8. adapter.ts extension (additive changes only)

```typescript
// Import alongside loadNative / isNativeMacVoiceAvailable:
import { loadNativeWin, isNativeWinVoiceAvailable } from './native-win';

// VoiceMode — add 'native-win':
export type VoiceMode = 'auto' | 'web-speech' | 'native-mac' | 'native-win' | 'off';

// selectEngine() — add win32 branch before the existing darwin short-circuit:
function selectEngine(): NativeVoiceModule | null {
  if (mode === 'off') return null;
  if (mode === 'web-speech') return null;
  if (process.platform === 'win32') {
    if (mode === 'native-win') return loadNativeWin();
    if (mode === 'auto') return isNativeWinVoiceAvailable() ? loadNativeWin() : null;
    return null;  // 'native-mac' forced on win32 → fall through to null
  }
  if (process.platform !== 'darwin') return null;
  if (mode === 'native-mac') return loadNative();
  // mode === 'auto'
  return isNativeMacVoiceAvailable() ? loadNative() : null;
}

// permissionRequest() — extend for win32:
// SAPI5 uses Windows microphone privacy settings; ISpRecognizer prompts
// automatically on first access. Return { status: 'granted' } optimistically
// (Windows handles the permission UI inline). If the mic is blocked by
// Windows privacy settings, ISpRecognizer::CreateRecoContext fails and the
// error surfaces through onError. Return 'unsupported' on other platforms.
```

**Important**: the `active.native: boolean` field in `ActiveSession` is already generic — it does not need a platform qualifier. The native callbacks (`onPartial`, `onFinal`, `onError`, `onState`) are shared by both native modules through the same `NativeVoiceModule` interface.

---

## 9. Tests

Identical structure to `native-mac.test.ts` (if one exists) or the archived brief's draft:

```typescript
// app/src/main/core/voice/native-win.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('loadNativeWin', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns null on non-win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { loadNativeWin } = await import('./native-win');
    expect(loadNativeWin()).toBeNull();
  });

  it('returns null when native module fails to load', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.doMock('../../../../../native/voice-win', () => {
      throw new Error('module not found');
    });
    const { loadNativeWin } = await import('./native-win');
    expect(loadNativeWin()).toBeNull();
  });

  it('exposes the NativeVoiceModule interface when native loads', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.doMock('../../../../../native/voice-win', () => ({
      isAvailable: vi.fn().mockReturnValue(true),
      speak: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([{ name: 'Microsoft David' }]),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue('granted'),
      getAuthStatus: vi.fn().mockReturnValue('granted'),
      onPartial: vi.fn().mockReturnValue(() => {}),
      onFinal: vi.fn().mockReturnValue(() => {}),
      onError: vi.fn().mockReturnValue(() => {}),
      onState: vi.fn().mockReturnValue(() => {}),
    }));
    const { loadNativeWin } = await import('./native-win');
    const mod = loadNativeWin();
    expect(mod).not.toBeNull();
    expect(mod!.isAvailable()).toBe(true);
  });
});
```

---

## 10. Verification

**CI (no Windows VM required)**:
```bash
pnpm exec vitest run src/main/core/voice/native-win.test.ts
```

**Local Windows build** (requires Windows machine or VM with Visual Studio Build Tools 2022):
```bat
cd native\voice-win
npx node-gyp configure build
node -e "const m=require('./'); console.log('isAvailable:', m.isAvailable());"
```

**Manual smoke on Windows 10/11**:
1. Build SigmaLink on Windows: `pnpm run build && pnpm exec electron-builder --win --publish never`
2. Open SigmaLink → Settings → Voice tab → confirm "Native voice (SAPI5)" shows green indicator
3. Trigger a Sigma turn that emits speech → audio plays via local SAPI (no network)
4. Use voice input: speak into mic → text appears in composer
5. Air-gapped repeat: disconnect network → repeat steps 3-4 → confirm offline behaviour

---

## 11. Risk register (updated)

| Risk | Severity | Mitigation |
|------|----------|------------|
| SAPI5 shared recogniser disabled by enterprise group policy | M | Detect at init; surface `voice:unavailable { reason: 'policy' }` to renderer |
| COM STA message pump blocks libuv event loop | H | Dedicated thread (§3); TSFN keeps cross-thread marshalling non-blocking |
| `windows-11-arm` runner availability in CI | L | `continue-on-error: true` for arm64 matrix row; x64 is the hard requirement |
| ATL (`atlbase.h`) not always present | M | Use manual `IUnknown::Release` + `CoCreateInstance` patterns rather than ATL `CComPtr` if MSVC Build Tools is the only guaranteed toolchain |
| SAPI5 voices poor quality (Microsoft David/Zira) | L | Document. Users can install neural voices from Microsoft Store. |
| Windows mic privacy settings block STT at runtime | M | ISpRecognizer fails with `E_ACCESSDENIED`; map to `no-permission` error code; surface re-grant path in Settings → Voice |
| node-gyp configure fails without `--msvs_version` | L | Add `"msvs_version": "2022"` to binding.gyp or pass via `npm_config_msvs_version` env var in the CI step |

---

## 12. Open questions

1. **TTS required for v1.4.8?** The archived brief included both TTS (`ISpVoice`) and STT (`ISpRecognizer`). The adapter.ts contract (`NativeVoiceModule`) has no `speak()` method — it is pure STT. Confirm whether TTS is in scope for this packet or deferred to a separate TTS packet.

2. **Shared vs in-process recogniser default**: §3.4 recommends shared. Confirm this is acceptable for the air-gapped enterprise use case (the shared service is part of Windows and is offline; in-process gives more control at higher complexity).

3. **Voice-win module name**: `@sigmalink/voice-win` (mirrors `@sigmalink/voice-mac`). Confirm whether this should be registered as a pnpm workspace member before dispatch, or continue with the `createRequire` relative-path pattern used by `native-mac.ts`.

4. **`windows-11-arm` runner availability**: check GitHub Actions billing tier supports arm64 Windows runners before enabling the matrix row.

5. **Packet 04 (global voice capture) interaction**: Packet 04 explores whisper.cpp for cross-platform offline STT. If whisper.cpp is selected for packet 04, it could obsolete this SAPI5 packet for the STT side (whisper.cpp works on Windows too). Confirm sequencing: should SAPI5-win ship as an interim binding, or wait for the packet 04 research decision? Given packet 04 is v1.5.0 and SAPI5 is ready to implement now, shipping them independently is acceptable.

---

## 13. Delegation brief

**Assign to**: Sonnet (native C++/COM + N-API implementation).

**Scope** (hard boundaries):
- Implement `native/voice-win/` skeleton + `native-win.ts` + `native-win.test.ts`
- Extend `adapter.ts` additively (VoiceMode + selectEngine)
- Add `native-prebuild-win.yml` (workflow_dispatch + PR trigger only)
- Add `-w @sigmalink/voice-win` to `release-windows.yml` rebuild step
- Tests pass on macOS/Linux CI (mocked); native build verified on Windows runner

**Do NOT**:
- Modify `dispatcher.ts`, `diagnostics.ts`
- Touch any other packet
- Bump version, write release notes, open PRs beyond this packet
- Add TTS unless Q1 above resolves in favour of it

**PR title**: `feat(v1.5.0): native Windows SAPI5 voice binding — offline STT via ISpRecognizer`

**Verification gate**: `pnpm run build && pnpm test` pass on main CI (macOS/Linux). Windows smoke test recorded and included in PR description.
