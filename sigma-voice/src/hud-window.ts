// SigmaVoice — recording HUD overlay (main process)
//
// A tiny always-on-top overlay shown while dictation is recording/transcribing.
//
// THE CRUX — focus preservation:
//   SigmaVoice dictates into WHATEVER app the user has focused. The HUD must
//   therefore NEVER steal keyboard focus. We achieve this with a combination of
//   BrowserWindow flags + showInactive():
//     - `focusable: false`     — the OS will not give this window key focus.
//     - `show: false` + `showInactive()` — show the window WITHOUT activating
//       the app / making it key. (We never call `.show()`, `.focus()`,
//       `win.focus()` or `app.focus()`.)
//     - `type: 'panel'` (macOS) — the closest Electron has to a non-activating
//       NSPanel; panels float above normal windows and resist becoming key.
//     - `alwaysOnTop` at the 'screen-saver' level so it sits above full-screen
//       and other floating windows.
//
//   RESIDUAL macOS RISK (Sonoma / Sequoia): even with `focusable:false` +
//   `showInactive()`, AppKit can *briefly* activate the owning app the first
//   time a window for that app is ordered front (the app transitions from "no
//   windows" to "has a window"). Because SigmaVoice is a tray-only / Dock-hidden
//   (LSUIElement-like) app, this activation is largely invisible and does not
//   move the key window away from the user's target app in practice — but a
//   one-frame focus blip on the very first show is possible and is NOT fully
//   suppressible from Electron's JS layer (it would require an NSPanel with
//   `becomesKeyOnlyIfNeeded`/`nonactivatingPanel` style mask, which Electron
//   does not expose). We mitigate by:
//     1. creating the window EARLY (lazily on first showRecording) and reusing
//        it for the whole app lifetime, so the "first show" blip happens once;
//     2. only ever calling `showInactive()` (never `show()`/`focus()`);
//     3. keeping `focusable:false` so it cannot accept typed input even if
//        it were somehow ordered key.

import { BrowserWindow, screen } from 'electron';

/** State pushed to the renderer over the `hud:state` channel. */
export type HudState = 'recording' | 'transcribing';

/** Controller the lead drives from main.ts to show/hide the overlay. */
export interface HudController {
  /** Create-if-needed + show overlay in 'recording' state (renderer (re)starts its timer). */
  showRecording(): void;
  /** Switch overlay to 'transcribing' state (renderer freezes its timer). */
  showTranscribing(): void;
  /** Hide the overlay (window is kept alive for fast re-show). */
  hide(): void;
  /** Tear down the window entirely. */
  destroy(): void;
}

export interface HudWindowDeps {
  /** Absolute path to the compiled HUD preload script. */
  preloadPath: string;
  /** Absolute path to the HUD renderer HTML (renderer/hud.html). */
  htmlPath: string;
}

// Overlay geometry. Small pill, bottom-center of the primary display's work area.
const HUD_WIDTH = 220;
const HUD_HEIGHT = 64;
const HUD_MARGIN_BOTTOM = 48; // gap above the Dock / screen edge

// Safety net: the HUD relies on the capture controller emitting a terminal
// 'idle' state to hide. If that event is ever missed (a throw in the emit path,
// a future controller code path that returns without emitting), the always-on-
// top overlay would pin over the user's work forever. We bound that: once in
// 'transcribing' (the brief tail of a capture), auto-hide after this timeout if
// no further state arrives. NOT applied to 'recording' (dictation can legitimately
// run for minutes); only the post-capture tail is time-bounded.
const TRANSCRIBE_SAFETY_MS = 90_000;

export function createHudWindow(deps: HudWindowDeps): HudController {
  let win: BrowserWindow | null = null;
  // Tracks whether the renderer has finished its initial load. State sends
  // issued before this are buffered and flushed on 'did-finish-load'.
  let ready = false;
  let pendingState: HudState | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSafetyTimer(): void {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  }

  function computeBounds(): { x: number; y: number; width: number; height: number } {
    // Bottom-center of the primary display's WORK AREA (excludes menu bar / Dock).
    const primary = screen.getPrimaryDisplay();
    const { x: waX, y: waY, width: waW, height: waH } = primary.workArea;
    const x = Math.round(waX + (waW - HUD_WIDTH) / 2);
    const y = Math.round(waY + waH - HUD_HEIGHT - HUD_MARGIN_BOTTOM);
    return { x, y, width: HUD_WIDTH, height: HUD_HEIGHT };
  }

  function ensureWindow(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;

    ready = false;
    const bounds = computeBounds();

    win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      // --- focus preservation (the crux) ---
      focusable: false, // OS will not give this window key focus
      show: false, // never auto-show; we use showInactive()
      // --- chromeless floating overlay ---
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true, // no taskbar / app-switcher entry
      // macOS: 'panel' is the closest Electron exposes to a non-activating NSPanel.
      // On win/linux this option is ignored.
      type: process.platform === 'darwin' ? 'panel' : undefined,
      // Repaint while hidden so the first showInactive() has fresh frames.
      paintWhenInitiallyHidden: true,
      backgroundColor: '#00000000', // fully transparent backing
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: deps.preloadPath,
      },
    });

    // Float above normal windows AND above full-screen apps the user may be
    // dictating into. 'screen-saver' is the highest standard level.
    win.setAlwaysOnTop(true, 'screen-saver');
    // Show the overlay on every Space / over full-screen windows without
    // pulling SigmaVoice into focus.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Belt-and-suspenders: if anything ever tries to focus the window, blur it.
    // We do NOT call focus ourselves anywhere.
    win.on('focus', () => {
      // Guard against re-entrancy / destroyed window.
      if (win && !win.isDestroyed()) win.blur();
    });

    win.webContents.on('did-finish-load', () => {
      ready = true;
      if (pendingState) {
        sendState(pendingState);
        pendingState = null;
      }
    });

    win.on('closed', () => {
      win = null;
      ready = false;
      pendingState = null;
    });

    // loadFile resolves the absolute html path provided by the lead.
    void win.loadFile(deps.htmlPath);
    return win;
  }

  function sendState(state: HudState): void {
    if (!win || win.isDestroyed()) return;
    if (!ready) {
      // Renderer not loaded yet — buffer the latest state; flushed on load.
      pendingState = state;
      return;
    }
    win.webContents.send('hud:state', { state });
  }

  /** Show WITHOUT activating. Never call show()/focus(). */
  function showInactive(): void {
    const w = ensureWindow();
    // Re-assert position in case displays changed since the window was created.
    w.setBounds(computeBounds());
    if (!w.isVisible()) {
      w.showInactive(); // <- the key call: order front but do NOT make key/active
    }
  }

  function doHide(): void {
    clearSafetyTimer();
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.hide();
    }
  }

  return {
    showRecording(): void {
      clearSafetyTimer(); // recording is not time-bounded
      showInactive();
      sendState('recording');
    },
    showTranscribing(): void {
      // Don't create the window solely to show 'transcribing'; only meaningful
      // if we're already showing the recording HUD.
      if (!win || win.isDestroyed()) return;
      showInactive();
      sendState('transcribing');
      // Arm the safety auto-hide: if no terminal 'idle' arrives, dismiss so a
      // missed event can't pin the overlay permanently.
      clearSafetyTimer();
      safetyTimer = setTimeout(doHide, TRANSCRIBE_SAFETY_MS);
    },
    hide(): void {
      doHide();
    },
    destroy(): void {
      clearSafetyTimer();
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      win = null;
      ready = false;
      pendingState = null;
    },
  };
}
