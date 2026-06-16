#!/usr/bin/env bash
set -euo pipefail

REPO="s1gmamale1/SigmaLink"
APP_NAME="SigmaLink"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "x This installer is Linux-only. Detected: $(uname -s)" >&2
  exit 2
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" && "$ARCH" != "amd64" ]]; then
  echo "x Only Linux x64 is supported. Detected: $ARCH" >&2
  exit 2
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  ID="unknown"
  VERSION_ID="unknown"
fi

if [[ "${ID:-unknown}" != "ubuntu" ]]; then
  echo "x This installer supports Ubuntu 22.04/24.04. Detected: ${ID:-unknown} ${VERSION_ID:-unknown}" >&2
  echo "  Use the AppImage from GitHub Releases for other distributions." >&2
  exit 2
fi

case "${VERSION_ID:-unknown}" in
  22.04|24.04) ;;
  *)
    echo "x Supported Ubuntu versions are 22.04 and 24.04. Detected: ${VERSION_ID:-unknown}" >&2
    exit 2
    ;;
esac

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  TAG="$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name"' \
      | head -1 \
      | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/'
  )"
fi

if [[ -z "$TAG" ]]; then
  echo "x Could not determine release tag." >&2
  exit 3
fi

VERSION="${TAG#v}"
DEB_NAME="${APP_NAME}_${VERSION}_amd64.deb"
URL="https://github.com/$REPO/releases/download/$TAG/$DEB_NAME"
WORK_DIR="$(mktemp -d -t sigmalink-linux-install.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

DEB_PATH="$WORK_DIR/$DEB_NAME"
echo "-> Downloading $URL"
curl -fL --progress-bar "$URL" -o "$DEB_PATH"

echo "-> Installing $DEB_NAME"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get install -y "$DEB_PATH"
else
  sudo dpkg -i "$DEB_PATH"
fi

echo "OK: $APP_NAME $TAG installed."
