// Bridge tab body for the right-rail. V3-W13-012 wires the Bridge Assistant
// chat panel + orb into this slot (the right-rail owner reserved this file
// as the integration point so the rail's own structure stays untouched).
//
// The component is intentionally tiny: it just hosts BridgeRoom in `rail`
// variant so the chrome adapts to the narrow column. The standalone /bridge
// route mounts the same component with `variant='standalone'` (see App.tsx).

import { BridgeRoom } from '@/renderer/features/bridge-agent/BridgeRoom';

export function BridgeTabPlaceholder() {
  return <BridgeRoom variant="rail" className="h-full min-h-0 flex-1" />;
}
