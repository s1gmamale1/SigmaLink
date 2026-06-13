// Both macOS (`titleBarStyle: 'hiddenInset'`) and Windows (`'hidden'` +
// `titleBarOverlay`) run without a native draggable frame, so the chrome must
// declare its own drag region or the window becomes immovable. Without an
// explicit `WebkitAppRegion: 'drag'` the window can't be moved; interactive
// children inside a drag region then need `'no-drag'` so their clicks register
// instead of starting a window drag. Linux keeps the native frame
// (`titleBarStyle: 'default'`), so no region is needed there.
//
// These helpers return typed CSSProperties so callers don't repeat the
// vendor-prefix dance, and give us a single chokepoint to extend if Electron
// changes the API.

import type { CSSProperties } from 'react';
import { PLATFORM_IS_MAC } from './shortcuts';
import { IS_WIN32 } from './platform';

type WebKitAppRegion = 'drag' | 'no-drag';

interface DragCSS extends CSSProperties {
  WebkitAppRegion?: WebKitAppRegion;
}

// Platforms whose main window has no native draggable frame.
const NEEDS_CUSTOM_DRAG_REGION = PLATFORM_IS_MAC || IS_WIN32;

/** Apply to a chrome container that should drag the window. macOS + Windows. */
export function dragStyle(): DragCSS {
  return NEEDS_CUSTOM_DRAG_REGION ? { WebkitAppRegion: 'drag' } : {};
}

/** Apply to interactive children inside a `dragStyle()` container so clicks register. */
export function noDragStyle(): DragCSS {
  return NEEDS_CUSTOM_DRAG_REGION ? { WebkitAppRegion: 'no-drag' } : {};
}
