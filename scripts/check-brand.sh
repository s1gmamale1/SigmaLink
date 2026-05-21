#!/usr/bin/env bash
# Fail PR if any user-visible string in app/src/renderer reintroduces the
# legacy Bridge* branding (BridgeSpace, BridgeSwarm, BridgeCanvas), which was
# renamed to Sigma* (SigmaSpace, SigmaSwarm, SigmaCanvas).
set -e
HITS=$(rg -i --type-add 'tsx:*.tsx' --type tsx -l 'bridgespace|bridgeswarm|bridgecanvas' app/src/renderer/ || true)
if [ -n "$HITS" ]; then
  echo "Legacy brand drift detected in: $HITS"
  exit 1
fi
exit 0
