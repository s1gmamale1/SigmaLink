// SigmaVoice — hotkey-manager
//
// Supplies the *missing* KEY-UP signal for true push-to-talk (hold-to-talk).
//
// Why this module exists
// ----------------------
// The GlobalCaptureController (from @sigmalink/voice-core) registers an Electron
// `globalShortcut` for the bound hotkey. Electron's globalShortcut only ever
// fires on key-DOWN — it never reports key-UP. So in 'push-to-talk' mode the
// controller's accelerator handler can only *toggle* (press = start, press
// again = stop). That is not real hold-to-talk.
//
// Design (avoids double-fire):
//   • Key-DOWN / start stays on the controller's Electron globalShortcut (we do
//     NOT touch it). On press it calls `startRecording()`.
//   • THIS module adds a global key-UP listener via `node-global-key-listener`
//     (MIT, ships prebuilt listen-only server binaries — no native compile).
//     When mode === 'push-to-talk' and the MAIN key of the bound hotkey is
//     released, we invoke `onPushToTalkRelease()` so the lead can call
//     `controller.stopAndTranscribe()`.
//   • `startRecording()` no-ops when `state !== 'idle'`, so the controller's
//     redundant key-DOWN is harmless — we only need the key-UP edge.
//
// macOS permission note
// ---------------------
// A global key listener requires the **Input Monitoring** permission
// (System Settings → Privacy & Security → Input Monitoring). Without it the
// underlying MacKeyServer cannot read events; `start()` degrades gracefully
// (logs a warning, no throw) so toggle mode keeps working via the controller's
// own globalShortcut.

// Type-only import — the VALUE (GlobalKeyboardListener) is loaded lazily inside
// start() via dynamic import, so a load failure (a missing transitive dep like
// sudo-prompt, or an unsupported platform) is CAUGHT and degrades to toggle mode
// instead of crashing the whole main process with an uncaught exception.
import type {
  GlobalKeyboardListener,
  IGlobalKey,
  IGlobalKeyEvent,
} from 'node-global-key-listener';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HotkeyManagerDeps {
  /** Current capture mode — read live on every key-up. */
  getMode: () => 'toggle' | 'push-to-talk';
  /** Bound Electron accelerator, e.g. 'CommandOrControl+Alt+Space'. Read live. */
  getHotkey: () => string;
  /** Wired by the lead to `controller.stopAndTranscribe()`. */
  onPushToTalkRelease: () => void;
  /**
   * Called once when the global key-UP listener cannot attach (e.g. macOS
   * Input Monitoring not granted, or unsupported platform). The lead uses this
   * to tell the user that hold-to-talk is unavailable and the hotkey has
   * degraded to tap-to-toggle (press to start, press again to stop). Optional.
   */
  onListenerUnavailable?: (reason: string) => void;
}

export interface HotkeyManager {
  /** Attach the global key-up listener (idempotent). */
  start(): void;
  /** Detach the listener and release the underlying key server. */
  stop(): void;
  /**
   * Re-validate state. The manager caches nothing — getMode/getHotkey are read
   * live on each event — so this is effectively a no-op kept for symmetry with
   * the controller's own `setHotkey`/`setMode` lifecycle.
   */
  refresh(): void;
}

// ---------------------------------------------------------------------------
// Electron-accelerator → node-global-key-listener key-name mapping
// ---------------------------------------------------------------------------
//
// We only need the MAIN key (the non-modifier token) of the accelerator, since
// the controller already owns press-to-start. The accelerator's last '+'-split
// token is the main key (Electron places the key last, modifiers first).
//
// Reference: Electron accelerators
//   https://www.electronjs.org/docs/latest/api/accelerator
// IGlobalKey names come from node-global-key-listener's IGlobalKey union.

/** Modifier tokens that are NOT the "main" key (used to skip if last). */
const MODIFIER_TOKENS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

/**
 * Map of Electron accelerator key tokens (lower-cased) → IGlobalKey name.
 * Only entries that DIFFER from a simple upper-case are listed; anything not
 * here falls through to `.toUpperCase()` (covers A–Z, 0–9, F1–F24).
 */
