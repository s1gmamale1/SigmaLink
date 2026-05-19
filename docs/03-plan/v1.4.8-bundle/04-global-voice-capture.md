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
