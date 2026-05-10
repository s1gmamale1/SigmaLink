// macOS uses `titleBarStyle: 'hiddenInset'` so there is no native frame to
// grab. Without explicit `WebkitAppRegion: 'drag'` the window is immovable.
// These helpers return typed CSSProperties so callers don't repeat the
// vendor-prefix dance, and give us a single chokepoint to extend if Electron
// changes the API.

import type { CSSProperties } from 'react';
import { PLATFORM_IS_MAC } from './shortcuts';

type WebKitAppRegion = 'drag' | 'no-drag';

interface DragCSS extends CSSProperties {
  WebkitAppRegion?: WebKitAppRegion;
}

/** Apply to a chrome container that should drag the window. macOS-only. */
export function dragStyle(): DragCSS {
  return PLATFORM_IS_MAC ? { WebkitAppRegion: 'drag' } : {};
}

/** Apply to interactive children inside a `dragStyle()` container so clicks register. */
export function noDragStyle(): DragCSS {
  return PLATFORM_IS_MAC ? { WebkitAppRegion: 'no-drag' } : {};
}