const KEY_NAME_MAP: Readonly<Record<string, IGlobalKey>> = {
  space: 'SPACE',
  spacebar: 'SPACE',
  tab: 'TAB',
  enter: 'RETURN',
  return: 'RETURN',
  esc: 'ESCAPE',
  escape: 'ESCAPE',
  backspace: 'BACKSPACE',
  delete: 'DELETE',
  del: 'DELETE',
  insert: 'INS',
  up: 'UP ARROW',
  down: 'DOWN ARROW',
  left: 'LEFT ARROW',
  right: 'RIGHT ARROW',
  pageup: 'PAGE UP',
  pagedown: 'PAGE DOWN',
  home: 'HOME',
  end: 'END',
  printscreen: 'PRINT SCREEN',
  // Punctuation
  '=': 'EQUALS',
  'plus': 'NUMPAD PLUS',
  '-': 'MINUS',
  '[': 'SQUARE BRACKET OPEN',
  ']': 'SQUARE BRACKET CLOSE',
  ';': 'SEMICOLON',
  "'": 'QUOTE',
  '\\': 'BACKSLASH',
  ',': 'COMMA',
  '.': 'DOT',
  '/': 'FORWARD SLASH',
  '`': 'BACKTICK',
};

/**
 * Resolve the IGlobalKey name for the MAIN key of an Electron accelerator.
 * Returns null when the accelerator is empty / only modifiers / unmappable.
 */
export function resolveMainKey(accelerator: string): IGlobalKey | null {
  if (!accelerator) return null;
  const tokens = accelerator
    .split('+')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  // The main key is the last token; if that is itself a modifier the
  // accelerator has no usable main key (push-to-talk on a bare modifier is not
  // supported here — the controller can't start-on-press for it either).
  const last = tokens[tokens.length - 1]!;
  const lower = last.toLowerCase();
  if (MODIFIER_TOKENS.has(lower)) return null;

  const mapped = KEY_NAME_MAP[lower];
  if (mapped) return mapped;

  // Fallback: A–Z, 0–9, F1–F24 are upper-cased identity matches.
  return last.toUpperCase() as IGlobalKey;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHotkeyManager(deps: HotkeyManagerDeps): HotkeyManager {
  let listener: GlobalKeyboardListener | null = null;
  // The bound listener callback — kept so we can removeListener on stop().
  let onKey: ((e: IGlobalKeyEvent) => void) | null = null;
  // Guards against re-entrant start() while the async load is in flight.
  let starting = false;

  function handleKey(event: IGlobalKeyEvent): void {
    // We only care about the release edge.
    if (event.state !== 'UP') return;
    // Read mode live — toggle mode is fully owned by the controller.
    if (deps.getMode() !== 'push-to-talk') return;

    const mainKey = resolveMainKey(deps.getHotkey());
    if (mainKey === null) return;
    if (event.name !== mainKey) return;

    try {
      deps.onPushToTalkRelease();
    } catch (err) {
      console.warn('[hotkey-manager] onPushToTalkRelease threw:', err);
    }
  }

  function start(): void {
    if (listener || starting) return; // idempotent (incl. mid-async-load)
    starting = true;
    // Load the lib LAZILY via dynamic import so a load failure — a missing
    // transitive dep (e.g. sudo-prompt), an unsupported platform, or the key
    // server failing to spawn (Input Monitoring denied on macOS) — is caught
    // HERE and degrades to toggle mode, rather than throwing at module-eval and
    // crashing the whole main process with an uncaught exception.
    void (async () => {
      let gkl: GlobalKeyboardListener | null = null;
      try {
        const mod = await import('node-global-key-listener');
        gkl = new mod.GlobalKeyboardListener();
        onKey = handleKey;
        // Resolves once the key server has spawned. listen-only (returns void).
        await gkl.addListener((event) => {
          onKey?.(event);
        });
        listener = gkl;
      } catch (err) {
        console.warn(
          '[hotkey-manager] global key listener unavailable — push-to-talk ' +
            'release detection disabled (toggle mode still works). On macOS grant ' +
            'Input Monitoring in System Settings → Privacy & Security. Error:',
          err,
        );
        if (gkl) { try { gkl.kill(); } catch { /* ignore */ } }
        listener = null;
        onKey = null;
        notifyUnavailable(err);
      } finally {
        starting = false;
      }
    })();
  }

  // Fire onListenerUnavailable at most once, defensively.
  let notifiedUnavailable = false;
  function notifyUnavailable(err: unknown): void {
    if (notifiedUnavailable) return;
    notifiedUnavailable = true;
    try {
      deps.onListenerUnavailable?.(
        err instanceof Error ? err.message : String(err),
      );
    } catch {
      /* never let a notifier throw break start() */
    }
  }

  function stop(): void {
    if (!listener) return;
    try {
      listener.kill(); // removes all listeners + destroys the key server
    } catch (err) {
      console.warn('[hotkey-manager] error stopping global key listener:', err);
    }
    listener = null;
    onKey = null;
  }

  function refresh(): void {
    // No cached state to refresh — getMode()/getHotkey() are read live on each
    // event. Kept for lifecycle symmetry with the controller.
  }

  return { start, stop, refresh };
}
