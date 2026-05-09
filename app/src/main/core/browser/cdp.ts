// CDP attach helper for an Electron `WebContentsView`.
//
// We use `webContents.debugger.attach('1.3')` to talk to the underlying
// Chromium DevTools Protocol on a per-view basis. This is the only path that
// works after `app.whenReady()` has already fired, since the global
// `--remote-debugging-port=<n>` switch must be set BEFORE Electron forks the
// browser-process listener — by the time `BrowserManager` is constructed,
// that ship has sailed.
//
// `attachDebugger` is idempotent and safe to call repeatedly. `runCDP`
// performs a single CDP round-trip and surfaces protocol errors verbatim so
// the BrowserManager can decide whether to retry or give up.

import type { WebContentsView } from 'electron';

const ATTACHED = new WeakSet<object>();

export function attachDebugger(view: WebContentsView): boolean {
  const wc = view.webContents;
  // Already attached to this WebContents? Treat as success.
  if (ATTACHED.has(wc)) return true;
  try {
    if (wc.debugger.isAttached()) {
      ATTACHED.add(wc);
      return true;
    }
    wc.debugger.attach('1.3');
    ATTACHED.add(wc);
    // Detach automatically on destruction so the tracking set doesn't hold
    // refs to closed WebContents.
    wc.once('destroyed', () => {
      ATTACHED.delete(wc);
    });
    return true;
  } catch (err) {
    // Common case: DevTools is open on this WebContents and Chromium
    // refuses a second debugger client. We surface false so the caller can
    // fall through to non-CDP control paths (loadURL, etc.).
    void err;
    return false;
  }
}

export async function runCDP<T = unknown>(
  view: WebContentsView,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  if (!attachDebugger(view)) {
    throw new Error(`CDP not attached for ${method}`);
  }
  const wc = view.webContents;
  // `sendCommand` resolves with the protocol response or rejects with the
  // protocol error message string.
  const out = (await wc.debugger.sendCommand(method, params ?? {})) as T;
  return out;
}

export function detachDebugger(view: WebContentsView): void {
  const wc = view.webContents;
  if (!ATTACHED.has(wc)) return;
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  } catch {
    /* ignore */
  }
  ATTACHED.delete(wc);
}
