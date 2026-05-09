# BridgeSpace + BridgeVoice Changelog Summary
Source: https://www.bridgemind.ai/changelog (fetched 2026-05-09)

## BridgeSpace (@bridgespace-tauri)

| Version | Date | Highlights |
|---------|------|-----------|
| v3.0.9 | 2026-04-23 | Fix: WSL terminal startup resolves wsl.exe from System32. Add: session snapshots, editor theme updates. UI polish. |
| v3.0.8 | 2026-04-22 | Add: **Browser sidebar capability**, pane/session snapshot infrastructure. Fix: auth session refresh, security hardening. Change: Bridge Assistant voice flows, terminal cleanup, login UX. |
| v3.0.7 | 2026-04-22 | Fix: SSH/terminal/subscription handling. Add: mention textarea, transcript normalization, validation helpers. Change: push-to-talk shortcuts, runtime prompts, sidebar behavior. |
| v3.0.6 | 2026-04-22 | Fix: macOS release workflow at platform-aware Tauri wrapper. |
| v3.0.5 | 2026-04-22 | Fix: updater recovery, macOS rollout. Add: mic/updater error handling, terminal title helpers. Change: Bridge panel styling, settings surfaces. |
| v3.0.4 | 2026-04-21 | Fix: Windows deep-link trait import for compilation. Change: Cargo config alignment. |
| v3.0.3 | 2026-04-21 | Fix: blob: support added to script-src and worker-src. |
| v3.0.2 | 2026-04-21 | Fix: enabled macOSPrivateApi and audio-input entitlements. |
| v3.0.1 | 2026-04-20 | Fix: Bridge panel styles extraction to real CSS file. |

Notes
- v3 line begins on 2026-04-20 (initial v3.0.1).
- Browser sidebar shipped on 2026-04-22 in v3.0.8.
- Bridge Assistant voice integration referenced in v3.0.8.
- Built with Tauri (Rust + web stack).

## BridgeVoice (@bridgevoice)

| Version | Date | Highlights |
|---------|------|-----------|
| v2.2.22 | 2026-04-23 | Fix: desktop email/password sign-in; subscription refresh; macOS matrix race; multi-platform release workflow repair. |
| v2.2.20 | 2026-04-22 | Fix: Tailwind config restored for standalone builds. Change: changelog capture alongside hardening. |
| v2.2.19 | 2026-04-22 | Fix: Windows keyboard hook for push-to-talk; onboarding persistence. Change: floating pill now single-click toggle (was double-click). |
| v2.2.17 | 2026-04-13 | Fix: BridgeSpace dictation through dedicated IPC handoff. |
| v2.2.16 | 2026-04-11 | Fix: hook retry + exponential backoff; transparent widget rendering. Change: hook-error event, deferred listener startup. |
| v2.2.15 | 2026-04-11 | Fix: widget hit-area padding; microphone fallback resolution. |
| v2.2.14 | 2026-04-11 | Fix: Windows 11 opaque widget styling; tray icon behavior. |
| v1.0.0 | 2026-02-23 | Add: Whisper transcription, push-to-talk, floating widget, dashboard history. |

Notes
- v1.0.0 is the original BridgeVoice GA.
- Many April 2026 fixes target Windows widget rendering and macOS sign-in.
- IPC handoff to BridgeSpace ensures dictation works inside BridgeSpace panes.

## Cross-product observations
- Heavy April 2026 release cadence (8 BridgeSpace and 7 BridgeVoice releases in 4 days at peak).
- BridgeSpace v3 + BridgeVoice v2.2 are the current versions.
- No public changelog yet for BridgeMCP, BridgeCode, or BridgeMemory.
