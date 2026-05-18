# Packet 09 — Native Windows SAPI5 voice binding

> **Effort**: L (~3-5d). **Tier**: v1.3 platform. **Delegate**: Sonnet (native code).
> **Blocks**: nothing. **Blocked by**: nothing.

## Problem

`app/src/main/core/voice/native-mac.ts` provides offline TTS + STT on macOS via `Speech.framework`. On Windows the dispatcher (`dispatcher.ts`) gates non-darwin to `null` (line 107 of `native-mac.ts`, or wherever the dispatcher falls through), so Windows voice routes through Chromium's Web Speech API which:
- Requires internet (Google's cloud STT)
- Won't work in air-gapped environments
- Has rate limits on free tier
- Sends audio to Google servers (privacy concern)

Windows ships SAPI5 (Speech Application Programming Interface 5) since Windows XP. Offline. Built-in. We just need a node-gyp binding.

## Reference implementation

`native/voice-mac/` is the template. Structure:

```
native/voice-mac/
├── binding.gyp          ← node-gyp build config
├── index.js              ← JS wrapper that loads the .node binary
├── src/
│   ├── voice.cc          ← C++ binding code (uses Speech.framework via Objective-C++)
│   └── voice.h
└── package.json
```

Mirror for `native/voice-win/`:

```
native/voice-win/
├── binding.gyp
├── index.js
├── src/
│   ├── voice.cc          ← C++ binding (uses ISpVoice + ISpRecognizer COM)
│   └── voice.h
└── package.json
```

## SAPI5 API surface

| Need | SAPI5 interface | Notes |
|---|---|---|
| TTS (text → audio) | `ISpVoice::Speak()` | Async via SPF_ASYNC flag; on Speak, fire callback. |
| Enumerate voices | `SpEnumTokens(SPCAT_VOICES, ...)` | Returns list of installed voices. |
| STT (audio → text) | `ISpRecognizer::CreateRecoContext()` + `ISpRecoContext::CreateGrammar()` | Use SPGS_DICTATION for free-form. Microsoft Speech Recognizer 5.4 engine ships with Windows 10/11. |
| Microphone input | `SpCreateDefaultObjectFromCategoryId(SPCAT_AUDIOIN, ...)` | Selects default audio input device. |

## node-gyp binding outline

```cpp
// native/voice-win/src/voice.cc
#include <napi.h>
#include <sapi.h>
#include <sphelper.h>

class WinVoice : public Napi::ObjectWrap<WinVoice> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  WinVoice(const Napi::CallbackInfo& info);
  ~WinVoice();

  Napi::Value Speak(const Napi::CallbackInfo& info);
  Napi::Value ListVoices(const Napi::CallbackInfo& info);
  Napi::Value StartRecognition(const Napi::CallbackInfo& info);
  Napi::Value StopRecognition(const Napi::CallbackInfo& info);

 private:
  ISpVoice* tts_;
  ISpRecognizer* recognizer_;
  ISpRecoContext* reco_ctx_;
};
```

JS wrapper:

```javascript
// native/voice-win/index.js
'use strict';

const path = require('node:path');
const fs = require('node:fs');

function tryLoad(file) {
  try {
    return require(file);
  } catch {
    return null;
  }
}

const candidates = [
  path.join(__dirname, 'build', 'Release', 'voice_win.node'),
  path.join(__dirname, 'prebuilds', `${process.platform}-${process.arch}`, 'voice_win.node'),
];

let binding = null;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    binding = tryLoad(c);
    if (binding) break;
  }
}

module.exports = binding;  // null on macOS/Linux — dispatcher handles it
```

## Dispatcher integration

```typescript
// app/src/main/core/voice/native-win.ts (NEW)
import type { VoiceDriver } from './types';

let native: typeof import('../../../../../native/voice-win') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  native = require('../../../../../native/voice-win');
} catch {
  native = null;
}

export const winSapi5Driver: VoiceDriver | null = native
  ? {
      kind: 'win-sapi5',
      speak: async (text: string, opts) => native!.speak(text, opts),
      listVoices: async () => native!.listVoices(),
      startRecognition: async (cb) => native!.startRecognition(cb),
      stopRecognition: async () => native!.stopRecognition(),
    }
  : null;
```

Update `dispatcher.ts` to prefer `winSapi5Driver` on win32, fall through to Web Speech API otherwise.

## CI prebuild

Reuse the existing `.github/workflows/native-prebuild-mac.yml` pattern. NEW workflow `native-prebuild-win.yml`:
- Trigger: `push` to `main` touching `native/voice-win/**`
- Runs on `windows-latest`
- Steps: `pnpm install` → `cd native/voice-win` → `npx node-gyp configure build` → upload `build/Release/voice_win.node` as artifact + commit to a `prebuilds/win32-x64/` directory in the repo.

OR simpler approach: bundle the prebuild step into the v1.4.7 release-windows workflow itself. The .node binary lands in `prebuilds/` AND in the final .exe asar package.

## Tests

Unit tests with mocked native module:

```typescript
// app/src/main/core/voice/native-win.test.ts (NEW)
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('winSapi5Driver', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null when native module is unavailable', async () => {
    vi.doMock('../../../../../native/voice-win', () => {
      throw new Error('module not found');
    });
    const { winSapi5Driver } = await import('./native-win');
    expect(winSapi5Driver).toBeNull();
  });

  it('exposes a VoiceDriver interface when native module loads', async () => {
    vi.doMock('../../../../../native/voice-win', () => ({
      speak: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([{ name: 'Microsoft David' }]),
      startRecognition: vi.fn(),
      stopRecognition: vi.fn(),
    }));
    const { winSapi5Driver } = await import('./native-win');
    expect(winSapi5Driver).toBeTruthy();
    expect(winSapi5Driver!.kind).toBe('win-sapi5');
    const voices = await winSapi5Driver!.listVoices();
    expect(voices[0].name).toBe('Microsoft David');
  });
});
```

## Files to touch

- `native/voice-win/` — NEW directory (binding.gyp, src/, index.js, package.json)
- `app/src/main/core/voice/native-win.ts` — NEW
- `app/src/main/core/voice/native-win.test.ts` — NEW
- `app/src/main/core/voice/dispatcher.ts` — wire winSapi5Driver
- `app/src/main/core/voice/types.ts` — add `'win-sapi5'` to VoiceDriverKind union
- `.github/workflows/native-prebuild-win.yml` — NEW
- `.github/workflows/release-windows.yml` — extend to include prebuild step
- `package.json` (root) — `optionalDependencies` may need adjustment

## Verification

Local (Windows VM only):
```bash
cd native/voice-win
npx node-gyp configure build
# Expected: build/Release/voice_win.node exists, no compile errors

cd /Users/aisigma/projects/SigmaLink/app
pnpm exec vitest run src/main/core/voice/native-win.test.ts
```

Manual smoke on Windows 11:
1. Build SigmaLink locally on Windows
2. Open SigmaLink, go to Settings → Voice tab
3. Confirm "Native voice (SAPI5)" indicator shows green
4. Trigger a Sigma turn that emits speech → audio plays via local SAPI
5. Use voice input: speak into mic → text appears in composer

Air-gapped test:
1. Disconnect from internet
2. Repeat the smoke test
3. Confirm voice still works

## Risk

- node-gyp build on Windows requires Visual Studio Build Tools (~5GB). Document this in CONTRIBUTING.md. The prebuilds avoid this for end users.
- SAPI5 voices are bundled with Windows; quality varies. Document expected behavior: "Microsoft David" / "Microsoft Zira" are the default voices; users can install higher-quality voices from Microsoft Store.
- COM threading: ISpVoice + ISpRecognizer must be created on the same thread. Bind everything to a single dedicated worker thread within the native module.

## Reporting back

PR title: `feat(v1.4.7): native Windows SAPI5 voice binding — offline TTS/STT`. Include the Windows VM smoke recording.
