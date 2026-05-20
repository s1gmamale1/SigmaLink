// output-router.ts — Cross-platform output routing for global voice capture.
// v1.5.1-C caveat 8 — Wire voice-win getFrontmostAppExePath() N-API helper.
//
// Decision tree on transcript available:
//   1. Is SigmaLink the frontmost application?
//      YES → emit `voice:dispatch` IPC to the renderer (existing SigmaVoice path)
//      NO  → attempt clipboard + AX/accessibility paste into the focused app
//   2. AX paste availability varies by platform:
//      macOS  → AXIsProcessTrustedWithOptions; fall back to clipboard if denied
//      Windows → N-API getFrontmostAppExePath() (v1.5.1-C, ~<1ms) with
//                PowerShell fallback (~60-120ms cold-start) until Cluster B's
//                voice-win PR lands and the native path becomes active.
//      Linux  → clipboard-only for v1.5.0; xdotool paste is v1.5.1
//
// macOS path unchanged from v1.4.9. Windows and Linux paths added in v1.5.0.
//
// v1.4.9 — macOS only. The voice-mac native module is extended (in
// voice-mac.ts stub below) with `getFrontmostAppBundleId()` +
// `isTrustedAccessibility()` + `sendPasteKeystroke()` via ObjC++ additions
// in app/native/voice-mac/src/sigmavoice_mac.mm. These three helpers are
// the ~30 LOC addition described in brief §4 item 5.

import { clipboard } from 'electron';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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
// voice-win N-API loader (getFrontmostAppExePath — v1.5.1-C caveat 8)
// ---------------------------------------------------------------------------
//
// Cluster B is adding `getFrontmostAppExePath(): string` to @sigmalink/voice-win.
// Until their PR lands on main, the dynamic require below resolves to null and
// the PowerShell fallback path stays active. After both PRs merge, no code
// change is needed — the native module will load and the fast path activates.
//
// The try/catch dynamic-require pattern ensures this PR compiles standalone
// without a build-time dependency on the voice-win export.

interface VoiceWinWithForeground {
  getFrontmostAppExePath(): string;
  isAvailable(): boolean;
}

let cachedVoiceWin: VoiceWinWithForeground | null | undefined;

function loadVoiceWin(): VoiceWinWithForeground | null {
  if (cachedVoiceWin !== undefined) return cachedVoiceWin;
  if (process.platform !== 'win32') {
    cachedVoiceWin = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@sigmalink/voice-win') as VoiceWinWithForeground | undefined;
    // Guard: the export was added in Cluster B. Older voice-win builds won't
    // have getFrontmostAppExePath. Fall back to null so the PowerShell path
    // stays active until the updated module is on disk.
    if (mod && typeof mod.getFrontmostAppExePath === 'function') {
      cachedVoiceWin = mod;
      return cachedVoiceWin;
    }
  } catch {
    // Module not found or failed to load — fall through to PowerShell path.
  }
  cachedVoiceWin = null;
  return null;
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

// Partial match used on Windows and Linux where the full path is available
// rather than a bundle identifier. The executable is `SigmaLink.exe` on
// Windows and `sigmalink` (or `SigmaLink`) on Linux.
const SIGMALINK_EXE_PATTERN = /sigmalink/i;

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

/**
 * Returns the full executable path of the foreground window process on Windows,
 * or '' on error / unavailable.
 *
 * Priority:
 *   1. N-API helper via @sigmalink/voice-win `getFrontmostAppExePath()` (~<1ms).
 *      Active once Cluster B's voice-win PR lands on main and the module is
 *      on disk. Until then the module load returns null and we fall through.
 *   2. PowerShell P/Invoke fallback (~60-120ms cold-start). Safe on all Windows
 *      versions where PowerShell 5+ is available (Windows 10+).
 */
function getWindowsForegroundExePath(): string {
  if (process.platform !== 'win32') return '';

  // --- Try N-API native path first (fast, ~<1ms) ---------------------------
  const voiceWin = loadVoiceWin();
  if (voiceWin) {
    try {
      const exePath = voiceWin.getFrontmostAppExePath();
      if (typeof exePath === 'string' && exePath.length > 0) {
        return exePath;
      }
    } catch {
      // Native call failed — fall through to PowerShell.
    }
  }
  // --- PowerShell fallback (~60-120ms) --------------------------------------
  try {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Get the MainWindowHandle owner process path. hwndForeground is the
        // HWND of the foreground window; we walk to its owning process.
        '[void][System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");' +
        '$hwnd = [System.Windows.Forms.Form]::ActiveForm;' +
        // Fallback: use GetForegroundWindow via P/Invoke if ActiveForm is null
        // (common when focus is in a non-.NET app such as a browser or terminal).
        '$sig = @"' +
        "\n[DllImport(\"user32.dll\")]" +
        "\npublic static extern IntPtr GetForegroundWindow();" +
        "\n[DllImport(\"user32.dll\")]" +
        "\npublic static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);" +
        "\n\"@;" +
        '$type = Add-Type -MemberDefinition $sig -Name "Win32Util" -Namespace "PInvoke" -PassThru;' +
        '$fgHwnd = $type::GetForegroundWindow();' +
        // NOTE: `$pid` is a PowerShell automatic read-only variable (current
        // process id); assigning to it throws. Use `$procId` instead — caveat
        // 1 from PR #52 reviewer.
        '$procId = [uint32]0;' +
        '$type::GetWindowThreadProcessId($fgHwnd, [ref]$procId) | Out-Null;' +
        'if ($procId -gt 0) { (Get-Process -Id $procId -ErrorAction SilentlyContinue).MainModule.FileName } else { "" }',
      ],
      { timeout: 3000, encoding: 'utf8' },
    );
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // PowerShell absent or timed out — fall through to clipboard-only path.
  }
  return '';
}

