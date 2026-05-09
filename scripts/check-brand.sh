#!/usr/bin/env bash
# Fail PR if any user-visible string in app/src/renderer mentions
# BridgeSpace, BridgeSwarm, or BridgeCanvas (case-insensitive).
# Excludes comments, doc strings, test files, the bridge-agent/ directory naming.
set -e
HITS=$(rg -i --type-add 'tsx:*.tsx' --type tsx -l 'bridgespace|bridgeswarm|bridgecanvas' app/src/renderer/ | grep -v 'bridge-agent/' || true)
if [ -n "$HITS" ]; then
  echo "Brand drift detected in: $HITS"
  exit 1
fi
exit 0
