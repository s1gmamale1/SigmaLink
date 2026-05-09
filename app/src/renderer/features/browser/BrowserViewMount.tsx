// `<BrowserViewMount />` is the renderer-side placeholder for the main-process
// `WebContentsView`. The renderer never owns a real Chromium frame here — the
// component reports its bounding rect over IPC and the main process uses
// `view.setBounds(...)` to position the WebContentsView underneath this div.
//
// Bounds are reported on:
//   • mount, with a ResizeObserver for size changes
//   • window resize (the parent BrowserWindow may be resized)
//   • visibility / unmount (we send `bounds=null` so the view is hidden)

import { useEffect, useRef } from 'react';
import { rpc } from '@/renderer/lib/rpc';

interface Props {
  workspaceId: string;
  visible: boolean;
}

export function BrowserViewMount({ workspaceId, visible }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf: number | null = null;
    const send = () => {
      if (!visible) {
        void rpc.browser.setBounds({ workspaceId, bounds: null }).catch(() => undefined);
        return;
      }
      const r = el.getBoundingClientRect();
      void rpc.browser
        .setBounds({
          workspaceId,
          bounds: {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        })
        .catch(() => undefined);
    };

    const sched = () => {
      if (raf != null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(send);
    };

    sched();

    const ro = new ResizeObserver(sched);
    ro.observe(el);

    window.addEventListener('resize', sched);
    window.addEventListener('scroll', sched, true);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sched);
      window.removeEventListener('scroll', sched, true);
      if (raf != null) cancelAnimationFrame(raf);
      // Pop the WebContentsView off when this component unmounts so the user
      // sees the room they navigated to (Memory, Settings, etc.) without a
      // ghost browser pane covering it.
      void rpc.browser.setBounds({ workspaceId, bounds: null }).catch(() => undefined);
    };
  }, [workspaceId, visible]);

  return (
    <div
      ref={ref}
      className="relative min-h-0 flex-1 bg-card"
      // The WebContentsView lives above this DOM node — we size and position
      // it absolutely from the main process. Showing a subtle background lets
      // the user see "browser pane" before the content paints.
    />
  );
}
