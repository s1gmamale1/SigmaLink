// Root-mounted hook that wires the whole-app zoom gestures. Owns side-effect
// orchestration (apply → persist → notify HUD); the math/state lives in
// lib/zoom.ts. Mounted once in App (never unmounts).

import { useEffect } from 'react';
import { bindShortcut } from '@/renderer/lib/shortcuts';
import { isZoomWheel } from '@/renderer/lib/wheel-zoom';
import { notifyZoom, persistZoom, resetZoom, zoomByWheel, zoomIn, zoomOut } from '@/renderer/lib/zoom';

export function useZoomControls(): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!isZoomWheel(e)) return;
      // passive:false listener — suppress Chromium's native ctrl+wheel zoom so
      // we own the step, HUD, and persistence.
      e.preventDefault();
      const f = zoomByWheel(e.deltaY);
      persistZoom(f);
      notifyZoom(f);
    };
    window.addEventListener('wheel', onWheel, { passive: false });

    const after = (f: number) => {
      persistZoom(f);
      notifyZoom(f);
    };
    const unbinders = [
      bindShortcut('mod+=', (e) => {
        e.preventDefault();
        after(zoomIn());
      }),
      bindShortcut('mod+-', (e) => {
        e.preventDefault();
        after(zoomOut());
      }),
      bindShortcut('mod+0', (e) => {
        e.preventDefault();
        after(resetZoom());
      }),
    ];

    return () => {
      window.removeEventListener('wheel', onWheel);
      for (const off of unbinders) off();
    };
  }, []);
}
