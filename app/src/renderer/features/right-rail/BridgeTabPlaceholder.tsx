// Bridge tab body for the right-rail. V3-W13-012 wires the Bridge Assistant
// chat panel + orb into this slot (the right-rail owner reserved this file
// as the integration point so the rail's own structure stays untouched).
//
// The component is intentionally tiny: it just hosts BridgeRoom in `rail`
// variant so the chrome adapts to the narrow column. The standalone /bridge
// route mounts the same component with `variant='standalone'` (see App.tsx).
//
// Bundle-lazy: BridgeRoom is dynamically imported via React.lazy so its
// 1.7K-LOC tree (and the chat surface it pulls in) stays out of the main
// chunk. The wrapping Suspense boundary keeps the rail slot stable while
// the chunk streams in.

import { Suspense, lazy } from 'react';

const BridgeRoom = lazy(() =>
  import('@/renderer/features/bridge-agent/BridgeRoom').then((m) => ({
    default: m.BridgeRoom,
  })),
);

export function BridgeTabPlaceholder() {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-label="Loading Sigma Assistant"
          className="h-full min-h-0 flex-1 animate-pulse bg-muted/30"
        />
      }
    >
      <BridgeRoom variant="rail" className="h-full min-h-0 flex-1" />
    </Suspense>
  );
}
