// Transient zoom-level HUD. Subscribes to the zoom emitter; shows the current
// percent on each change and fades out ~1s after the last one. pointer-events
// off so it never intercepts input. Rendered once at the app root.

import { useEffect, useRef, useState } from 'react';
import { subscribeZoom } from '@/renderer/lib/zoom';

const HIDE_DELAY_MS = 1000;

export function ZoomIndicator() {
  const [percent, setPercent] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = subscribeZoom((pct) => {
      setPercent(pct);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setPercent(null), HIDE_DELAY_MS);
    });
    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (percent == null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-6 z-[9999] -translate-x-1/2 rounded-full border border-border/60 bg-card/90 px-3 py-1 text-sm font-medium tabular-nums text-foreground shadow-lg backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none"
    >
      {percent}%
    </div>
  );
}
