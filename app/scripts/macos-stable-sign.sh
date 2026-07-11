#!/usr/bin/env bash
# SigmaLink — create a STABLE local code-signing identity and re-sign the
# installed app so macOS TCC grants survive updates.
#
# The problem this fixes:
#   Release DMGs are ad-hoc signed (no Developer ID — membership is $99/yr,
#   see install-macos.sh). An ad-hoc signature's designated requirement is
#   the cdhash of ONE exact build:
#       designated => cdhash H"70f95937be..."
#   macOS TCC (System Settings → Privacy & Security) keys Screen Recording /
#   Accessibility / Input Monitoring grants to that requirement. Every
#   SigmaLink update changes the cdhash, so grants given to the previous
#   build stop matching — System Settings may still SHOW SigmaLink as
#   enabled while the live check fails. Symptom: Claude panes' computer-use
#   `request_access` loops on "macOS Accessibility and Screen Recording
#   permission(s) not yet granted" after every update.
#
# The fix:
#   Sign the installed app with a self-signed local certificate that has a
#   fixed Common Name. The designated requirement then becomes
#       identifier "com.sigmalink.agentorchestrator"
#       and certificate leaf = H"<cert hash>"
#   which is stable across updates as long as the SAME cert re-signs each
#   build. install-macos.sh re-signs automatically on every future install
#   once this identity exists, so this script is a one-time setup.
#
# Usage:
#   bash app/scripts/macos-stable-sign.sh           # create cert (once) + re-sign + reset stale TCC
#   bash app/scripts/macos-stable-sign.sh --check   # read-only: report signature state
#
# One-time GUI prompts you WILL see on first run:
#   1. A trust-settings confirmation (login password) when the new cert is
#      marked trusted for code signing.
#   2. codesign asking to use the new private key — click "Always Allow".
#
# After the first run: quit + relaunch SigmaLink, then re-grant Screen
# Recording + Accessibility ONCE in System Settings → Privacy & Security.
# That grant now survives all future updates.
#
# Exit codes:
#   0  success (or --check completed)
#   1  generic failure
#   2  wrong platform
#   3  app bundle not found

set -euo pipefail

APP="${SIGMALINK_APP:-/Applications/SigmaLink.app}"
IDENTITY_CN="SigmaLink Local Signing"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ macOS-only. Detected: $(uname -s)" >&2
  exit 2
fi

if [[ ! -d "$APP" ]]; then
  echo "✗ App bundle not found at $APP (override with SIGMALINK_APP=...)" >&2
  exit 3
fi

have_identity() {
  security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY_CN"
}

signature_report() {
  echo "→ Signature of $APP:"
  codesign -dv --verbose=2 "$APP" 2>&1 \
    | grep -E "^(Identifier|Signature|Authority|TeamIdentifier|CodeDirectory)" \
    | sed 's/^/    /' || true
  echo "→ Designated requirement:"
  codesign -d -r- "$APP" 2>/dev/null | grep "designated" | sed 's/^/    /' || true
}

if [[ "${1:-}" == "--check" ]]; then
  signature_report
  if codesign -d -r- "$APP" 2>/dev/null | grep -q 'certificate leaf'; then
    echo "✓ Stable identity signature — TCC grants survive updates."
  else
    echo "⚠ Ad-hoc (cdhash) signature — TCC grants break on every update."
    echo "  Fix: bash app/scripts/macos-stable-sign.sh"
  fi
  if have_identity; then
    echo "✓ Keychain identity '$IDENTITY_CN' present."
  else
    echo "⚠ Keychain identity '$IDENTITY_CN' not created yet."
  fi
  exit 0
fi

# -- 1. Ensure the local signing identity exists ------------------------------

if have_identity; then
  echo "→ Keychain identity '$IDENTITY_CN' already exists — reusing it."
else
  echo "→ Creating self-signed code-signing certificate '$IDENTITY_CN'..."
  WORK_DIR="$(mktemp -d -t sigmalink-sign)"
  trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

  # v3 extensions make the cert a valid code-signing leaf. A config file is
  # used instead of -addext for LibreSSL compatibility.
  cat > "$WORK_DIR/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_codesign
prompt = no
[dn]
CN = SigmaLink Local Signing
[v3_codesign]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF

  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -config "$WORK_DIR/openssl.cnf" \
    -keyout "$WORK_DIR/key.pem" -out "$WORK_DIR/cert.pem" 2>/dev/null

  # Bundle key+cert so `security import` accepts both in one shot. The
  # passphrase is transient — the .p12 is deleted with WORK_DIR on exit.
  P12_PASS="$(uuidgen)"
  openssl pkcs12 -export -inkey "$WORK_DIR/key.pem" -in "$WORK_DIR/cert.pem" \
    -out "$WORK_DIR/identity.p12" -passout "pass:$P12_PASS" 2>/dev/null

  KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
  security import "$WORK_DIR/identity.p12" -k "$KEYCHAIN" -P "$P12_PASS" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null

  # Self-signed leaf → trustRoot; scoped to code signing only. This is the
  # step that pops the one-time trust-settings password dialog.
  echo "→ Marking the certificate trusted for code signing (password dialog)..."
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" \
    "$WORK_DIR/cert.pem"

  if ! have_identity; then
    echo "✗ Identity not visible to codesign after import." >&2
    echo "  Open Keychain Access → login → '$IDENTITY_CN' → Trust →" >&2
    echo "  set 'Code Signing' to 'Always Trust', then re-run this script." >&2
    exit 1
  fi
  echo "✓ Identity created."
fi

# -- 2. Re-sign the installed app ----------------------------------------------

if pgrep -x "SigmaLink" >/dev/null 2>&1; then
  echo "⚠ SigmaLink is running — the new signature takes effect after relaunch."
fi

# Mirror scripts/adhoc-sign.cjs: deep re-sign, no timestamp, entitlements
# intentionally omitted (they only take effect with hardened runtime).
echo "→ Re-signing $APP with '$IDENTITY_CN'..."
if ! codesign --force --deep --sign "$IDENTITY_CN" --timestamp=none "$APP" 2>/dev/null; then
  echo "→ Retrying with sudo (root-owned bundle)..."
  sudo codesign --force --deep --sign "$IDENTITY_CN" --timestamp=none "$APP"
fi

codesign --verify --deep --strict "$APP"
signature_report

# -- 3. Drop stale TCC rows so the next grant binds to the new signature -------

BUNDLE_ID="$(defaults read "$APP/Contents/Info" CFBundleIdentifier)"
echo "→ Resetting stale TCC entries for $BUNDLE_ID..."
tccutil reset ScreenCapture "$BUNDLE_ID" 2>/dev/null || true
tccutil reset Accessibility "$BUNDLE_ID" 2>/dev/null || true
tccutil reset ListenEvent   "$BUNDLE_ID" 2>/dev/null || true

echo ""
echo "✓ Done. One-time follow-up:"
echo "  1. Quit + relaunch SigmaLink."
echo "  2. Use computer use in a pane once — grant Screen Recording +"
echo "     Accessibility when macOS asks. (Or pre-grant in System Settings →"
echo "     Privacy & Security.)"
echo "  These grants now SURVIVE updates: install-macos.sh re-signs every"
echo "  future install with '$IDENTITY_CN' automatically."