/**
 * Returns the PID of the active X11 window on Linux via `xdotool`, or -1
 * when xdotool is absent or the display is not available (e.g. Wayland).
 *
 * TODO v1.5.1: add Wayland support via `ydotool` or `wlr-randr` equivalent.
 */
function getLinuxActiveWindowPid(): number {
  if (process.platform !== 'linux') return -1;
  try {
    const result = spawnSync(
      'xdotool',
      ['getactivewindow', 'getwindowpid'],
      { timeout: 1000, encoding: 'utf8' },
    );
    if (result.status === 0 && result.stdout) {
      const pid = parseInt(result.stdout.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : -1;
    }
  } catch {
    // xdotool not installed or DISPLAY not set — clipboard-only fallback.
  }
  return -1;
}

/**
 * Returns the executable path for a Linux PID via `/proc/<pid>/exe`, or ''.
 * No external tooling required — direct procfs read.
 */
function getLinuxExeForPid(pid: number): string {
  if (process.platform !== 'linux' || pid <= 0) return '';
  try {
    // readlinkSync not available without 'node:fs' — use spawnSync readlink(1).
    const result = spawnSync('readlink', ['-f', `/proc/${pid}/exe`], {
      timeout: 500,
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // procfs may be unavailable in some container environments.
  }
  return '';
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

  // -------------------------------------------------------------------------
  // macOS path (unchanged from v1.4.9)
  // -------------------------------------------------------------------------
  if (process.platform === 'darwin') {
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

  // -------------------------------------------------------------------------
  // Windows path (v1.5.0)
  // -------------------------------------------------------------------------
  if (process.platform === 'win32') {
    // Determine whether SigmaLink is the foreground window. If so, dispatch
    // to the pane via IPC (same as macOS). Otherwise clipboard-only.
    // Direct Win32 paste (SendInput / keybd_event Ctrl+V) is deferred to
    // v1.5.1 because it requires either a native N-API helper or UAC elevation
    // on some target apps (e.g. elevated cmd.exe). Clipboard-write is safe
    // and consistent.
    const fgExe = getWindowsForegroundExePath();
    if (fgExe && SIGMALINK_EXE_PATTERN.test(fgExe)) {
      dispatchToSigmaLinkPane(transcript, emit);
      return { target: 'sigmalink-pane', toast: '' };
    }

    clipboard.writeText(transcript);
    emit('voice:global-capture-toast', {
      message: 'Transcript copied to clipboard.',
      level: 'info',
    });
    return { target: 'clipboard', toast: 'Transcript copied to clipboard' };
  }

  // -------------------------------------------------------------------------
  // Linux path (v1.5.0)
  // -------------------------------------------------------------------------
  if (process.platform === 'linux') {
    // Determine whether SigmaLink is the active X11 window via xdotool.
    // If xdotool is absent or we are on Wayland, pid will be -1 and we fall
    // through to clipboard-only. Direct paste via xdotool type is deferred to
    // v1.5.1; Wayland support (ydotool) is also v1.5.1.
    const activePid = getLinuxActiveWindowPid();
    if (activePid > 0) {
      const exePath = getLinuxExeForPid(activePid);
      if (exePath && SIGMALINK_EXE_PATTERN.test(exePath)) {
        dispatchToSigmaLinkPane(transcript, emit);
        return { target: 'sigmalink-pane', toast: '' };
      }
    }

    clipboard.writeText(transcript);
    emit('voice:global-capture-toast', {
      message: 'Transcript copied to clipboard.',
      level: 'info',
    });
    return { target: 'clipboard', toast: 'Transcript copied to clipboard' };
  }

  // Fallback for any other platform (should not be reached in practice).
  clipboard.writeText(transcript);
  emit('voice:global-capture-toast', {
    message: 'Transcript copied to clipboard.',
    level: 'info',
  });
  return { target: 'clipboard', toast: 'Transcript copied to clipboard' };
}
