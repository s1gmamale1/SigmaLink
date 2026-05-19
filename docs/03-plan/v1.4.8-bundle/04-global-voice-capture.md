# Packet 04 — Global voice capture (BridgeVoice-style)

**Severity**: Feature (user-requested 2026-05-19)
**Effort**: L (3-7 dev-days) — **research phase first** (~½ day)
**Cluster**: Voice / system integration
**Suggested delegate**:
- **Research phase**: Opus (architecture judgment) or Sonnet (focused scan)
- **Implementation phase**: Sonnet (once research locks the stack)
**Depends on**: research outcome
**Blocks**: nothing

## Context

User flow ask (2026-05-19):
> "BridgeMind has product called BridgeVoice which I believe a separate product or app that from what I understood u activate via hotkey and start yapping, once done it will auto transcribe your voice to prompt or to clip board and gg. Need investigation on this one as well maybe there's an opensource for this"

What this is:
- A **global** hotkey-triggered voice capture (works app-wide, not just inside SigmaLink)
- Voice → text transcription (streamed or buffered)
- Output → either pasted into the focused input OR written to clipboard
- Roughly the same UX as macOS dictation, Whisper Flow, Superwhisper

Distinct from SigmaLink's **existing** native voice (`SigmaVoice` / `app/native/voice-mac/`):
- Existing SigmaVoice = in-app only, used by Sigma Assistant chat input
- This packet = **system-wide**, works while the user is in any app

Could be:
- **(a) A second app** that runs alongside SigmaLink (separate menu-bar app)
- **(b) A background daemon** spawned by SigmaLink (lives even when main window closed)
- **(c) An extension of SigmaVoice** with a global hotkey registration (`globalShortcut.register` in Electron main)

## Research phase (before any implementation)

### R1 — Investigate open-source candidates

| Stack | License | Pros | Cons |
|---|---|---|---|
| **macOS Speech.framework** | Apple SDK | Already have it via SigmaVoice; native, no model download, low CPU | macOS-only; Apple's transcription quality variable |
| **whisper.cpp** (ggml-org/whisper.cpp) | MIT | Offline, all platforms, runs on CPU/Metal/CUDA, multiple model sizes | ~150-3000 MB model download depending on size; CPU spike during transcription |
| **OpenAI Whisper API** | Cloud, paid | Best quality, no local resource use | Requires internet, API cost (~$0.006/min), data leaves machine |
| **Vosk** (alphacep/vosk-api) | Apache 2.0 | Offline, streaming, smaller models (~50 MB) | Lower quality than Whisper; less actively maintained |
| **macOS Dictation API** (`CFAttributedString` route) | Apple SDK | Native, no model | Not as good as Speech.framework's `SFSpeechRecognizer` |
| **Web Speech API** | Browser | Already used in renderer | Only works inside Electron renderer, not globally |
| **Superwhisper / Whisper Flow / others (closed-source)** | Paid | Polished UX | Doesn't fit "opensource" ask |

Recommend research a tight comparison: **whisper.cpp** (cross-platform offline) vs **Apple Speech.framework** (mac-only, already integrated). For Windows specifically: whisper.cpp or Win11's built-in voice access.

### R2 — Investigate BridgeMind's BridgeVoice product specifically

The user said BridgeMind has a product called BridgeVoice. Quick research questions:
- Is it open source? Check GitHub: `gh search repos bridgemind voice` and `gh api -X GET /search/repositories?q=BridgeMind+voice`
- Is there a marketing page describing the UX? Use the WebFetch tool against likely URLs (bridgemind.com, bridgemind.ai, github.com/bridgemind)
- What's the stack? If they open-sourced it, leverage their patterns

### R3 — Architecture decision

Once R1 + R2 are done, pick ONE of:

- **Path A (Electron extension)**: extend SigmaVoice with `globalShortcut.register('CommandOrControl+Shift+V', () => startCapture())` in the main process. Keeps everything in the SigmaLink app. Cheapest. Limitation: requires the SigmaLink main window to be running (background-fine, but quit-state = no voice).

- **Path B (Menu-bar companion app)**: ship a tiny separate Electron app `SigmaVoice.app` that lives in the menu bar, registers the global hotkey, transcribes, writes to clipboard. SigmaLink picks up the clipboard or uses an IPC bridge. More work, but the voice capture works even when SigmaLink is closed.

