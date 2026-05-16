// Sigma tab body for the right-rail. V3-W13-012 wires the Sigma Assistant
// chat panel + orb into this slot (the right-rail owner reserved this file
// as the integration point so the rail's own structure stays untouched).
//
// The component is intentionally tiny: it just hosts SigmaRoom in `rail`
// variant so the chrome adapts to the narrow column. The standalone /sigma
// route mounts the same component with `variant='standalone'` (see App.tsx).
//
// Bundle-lazy: SigmaRoom is dynamically imported via React.lazy so its
// 1.7K-LOC tree (and the chat surface it pulls in) stays out of the main
// chunk. The wrapping Suspense boundary keeps the rail slot stable while
// the chunk streams in.

import { Suspense, lazy } from 'react';

const SigmaRoom = lazy(() =>
  import('@/renderer/features/sigma-assistant/SigmaRoom').then((m) => ({
    default: m.SigmaRoom,
  })),
);

export function SigmaTabPlaceholder() {
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
      <SigmaRoom variant="rail" className="h-full min-h-0 flex-1" />
    </Suspense>
  );
}
