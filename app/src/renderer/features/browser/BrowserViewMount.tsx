// `<BrowserViewMount />` is the renderer-side placeholder for the main-process
// `WebContentsView`. The renderer never owns a real Chromium frame here — the
// component reports its bounding rect over IPC and the main process uses
// `view.setBounds(...)` to position the WebContentsView underneath this div.
//
// Bounds are reported on:
//   • mount, with a ResizeObserver for size changes
//   • window resize (the parent BrowserWindow may be resized)
//   • visibility / unmount (we send `bounds=null` so the view is hidden)
//
// BUG-DF-01 (Phase 3 dogfood) — every `browser:state` event from the main
// process (page-title-updated, did-navigate, did-navigate-in-page) re-renders
// the parent BrowserRoom and produces a fresh `tabs` array reference, which
// re-renders BrowserRecents. ResizeObserver then fires for any sub-pixel
// settle, scheduling redundant `setBounds` IPCs that re-position the
// WebContentsView with identical coords — visible as a brief flicker. The fix
// is to (a) memoise leaf children (TabStrip, BrowserRecents, BrowserViewMount)
// so they don't re-render on prop-equal updates, and (b) dedupe the bounds
// payload here so identical rects no-op instead of firing IPC.

import { memo, useEffect, useRef } from 'react';
import { rpc } from '@/renderer/lib/rpc';

interface Props {
  workspaceId: string;
  visible: boolean;
}

interface SentBounds {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

function BrowserViewMountInner({ workspaceId, visible }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Last bounds payload actually sent over IPC. We compare by value and skip
  // duplicate sends — this is the BUG-DF-01 flicker fix. ResizeObserver can
  // fire multiple times for the same logical layout; without dedup each fire
  // round-trips through the main process and calls `view.setBounds()` which
  // is observable as a one-frame flash.
  const lastSentRef = useRef<SentBounds | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf: number | null = null;
    const send = () => {
      if (!visible) {
        // Only send the hide payload once per visibility transition.
        if (lastSentRef.current && !lastSentRef.current.visible) return;
        lastSentRef.current = { visible: false, x: 0, y: 0, width: 0, height: 0 };
        void rpc.browser.setBounds({ workspaceId, bounds: null }).catch(() => undefined);
        return;
      }
      const r = el.getBoundingClientRect();
      const next: SentBounds = {
        visible: true,
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      const prev = lastSentRef.current;
      if (
        prev &&
        prev.visible &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
      ) {
        return;
      }
      lastSentRef.current = next;
      void rpc.browser
        .setBounds({
          workspaceId,
          bounds: { x: next.x, y: next.y, width: next.width, height: next.height },
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
      // ghost browser pane covering it. Reset the sent-bounds memo so the
      // next mount re-sends bounds even if the rect happens to match.
      lastSentRef.current = null;
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

// React.memo lets BrowserRoom re-render on every `browser:state` broadcast
// (which we cannot avoid — tabs/url/title legitimately change) without
// reactivating this effect. The effect is keyed on `[workspaceId, visible]`
// only; we never want it to re-run for a tab title change.
export const BrowserViewMount = memo(BrowserViewMountInner);
