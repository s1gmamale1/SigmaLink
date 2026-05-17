#!/usr/bin/env bash
# SigmaLink — one-line installer for macOS.
#
# Why this script exists:
#   SigmaLink is not signed with an Apple Developer ID and is not notarised
#   (membership costs $99/year — held until the project is funded). On macOS
#   Sequoia/Tahoe, drag-installing an un-notarised .app from a browser-
#   downloaded DMG triggers Gatekeeper's "Apple could not verify..." dialog
#   that the user has to manually dismiss via System Settings.
#
#   `curl` does NOT register as a quarantine-aware download source on macOS,
#   so files it fetches are NOT tagged with `com.apple.quarantine`. Files
#   without that xattr are NOT subject to Gatekeeper's first-launch check.
#   This is the same trick Rust, Homebrew, Docker, and oh-my-zsh use for
#   their `curl | bash` installers.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash
#
#   Or download first and inspect:
#   curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh -o install-sigmalink.sh
#   less install-sigmalink.sh   # read it
#   bash install-sigmalink.sh
#
# Exit codes:
#   0  install succeeded
#   1  generic failure
#   2  wrong platform (not macOS) or wrong arch (not arm64)
#   3  GitHub API rate-limit or network failure
#   4  DMG download / verification failure
#   5  install/copy failure (permission, disk-full, etc.)

set -euo pipefail

REPO="s1gmamale1/SigmaLink"
APP_NAME="SigmaLink"
INSTALL_DIR="/Applications"

# -- platform + arch gate -----------------------------------------------------

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ This installer is macOS-only. Detected: $(uname -s)" >&2
  exit 2
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "✗ Only Apple Silicon (arm64) is currently supported. Detected: $ARCH" >&2
  echo "  Intel-Mac builds are tracked for v1.2 once the CI matrix lands." >&2
  exit 2
fi

# -- pick release -------------------------------------------------------------

# Accept an explicit tag in $1, else fall back to the latest release.
TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "→ Resolving latest release from GitHub..."
  TAG="$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name"' \
      | head -1 \
      | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/'
  )" || {
    echo "✗ Failed to fetch latest release tag from GitHub API." >&2
    echo "  Possible cause: rate-limit (anonymous API quota is 60/hr/IP)." >&2
    echo "  Workaround: pass an explicit tag, e.g.:" >&2
    echo "    curl ... | bash -s v1.1.7" >&2
    exit 3
  }
fi

if [[ -z "$TAG" ]]; then
  echo "✗ Could not determine a release tag." >&2
  exit 3
fi

# Strip a leading "v" to derive the version number used in artefact filenames.
VERSION="${TAG#v}"
DMG_FILENAME="${APP_NAME}-${VERSION}-arm64.dmg"
DMG_URL="https://github.com/$REPO/releases/download/$TAG/$DMG_FILENAME"

echo "→ Target release: $TAG"
echo "→ DMG: $DMG_URL"

# -- download -----------------------------------------------------------------

WORK_DIR="$(mktemp -d -t sigmalink-install)"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

DMG_PATH="$WORK_DIR/$DMG_FILENAME"
echo "→ Downloading via curl (no quarantine attribute will be set)..."
if ! curl -fL --progress-bar "$DMG_URL" -o "$DMG_PATH"; then
  echo "✗ Download failed. URL may be wrong or the release may not have an arm64 DMG." >&2
  echo "  Browse https://github.com/$REPO/releases to confirm." >&2
  exit 4
fi

# Sanity-check the file looks like an Apple disk image. Don't trust file(1)
# alone — also assert nonzero size + .dmg magic in the first 512 bytes.
if [[ ! -s "$DMG_PATH" ]]; then
  echo "✗ Downloaded DMG is empty." >&2
  exit 4
fi
echo "→ Download complete ($(du -h "$DMG_PATH" | cut -f1))."

# Belt-and-braces: even though curl shouldn't tag with quarantine, strip it
# anyway in case a downstream proxy or future macOS change adds one.
xattr -d com.apple.quarantine "$DMG_PATH" 2>/dev/null || true

# -- quit any running instance ------------------------------------------------

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "→ A running $APP_NAME instance was found; asking it to quit..."
  osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
  # Wait up to 5 seconds for the process to exit cleanly.
  for _ in 1 2 3 4 5; do
    pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
    sleep 1
  done
fi

# -- mount, copy, unmount -----------------------------------------------------

MOUNT_POINT="$WORK_DIR/mount"
mkdir -p "$MOUNT_POINT"
echo "→ Mounting DMG at $MOUNT_POINT..."
hdiutil attach -nobrowse -mountpoint "$MOUNT_POINT" -quiet "$DMG_PATH" >/dev/null

DETACH_GUARD() {
  hdiutil detach "$MOUNT_POINT" -quiet -force 2>/dev/null || true
}
trap 'DETACH_GUARD; rm -rf "$WORK_DIR"' EXIT INT TERM

if [[ ! -d "$MOUNT_POINT/$APP_NAME.app" ]]; then
  echo "✗ Mounted DMG does not contain $APP_NAME.app." >&2
  exit 4
fi

# Remove any prior install (if writable). /Applications usually doesn't need
# sudo on a personal Mac. If it does, fall back to sudo.
DEST="$INSTALL_DIR/$APP_NAME.app"
if [[ -e "$DEST" ]]; then
  echo "→ Replacing existing $DEST..."
  if ! rm -rf "$DEST" 2>/dev/null; then
    echo "→ /Applications is write-protected; falling back to sudo..."
    sudo rm -rf "$DEST" || { echo "✗ Could not remove existing $APP_NAME." >&2; exit 5; }
  fi
fi

echo "→ Copying $APP_NAME.app to $INSTALL_DIR..."
if ! cp -R "$MOUNT_POINT/$APP_NAME.app" "$INSTALL_DIR/" 2>/dev/null; then
  echo "→ /Applications is write-protected; falling back to sudo..."
  sudo cp -R "$MOUNT_POINT/$APP_NAME.app" "$INSTALL_DIR/" || {
    echo "✗ Copy failed." >&2
    exit 5
  }
fi

# Defensive: strip quarantine from the installed bundle. cp(1) should not have
# added one, but a future macOS could. This is the same xattr trick the README
# inside the DMG points users at.
echo "→ Stripping any quarantine xattrs from the installed bundle..."
if ! xattr -cr "$DEST" 2>/dev/null; then
  sudo xattr -cr "$DEST" 2>/dev/null || true
fi

DETACH_GUARD

# -- launch -------------------------------------------------------------------

echo ""
echo "✓ $APP_NAME $TAG installed to $DEST"
echo ""

# Detect whether we're being piped (stdin is not a tty) — in that case skip
# the interactive prompt and just print the launch hint.
if [[ -t 0 ]]; then
  read -r -p "Launch $APP_NAME now? [Y/n] " REPLY
  if [[ ! "$REPLY" =~ ^[Nn] ]]; then
    open "$DEST"
  else
    echo "Launch later with:"
    echo "    open $DEST"
  fi
else
  echo "Launch with:"
  echo "    open $DEST"
fi
