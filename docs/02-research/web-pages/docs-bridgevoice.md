# BridgeVoice Documentation
URL: https://docs.bridgemind.ai/docs/bridgevoice
Fetched: 2026-05-09

## Headings (verbatim)
- BridgeVoice
- Key Features
- Installation: macOS, Windows, Linux (Experimental)
- Getting Started
- Transcription Modes: Local (Whisper), Model Sizes, Cloud
- Recording Modes: Push-to-Talk, Toggle Recording
- Text Injection
- Widget
- Custom Dictionary
- Transcription History
- Statistics
- Subscription Tiers
- System Requirements

## Keyboard shortcuts / hotkeys
- Push-to-Talk: configurable hotkey (default example: Right Option). Hold to record, release to transcribe.
- Toggle Recording: press once to start, again to stop.
- Text injection: Cmd+V (macOS), Ctrl+V (Windows).
- Widget: double-click to toggle recording.

## Whisper model sizes (verbatim table)
| Model | Size | Speed | Accuracy | Best For |
|-------|------|-------|----------|----------|
| Tiny | 75 MB | Fastest | Basic | Quick notes, commands |
| Base | 142 MB | Fast | Good | General dictation |
| Small | 466 MB | Moderate | Better | Longer dictation |
| Medium | 1.5 GB | Slower | Great | Detailed transcription |
| Large | 3.1 GB | Slowest | Best | Maximum accuracy |
| Distil-Large | ~1.5 GB | Fast | Great | Best speed-to-accuracy |

## Feature list (verbatim)
- On-device transcription (Whisper) with no cloud upload.
- Universal text injection across desktop apps.
- Sub-500ms latency.
- Offline support (local mode).
- Optional Groq cloud transcription (Pro only, 99+ languages).
- Push-to-Talk and Toggle recording.
- Custom dictionary for replacements.
- Local transcription history with metadata.

## Platform notes
- macOS: Apple Silicon uses Metal GPU (~10x faster). Intel uses CPU. Big Sur or later.
- Windows: Installer; Win 10+.
- Linux: AppImage / .deb (experimental); Ubuntu 20.04+.

## System requirements
- RAM: 4 GB min, 8 GB for Large.
- Disk: 200 MB + model size.

## Subscription tiers
- Free: on-device transcription, all Whisper models, PTT/Toggle, dictionary, history.
- Pro: cloud transcription (Groq), 99+ languages, AI text polish (soon), cross-device sync (soon).

## Source quote (≤15 words, in quotes)
"On-device transcription via Whisper (no cloud upload)."
