BridgeVoice is not signed with an Apple Developer ID and is not notarised
(membership costs $99/year — held until the project is funded).

On macOS Sequoia/Tahoe, dragging an un-notarised .app from a browser-
downloaded DMG into /Applications and double-clicking it shows:

  "Apple could not verify BridgeVoice is free of malware"

This is expected. Two ways past it:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPTION A — Terminal (fastest, one-time)

  Open Terminal and run:

    xattr -cr /Applications/BridgeVoice.app

  Then double-click BridgeVoice normally. No further prompts.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPTION B — System Settings

  1. Try to open BridgeVoice (double-click). The Gatekeeper dialog appears.
  2. Open System Settings → Privacy & Security.
  3. Scroll to the Security section. A line says "BridgeVoice was blocked..."
  4. Click "Open Anyway". Enter your password. BridgeVoice launches.
  5. All future opens work normally.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHY THIS HAPPENS

  Apple Developer ID certificates cost $99/year and require an Apple
  Developer Program membership. BridgeVoice is currently internal-use
  software. Once funded, installers will be notarised and this README
  will be removed.

  The app is NOT malicious. Source code:
    https://github.com/s1gmamale1/SigmaLink

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