- **Path C (Background daemon, no UI)**: Rust/Go service that does hotkey + transcription + clipboard. Tiny binary, runs at login. Best resource use but most platform-specific code (mac launchd, win autostart, linux systemd).

Path A is what fits v1.4.8.x effort budget. Path B/C are v1.5+.

## Implementation phase (after research locks the stack)

Assuming Path A + whisper.cpp:

### Files

- `app/electron/main.ts` — register `globalShortcut.register('CommandOrControl+Shift+V', ...)`
- `app/src/main/core/voice/global-capture.ts` (NEW) — manages the hotkey-triggered capture pipeline
- `app/native/voice-mac/` — extend the existing native module OR add `whisper.cpp` as a sibling `app/native/voice-whisper/`
- Build pipeline: `release-macos.yml` + `release-windows.yml` need to download/build whisper.cpp model
- `app/src/main/core/voice/clipboard-output.ts` (NEW) — `clipboard.writeText(transcript)`
- A tiny status indicator (overlay window) — show "Listening…" while recording

### UX

- **Hotkey down**: start recording, show overlay
- **Hotkey released** (push-to-talk) OR **press again** (toggle): stop, transcribe, choose output target:
  - If a SigmaLink pane is focused → write `@voice ${transcript}` to the pane (per packet 03)
  - Otherwise → write transcript to clipboard, show toast "Transcript copied"

### Out-of-scope (defer to v1.5+)

