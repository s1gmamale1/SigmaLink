// v1.4.6 frameless chrome — `titleBarStyle: 'hidden'` is now active on all
// platforms (macOS, Windows, Linux). Without an explicit
// `WebkitAppRegion: 'drag'` region the window is immovable on every platform.
// These helpers return typed CSSProperties so callers don't repeat the
// vendor-prefix dance, and give us a single chokepoint to extend if Electron
// changes the API.
//
// Pre-v1.4.6 the drag was macOS-only because Windows used `titleBarStyle:
// 'default'` which provided its own drag region. With the overlay model the
// drag handling is shared, so both helpers now apply unconditionally.

import type { CSSProperties } from 'react';

type WebKitAppRegion = 'drag' | 'no-drag';

interface DragCSS extends CSSProperties {
  WebkitAppRegion?: WebKitAppRegion;
}

/** Apply to a chrome container that should drag the window. */
export function dragStyle(): DragCSS {
  return { WebkitAppRegion: 'drag' };
}

/** Apply to interactive children inside a `dragStyle()` container so clicks register. */
export function noDragStyle(): DragCSS {
  return { WebkitAppRegion: 'no-drag' };
}
