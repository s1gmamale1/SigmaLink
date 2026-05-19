// output-router.ts — macOS-only output routing for global voice capture.
//
// Decision tree on transcript available:
//   1. Is `com.sigmalink.app` the frontmost application?
//      YES → emit `voice:dispatch` IPC to the renderer (existing SigmaVoice path)
//      NO  → attempt clipboard + AX paste into the focused app
//   2. AX paste: is Accessibility trusted (`AXIsProcessTrustedWithOptions`)?
//      YES → write transcript to clipboard, send Cmd+V to focused app
//      NO  → prompt once, fall back to clipboard-only + show toast
//
// Windows + Linux are deferred to v1.5.0. On those platforms this module
// exports a stub that always routes to clipboard so the state machine
// in global-capture.ts can call the same interface without branching.
//
// v1.4.9 — macOS only. The voice-mac native module is extended (in
// voice-mac.ts stub below) with `getFrontmostAppBundleId()` +
// `isTrustedAccessibility()` + `sendPasteKeystroke()` via ObjC++ additions
// in app/native/voice-mac/src/sigmavoice_mac.mm. These three helpers are
// the ~30 LOC addition described in brief §4 item 5.

import { clipboard } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OutputTarget = 'sigmalink-pane' | 'ax-paste' | 'clipboard';

export interface RouteResult {
  target: OutputTarget;
  /** Human-readable toast string for the renderer. Empty string on success. */
  toast: string;
}

// ---------------------------------------------------------------------------
// voice-mac extension loader (sendPasteKeystroke + AX helpers)
// ---------------------------------------------------------------------------

interface VoiceMacExtended {
  getFrontmostAppBundleId(): string;
  isTrustedAccessibility(prompt: boolean): boolean;
  sendPasteKeystroke(): void;
  isAvailable(): boolean;
  // ... existing SigmaVoice exports not needed here
}

let cachedMacExt: VoiceMacExtended | null | undefined;

function loadMacExt(): VoiceMacExtended | null {
  if (cachedMacExt !== undefined) return cachedMacExt;
  if (process.platform !== 'darwin') {
    cachedMacExt = null;
    return null;
  }
  const requireCJS = createRequire(import.meta.url);
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  const tryPaths: string[] = [];
  // Walk up to find app root
  for (let i = 0; i < 8; i += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (path.basename(dir) === 'app') {
      tryPaths.push(path.join(dir, 'native', 'voice-mac', 'index.js'));
      break;
    }
  }
  tryPaths.push('@sigmalink/voice-mac', '../native/voice-mac/index.js');

  for (const p of tryPaths) {
    try {
      const mod = requireCJS(p) as VoiceMacExtended | undefined;
      if (mod && typeof mod.isAvailable === 'function') {
        cachedMacExt = mod;
        return cachedMacExt;
      }
    } catch {
      // try next
    }
  }
  cachedMacExt = null;
  return null;
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

const SIGMALINK_BUNDLE_ID = 'com.sigmalink.agentorchestrator';

/** Returns the bundle id of the frontmost application, or '' on error. */
function getFrontmostBundleId(): string {
  if (process.platform !== 'darwin') return '';
  const ext = loadMacExt();
  if (!ext || typeof ext.getFrontmostAppBundleId !== 'function') return '';
  try {
    return ext.getFrontmostAppBundleId();
  } catch {
    return '';
  }
}

/** Returns true when the process has Accessibility permission. */
function isTrustedAX(promptIfNeeded: boolean): boolean {
  if (process.platform !== 'darwin') return false;
  const ext = loadMacExt();
  if (!ext || typeof ext.isTrustedAccessibility !== 'function') return false;
  try {
    return ext.isTrustedAccessibility(promptIfNeeded);
  } catch {
    return false;
  }
}

/** Sends Cmd+V to the system via CoreGraphics / CGEvent. */
function sendPasteKeystroke(): void {
  if (process.platform !== 'darwin') return;
  const ext = loadMacExt();
  if (!ext || typeof ext.sendPasteKeystroke !== 'function') return;
  try {
    ext.sendPasteKeystroke();
  } catch (err) {
    console.warn('[output-router] sendPasteKeystroke failed:', err);
  }
}

/** Emit `voice:dispatch` via IPC so the renderer writes the transcript. */
function dispatchToSigmaLinkPane(
  transcript: string,
  emit: (event: string, payload: unknown) => void,
): void {
  // Reuse the existing voice:dispatch-echo channel; the renderer's VoicePill
  // wires up to write to the focused pane composer on this event.
  emit('voice:dispatch-echo', {
    intent: 'assistant.freeform',
    controller: 'assistant.send',
    args: { text: transcript },
    raw: transcript,
  });
}

// ---------------------------------------------------------------------------
// Main routing function
// ---------------------------------------------------------------------------

/**
 * Route `transcript` to the appropriate output target.
 *
 * @param transcript  Finalised transcript string.
 * @param emit        Main-process event emitter (from adapter deps).
 * @returns           Routing result describing what was done.
 */
export function routeTranscript(
  transcript: string,
  emit: (event: string, payload: unknown) => void,
): RouteResult {
  if (!transcript.trim()) {
    return { target: 'clipboard', toast: '' };
  }

  // Step 1: Is SigmaLink the frontmost app?
  const frontmost = getFrontmostBundleId();
  if (frontmost === SIGMALINK_BUNDLE_ID) {
    dispatchToSigmaLinkPane(transcript, emit);
    return { target: 'sigmalink-pane', toast: '' };
  }

  // Step 2: Try AX paste into the focused (non-SigmaLink) app.
  // Write to clipboard first regardless — ensures the content is available
  // even if the paste keystroke is blocked or AX is denied.
  clipboard.writeText(transcript);

  if (process.platform === 'darwin') {
    // Check AX trust without prompting first (non-disruptive).
    const trusted = isTrustedAX(false);
    if (trusted) {
      // Brief delay to let the clipboard write propagate before sending Cmd+V.
      // CGEvent dispatch is synchronous but the clipboard IPC roundtrip is not.
      setTimeout(() => sendPasteKeystroke(), 50);
      return { target: 'ax-paste', toast: '' };
    }
    // Not trusted yet — prompt once, then fall back to clipboard.
    isTrustedAX(true); // triggers system dialog (async — user must approve)
    emit('voice:global-capture-toast', {
      message: 'Transcript copied to clipboard (Accessibility declined). Approve in System Settings → Privacy → Accessibility for direct paste.',
      level: 'info',
    });
    return {
      target: 'clipboard',
      toast: 'Granted clipboard mode (Accessibility declined)',
    };
  }

  // Non-darwin (win/linux stub path): clipboard only.
  emit('voice:global-capture-toast', {
    message: 'Transcript copied to clipboard.',
    level: 'info',
  });
  return { target: 'clipboard', toast: 'Transcript copied to clipboard' };
}