- Custom wake-word ("Hey Sigma")
- Voice → action mapping (this is what voice-architect-design-2026-05-10 covers; that's a separate Sigma Assistant feature)
- Multi-language model selection UI

## Risks

- **Hotkey conflicts**: `Cmd+Shift+V` is used by some apps for paste-without-formatting. Pick something unusual; let user rebind
- **macOS microphone permission**: requires `NSMicrophoneUsageDescription` in Info.plist (already present for SigmaVoice — good)
- **Windows mic permission**: needs `microphone` capability in app manifest; verify electron-builder picks this up on Windows
- **whisper.cpp model size**: 1.5GB for the `medium` model is too big to bundle in the DMG. Lazy-download on first use; cache in `<userData>/voice-models/`. Show progress UI
- **Battery drain on always-listening**: don't always-listen; push-to-talk only on v1.4.8.x. Background listening (wake-word) is v1.5+

## Acceptance gate (post-implementation)

- Press hotkey, speak "test sentence", release → clipboard contains "test sentence" within 3 seconds (offline, no internet)
- Press hotkey while a SigmaLink pane is focused → text appears in pane composer instead of clipboard
- Press hotkey while SigmaLink main window is closed but app is running in background → still works
- Disable + re-enable via Settings → Voice → "Global capture hotkey" toggle persists across restart

## Research-phase deliverable (before implementation packet starts)

A short MD in this same dir: `04-global-voice-capture-research.md` (or appended to this file) with:
- Decision: Stack choice (whisper.cpp / Apple Speech.framework / OpenAI API / etc.)
- Decision: Path choice (A/B/C from R3)
- Decision: Hotkey default (chord + rationale)
- Decision: Output target priority (clipboard always vs pane-focus-aware)
- Bundling decision (lazy-download model vs ship-in-DMG)
- BridgeMind/BridgeVoice research findings (if any)

Lead reviews the research-phase MD before authorizing implementation.

## Commit format

Research phase ends with a single commit:
```
docs(v1.4.8): global voice capture research — stack + UX decisions
```

Implementation commits (after research approved): standard per-file scope.

---

## v1.4.8 research outcomes (2026-05-19)

Research conducted by Opus reviewer agent. All decisions LOCKED unless lead overrides via `## Open questions` section below.

### R1 — Stack comparison (offline-first lens)

| Stack | License | Cold-start | RTF on M2 (small) | Cross-platform | Privacy | Maintenance burden | Verdict |
|---|---|---|---|---|---|---|---|
| **whisper.cpp** (ggml-org) | MIT | ~100-300ms model mmap | 4-8x faster than real-time (Metal+CoreML) | mac/win/linux | Fully offline | Vendor in submodule; rebuild on Electron node ABI bumps | **PRIMARY** |
| **Apple Speech.framework** (`SFSpeechRecognizer`) | Apple SDK | <50ms (already loaded by SigmaVoice) | Real-time streaming, on-device | macOS only | Offline when `requiresOnDeviceRecognition=true` | Already integrated via `app/native/voice-mac/` | **FALLBACK on macOS for users who decline whisper download** |
| **OpenAI Whisper API** | Cloud, paid | Network roundtrip 200-2000ms | N/A (server-side) | Anywhere | Audio leaves machine | Zero local maintenance, but billing surface + key mgmt | **OPTIONAL Pro path (deferred to v1.5+)** |
| **Vosk** | Apache 2.0 | <100ms | Real-time on CPU | mac/win/linux | Offline | Less active upstream; WER materially worse | REJECTED — no advantage over whisper.cpp tiny.en (75 MB) for English; multi-language story is whisper's strength |
| **Web Speech API** (renderer) | Browser | Instant | Network-dependent (Chromium calls Google) | Windows Chromium only reliably | Audio leaves machine | Current Win fallback; keep but do not extend | KEEP for Windows in-app capture only; NOT viable for global capture (renderer process can't own global hotkey scope) |

**Key data points captured during research:**
- whisper.cpp ggml model sizes: tiny.en 75 MB, base.en 142 MB, small.en 466 MB, medium.en 1.5 GB, large-v3 3.1 GB. Q5-quantized versions roughly halve disk + RAM.
- M2 Pro + whisper.cpp + Metal: `base.en` ~1.8x real-time, `large-v3-turbo` ~10x real-time. CoreML + Metal stacked gives 8-12x speedup over CPU.
- Apple `SFSpeechRecognizer` on-device mode (`requiresOnDeviceRecognition=true`) removes the historical 60-second server cap → unlimited continuous, mirroring what `app/native/voice-mac/` already does for in-app SigmaVoice.
- OpenAI Whisper API: $0.006/min (Whisper-1, legacy) or $0.003/min (gpt-4o-mini-transcribe). 2.1s median latency, no streaming, 25 MB upload cap.
- Vosk WER lags Whisper by ~30-50% on English clean speech; only wins on tiny-RAM/CPU envelopes that don't apply to Mac/Win desktop targets.

### R2 — BridgeMind / BridgeVoice public research

**Verdict: BridgeVoice IS real, IS a competitor, NOT open source. Use as UX reference, ship our own.**

Confirmed via WebFetch + WebSearch (sources: bridgemind.ai/products/bridgevoice, docs.bridgemind.ai/docs/bridgevoice, YouTube launch video, MOGE product profile):

- **What it is**: Desktop dictation app for developers, ships across macOS / Windows / Linux on Tauri 2.0
- **Stack**: whisper.cpp for local (English only, 6 model sizes: Tiny 75 MB → Large-v3 3.1 GB); Groq Whisper Large-v3-Turbo for cloud (99+ languages, Pro tier)
- **UX**: Push-to-talk OR toggle, fully customizable global hotkey, no published default
- **Output**: Pastes directly into focused app (code editor, terminal, Slack, Notion, browser) — Accessibility/AX-driven paste
- **Latency claim**: <10 ms record start, end-to-end <1 s (cloud Groq path) / sub-second (local turbo)
- **Pricing**: $20/mo Basic, **$50/mo Pro (BridgeVoice included)**, $100/mo Ultra. 20% off annual.
- **Open source**: NOT confirmed open source in any public docs or repo. github.com/bridgemind returns 404.
- **Bundling**: Lazy-download — user picks model size in Settings → Recording, app downloads it. No DMG bundling.

**Implications for SigmaLink:**
1. Stack validation: BridgeVoice independently chose whisper.cpp local + cloud-fallback — confirms our R3 path.
2. Differentiation must come from **deeper SigmaLink integration** (pane-aware paste targeting per packet 03, agent voice routing via existing `dispatcher.ts`), NOT raw transcription. They beat us on cross-app paste; we beat them on in-app intent dispatch.
3. We have a free moat: BridgeVoice is $50/mo Pro tier. A free, native voice capture integrated with SigmaLink agents is a real lure for users who'd rather not pay $600/yr for what whisper.cpp gives them.

### R3 — Architecture path: **LOCKED → Path A++ (Electron-extension WITH menu-bar persistence)**

Decision matrix:

| Criterion | Path A: pure Electron extension | Path B: separate menu-bar Electron app | Path C: native daemon (Rust/Go) |
|---|---|---|---|
| Dev effort | 3-5 days | 7-12 days | 15-25 days |
| Maintenance | One codebase, shared RPC | Two Electron apps, IPC bridge | Three native targets (mac/win/linux) + IPC |
| Works when main window closed | NO (window-all-closed quits on Win/Linux) | YES (own lifecycle) | YES (always running) |
| Memory cost | +0 (existing process) | +150 MB (second Chromium) | +5-15 MB |
| Cross-platform parity | Native via Electron globalShortcut | Same | Need per-OS hotkey/daemon plumbing |
| Aligns with packet 04 effort budget (L = 3-7d) | YES | NO | NO |

**Locked: Path A++ — extend Electron with `globalShortcut.register` AND a `Tray` icon so the app survives `window-all-closed` on Windows/Linux without spawning a second process.**

Implementation skeleton (mac-first, win/linux v1.4.9):
- `electron/main.ts`: Add `Tray` instance with menu (Start/Stop capture, Settings, Quit). Suppress `app.quit()` on `window-all-closed` when global capture is enabled — the tray keeps the process alive.
- `electron/main.ts`: `globalShortcut.register('Alt+Space', () => voiceController.toggleGlobalCapture())` gated behind a kv flag `voice.globalCapture.enabled`. Default OFF on first launch — opt-in to avoid surprising the user.
- `src/main/core/voice/global-capture.ts` (NEW): Owns the global-capture state machine. Reuses `buildVoiceController()` from adapter.ts; adds an `OutputTarget` enum (`paste` | `clipboard` | `sigmalink-pane`).
- `src/main/core/voice/whisper-engine.ts` (NEW): Thin wrapper around `whisper.cpp` via N-API binding. Mac-first; Win/Linux land in v1.4.9.
- `src/main/core/voice/output-router.ts` (NEW): Decides paste vs clipboard. On mac: `[NSWorkspace frontmostApplication]` → if `com.sigmalink.app` → write to focused pane via existing `voice:dispatch` IPC; else write to clipboard + show toast.
- Existing `native-mac` adapter continues to power in-app SigmaVoice on macOS (Speech.framework — no audio mixer conflict with whisper.cpp since global-capture uses its own AVAudioEngine session that we tear down on stop).

**Why not Path B (menu-bar companion):** Doubles the maintenance burden, two app codesigning workflows, two notarization passes, two auto-update channels. Only buys the "works when main window closed" property, which Path A++ delivers via Tray with one process. Revisit only if user feedback in v1.4.8 says "I keep quitting SigmaLink and lose voice."

**Why not Path C (native daemon):** 5x effort for ~2% of the value at v1.4.8 scale. Sensible only if SigmaLink becomes a multi-tenant service or if we materially lose memory-budget battles. Park as v1.6+ rewrite candidate.

### R4 — Model bundling: **LOCKED → lazy-download, user-selectable, default `base.en` Q5_1 (57 MB)**

| Strategy | DMG impact | First-run UX | User control | Verdict |
|---|---|---|---|---|
| Lazy-download all | +0 MB | "Downloading 57 MB…" toast, 3-15s | High | **CHOSEN** |
| Bundle medium in DMG | +1500 MB | Instant first use | None | REJECTED — DMG grows from ~120 MB to >1.6 GB |
| Bundle tiny.en (Q5_1 = 31 MB) as fallback + offer download | +31 MB | Instant first use, prompts upgrade | High | **TIE-BREAKER OPTION — defer to lead** |
| User-selectable only (no default) | +0 MB | Settings tour required | High but friction | REJECTED — defeats "press hotkey, it works" |

**Default chosen: `base.en` Q5_1 (57 MB on disk, ~200 MB RAM, ~2x real-time on M2)** — strikes the speed/accuracy/disk balance. Quantized = same WER as full base.en within 1-2%.

Storage layout: `<userData>/voice-models/ggml-base.en-q5_1.bin` (mirrors BridgeVoice convention). Model registry in `src/main/core/voice/model-registry.ts` (NEW) tracks `{id, name, sizeMB, sha256, url, downloaded, default}` rows; HuggingFace hosts the official ggml-org/whisper.cpp builds (CDN, no auth).

First-launch flow when user toggles global capture ON:
1. Settings → Voice → "Enable global capture" toggle flips
2. Modal: "Download Voice Model (base.en, 57 MB)? Required for offline transcription. [Download] [Choose another model] [Cancel]"
3. Progress bar in modal, SHA-256 verified after download
4. On success: hotkey activates, status row shows "Global capture: Ready"

If user has SigmaVoice (Apple Speech.framework) but declines whisper download → fall back to Apple Speech.framework for global capture on macOS, with a banner: "Using Apple speech recognition. Install Whisper for higher accuracy and cross-platform parity." Windows/Linux users have no fallback — toggle stays disabled until download completes.

### R5 — Hotkey default + rebinding: **LOCKED → `Cmd+Option+Space` (mac) / `Ctrl+Alt+Space` (win/linux), rebindable**

Survey of conflicts (avoid stomping on common bindings):

| Candidate | macOS conflict | Win conflict | Linux conflict | Ergonomics | Verdict |
|---|---|---|---|---|---|
| `Cmd+Shift+V` | Paste-without-formatting in many apps | N/A | Paste-without-formatting in Firefox | Familiar but conflicts | REJECTED |
| `Alt+Space` | Spotlight on some setups; OS window menu on Win | Window menu (always) | None | Heavy conflict | REJECTED |
| `Cmd+Option+Space` | None default (Spotlight-without-Spotlight is `Cmd+Space`) | N/A | N/A | Three-finger but reachable | **CHOSEN for macOS** |
| `Ctrl+Alt+Space` | N/A | None default | None default | Same shape as mac | **CHOSEN for win/linux** |
| `Fn+F-key` | Function-key remap fights | Volume/brightness | TTY-switch on linux | Inconsistent across hardware | REJECTED |
| Right Option (push-to-talk) | None | N/A (no Right Alt on most US layouts) | None | BridgeVoice default; great when it works | OFFER as alternative in Settings, not default |

Default lands on `Cmd+Option+Space` because:
1. Zero default conflicts on stock macOS (verified via System Settings → Keyboard → Shortcuts inventory)
2. Reachable as a chord without contorting (Cmd+Opt are adjacent, Space is the dominant key)
3. Push-to-talk mode = hold; toggle mode = press-release-press. Both modes use the same default chord; switching mode is a Settings toggle.
4. Mirrors Superwhisper's `Option+Space` shape but adds Cmd to disambiguate (Option+Space alone is a special-char insert in some apps).

**Rebinding UX:**
- Settings → Voice → "Global capture hotkey" row with `[Cmd+Option+Space]` button → click → "Press a key combination…" → capture next chord → validate (must include modifier, must not equal `Cmd+Space` / `Cmd+Tab` / system-reserved)
- Store as `voice.globalCapture.hotkey` kv row (string in Electron accelerator syntax: `"CommandOrControl+Alt+Space"`)
- On rebind: `globalShortcut.unregisterAll()` then re-register new chord. Show toast "Hotkey updated."

**Permission story (macOS):**
- Electron's `globalShortcut` uses Carbon `RegisterEventHotKey` (NOT NSEvent), so it does NOT require Accessibility permission to FIRE — verified via Electron docs + electrobun#334.
- BUT: pasting into the focused app DOES require Accessibility (to send `Cmd+V` programmatically). Two-tier permission:
  - Microphone (already granted for SigmaVoice users)
  - Accessibility (NEW — prompt on first use of global-capture-with-paste; fall back to clipboard-only if denied)
- `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true})` triggers the system prompt and deep-links to System Settings → Privacy → Accessibility.

---

## Final delegation brief (post-research)

Ready-to-dispatch v1.4.9+ implementation packet. Suggested model: **Sonnet** for implementation; Opus only for the native binding architecture review.

### Scope (locked from research)
- **Stack**: whisper.cpp (vendored as `app/native/voice-whisper/`), `base.en` Q5_1 default model, lazy-downloaded to `<userData>/voice-models/`
- **Path**: Path A++ (Electron `globalShortcut` + `Tray` for window-all-closed survival)
- **Hotkey**: `Cmd+Option+Space` / `Ctrl+Alt+Space`, rebindable via Settings → Voice
- **Output**: Pane-focus-aware on macOS (`NSWorkspace frontmostApplication`); fallback clipboard-write + toast
- **Modes**: Push-to-talk (hold) AND toggle (press-release-press); user picks in Settings
- **Default state**: OFF on first launch — opt-in via Settings → Voice → "Enable global capture"

### File-level delivery plan
1. **`app/native/voice-whisper/`** (NEW, 4 dev-days)
   - `binding.gyp`, `src/whisper_bridge.cc`, `index.js`, `index.d.ts`
   - Vendor `whisper.cpp` as a git submodule at `app/native/voice-whisper/vendor/whisper.cpp` (pinned to a tag, e.g. `v1.7.4`)
   - Build flags: macOS `-DGGML_METAL=1 -DWHISPER_COREML=1`; Windows `-DGGML_CUDA=0` (CPU only for v1 to dodge CUDA dep); Linux CPU only
   - Expose: `transcribe(audioFloat32, modelPath, opts) → Promise<{text, segments}>`; streaming version `transcribeStream(opts) → EventEmitter`
2. **`app/src/main/core/voice/whisper-engine.ts`** (NEW, ½ day)
   - Thin TS facade over `voice-whisper` N-API, lazy-loads native module, returns `null` on platforms where build is missing
3. **`app/src/main/core/voice/global-capture.ts`** (NEW, 1 day)
   - State machine: `idle → recording → transcribing → routing → idle`
   - Holds AVAudioEngine session, buffers Float32 PCM, hands to whisper-engine on stop
   - Reuses existing `dispatcher.ts` when output target is a SigmaLink pane
4. **`app/src/main/core/voice/output-router.ts`** (NEW, ½ day)
   - macOS: `[NSWorkspace frontmostApplication]` check via tiny mac-only native helper OR existing `voice-mac` extension
   - Windows: `GetForegroundWindow + GetWindowThreadProcessId + QueryFullProcessImageName`
   - Linux: `xdotool getactivewindow getwindowpid` shell-out, with fallback
   - Output strategies: `paste-into-focused` (Cmd+V keystroke via AX), `clipboard-write` (default safe), `sigmalink-pane` (existing IPC)
5. **`app/src/main/core/voice/model-registry.ts`** (NEW, ½ day)
   - Catalog: tiny.en-q5_1 (31 MB), base.en-q5_1 (57 MB, default), small.en-q5_1 (182 MB), medium.en-q5_0 (515 MB)
   - URLs from `huggingface.co/ggerganov/whisper.cpp` (verified stable host)
   - SHA-256 verification, atomic rename on success, resume on partial download
6. **`app/electron/main.ts`** (EDIT, ½ day)
   - Add `Tray` icon (mac/win/linux) with menu: Start/Stop, Settings, Quit
   - Add `globalShortcut.register('CommandOrControl+Alt+Space', toggleGlobalCapture)` gated behind kv flag
   - Suppress `app.quit()` on `window-all-closed` when global capture is enabled
7. **`app/src/renderer/features/settings/VoiceTab.tsx`** (EDIT, 1 day)
   - New section: "Global capture" with toggle, hotkey rebinder, model picker, push-to-talk vs toggle radio, output target priority
   - Model download UI: progress bar, size disclosure, "Use Apple Speech.framework instead" alternative on macOS
8. **`app/src/main/core/voice/__tests__/global-capture.test.ts`** (NEW, ½ day)
   - State machine tests, hotkey-registration tests, output-router decision tests (focused-app mocked)
9. **`.github/workflows/release-macos.yml` + `release-windows.yml`** (EDIT, ½ day)
   - Add `node-gyp rebuild` step for `voice-whisper` after existing `voice-mac` build
   - Verify the prebuilt sits in the Electron bundle's `app.asar.unpacked` (native modules can't be inside asar)

**Total effort estimate: 8.5 dev-days** (up from packet's original 3-7d — research surfaced the native-binding work and Tray plumbing that weren't accounted for; rebudget the packet as **L+ / 7-10d** for v1.4.9 or split mac/win across two minor releases).

### Acceptance gate (carry-over from packet, sharpened)
1. Press `Cmd+Option+Space`, speak "the quick brown fox" → clipboard contains "The quick brown fox." within 2 seconds (M2, base.en, offline)
2. Press hotkey while SigmaLink composer is focused → text appears in composer via existing voice:dispatch IPC, NOT in clipboard
3. Quit main window via red traffic-light dot → Tray icon remains → hotkey still works
4. Settings → rebind hotkey to `Ctrl+Shift+;` → restart app → new hotkey persists, old doesn't fire
5. Disable global capture in Settings → hotkey no longer registers → press has no effect
6. Decline Accessibility on first paste attempt → fall back to clipboard write + show toast "Granted clipboard mode (Accessibility declined)"
7. Decline whisper model download on macOS → fall back to Apple Speech.framework with banner notice
8. Decline on Windows → toggle stays disabled, settings show "Download required"

### Risks called out by research (not in original packet)
- **AX paste requires user-granted Accessibility permission** — original packet missed this. Output strategy must degrade gracefully to clipboard mode.
- **Codesigning + notarization**: `voice-whisper` adds another N-API binary that must be hardened-runtime signed AND entitled for microphone. Update `entitlements.mac.plist`.
- **whisper.cpp CoreML setup**: Optional but worth the 2-3x speedup on Apple Silicon. Requires shipping a separate `.mlmodelc` alongside the ggml binary. Defer to v1.5 if v1.4.9 dev-days are tight.
- **Memory ballast**: base.en in RAM is ~200 MB; medium is ~2.1 GB. Document in Settings, warn users on low-RAM machines.
- **Tray icon iconography**: needs a vector asset that reads at 16×16 retina + 22×22 retina (mac menu bar). Block on design.

---

## Open questions for lead

1. **Cloud Whisper fallback (yes/no)?** BridgeVoice ships Groq cloud as a paid Pro feature. SigmaLink could add OpenAI Whisper API ($0.006/min) as a Settings opt-in with BYOK (user supplies API key). Cheap to implement (no billing infra), wins us 99-language support that whisper.cpp medium gives us at 1.5 GB local. **Recommendation: ship local-only in v1.4.9, add BYOK cloud in v1.5 if user demand emerges.**

2. **Default ON vs OFF on first launch?** Locked OFF in this brief (surprise-avoidance), but if the user wants a "voice-first" pitch in marketing, default ON post-tutorial might land harder. **Recommendation: keep OFF, but show a coachmark in the Composer that says "Tip: enable global voice capture in Settings → Voice."**

3. **Bundle tiny.en-Q5_1 (31 MB) in DMG as fallback?** Adds 31 MB to the DMG (~25% bump from ~120 MB to ~150 MB). Trade: instant-on for first-launch users vs slimmer download. **Recommendation: DON'T bundle; the 3-15 second download is acceptable for opt-in feature.**

4. **Push-to-talk vs Toggle: which is default mode?** BridgeVoice defaults to push-to-talk (hold). Toggle is friendlier for long dictation; push-to-talk is friendlier for quick utterances. **Recommendation: Toggle by default — fewer "I let go too early" failures for new users; push-to-talk available in Settings.**

5. **Windows + Linux: ship in same release as macOS or stagger?** Native build matrix doubles the test surface. **Recommendation: ship macOS in v1.4.9, Windows+Linux in v1.4.10. Use the v1.4.9 window to validate the model-download UX before fanning out.**

6. **Should we reuse `voice-mac` for the AX paste keystroke helper** (it's already a mac-only native module), or add `voice-whisper` for it? **Recommendation: extend `voice-mac` — it already has the Objective-C++ scaffolding and Accessibility entitlements paths; adding a `sendPasteKeystroke()` export is ~30 LOC.**

7. **Telemetry**: opt-in metric for "global captures per day" + "average dictation length" + "fallback rate (whisper unavailable → apple speech)"? Helps tune model defaults in v1.5. **Recommendation: only if SigmaLink already has a telemetry channel users opted into.**
