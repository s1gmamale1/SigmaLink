// output-router.ts — Cross-platform output routing for global voice capture.
//
// Extracted from app/src/main/core/voice/output-router.ts into @sigmalink/voice-core.
//
// The only change from the original: `clipboard` is injected rather than
// imported directly from 'electron', making this module usable from any
// Electron app (SigmaLink or BridgeVoice) without referencing SigmaLink's
// build context.

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

/**
 * Clipboard abstraction — injected so this module is decoupled from any
 * specific Electron app's import graph. Pass `require('electron').clipboard`
 * from the host app's main process.
 */
export interface ClipboardApi {
  writeText(text: string): void;
}

// ---------------------------------------------------------------------------
// voice-win N-API loader (getFrontmostAppExePath — v1.5.1-C caveat 8)
// ---------------------------------------------------------------------------

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
  for (let i = 0; i < 10; i += 1) {
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
const SIGMALINK_EXE_PATTERN = /sigmalink/i;

function getFrontmostBundleId(): string {
  if (process.platform !== 'darwin') return '';
  const ext = loadMacExt();
  if (!ext || typeof ext.getFrontmostAppBundleId !== 'function') return '';
  try { return ext.getFrontmostAppBundleId(); } catch { return ''; }
}

function getWindowsForegroundExePath(): string {
  if (process.platform !== 'win32') return '';

  const voiceWin = loadVoiceWin();
  if (voiceWin) {
    try {
      const exePath = voiceWin.getFrontmostAppExePath();
      if (typeof exePath === 'string' && exePath.length > 0) return exePath;
    } catch {
      // fall through to PowerShell
    }
  }
  try {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[void][System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms");' +
        '$sig = @"' +
        "\n[DllImport(\"user32.dll\")]" +
        "\npublic static extern IntPtr GetForegroundWindow();" +
        "\n[DllImport(\"user32.dll\")]" +
        "\npublic static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);" +
        "\n\"@;" +
        '$type = Add-Type -MemberDefinition $sig -Name "Win32Util" -Namespace "PInvoke" -PassThru;' +
        '$fgHwnd = $type::GetForegroundWindow();' +
        '$procId = [uint32]0;' +
        '$type::GetWindowThreadProcessId($fgHwnd, [ref]$procId) | Out-Null;' +
        'if ($procId -gt 0) { (Get-Process -Id $procId -ErrorAction SilentlyContinue).MainModule.FileName } else { "" }',
      ],
      { timeout: 3000, encoding: 'utf8' },
    );
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch { /* PowerShell absent or timed out */ }
  return '';
}

function getLinuxActiveWindowPid(): number {
  if (process.platform !== 'linux') return -1;
  try {
    const result = spawnSync('xdotool', ['getactivewindow', 'getwindowpid'], { timeout: 1000, encoding: 'utf8' });
    if (result.status === 0 && result.stdout) {
      const pid = parseInt(result.stdout.trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : -1;
    }
  } catch { /* xdotool not installed */ }
  return -1;
}

function getLinuxExeForPid(pid: number): string {
  if (process.platform !== 'linux' || pid <= 0) return '';
  try {
    const result = spawnSync('readlink', ['-f', `/proc/${pid}/exe`], { timeout: 500, encoding: 'utf8' });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch { /* procfs unavailable */ }
  return '';
}

function isTrustedAX(promptIfNeeded: boolean): boolean {
  if (process.platform !== 'darwin') return false;
  const ext = loadMacExt();
  if (!ext || typeof ext.isTrustedAccessibility !== 'function') return false;
  try { return ext.isTrustedAccessibility(promptIfNeeded); } catch { return false; }
}

function sendPasteKeystroke(): void {
  if (process.platform !== 'darwin') return;
  const ext = loadMacExt();
  if (!ext || typeof ext.sendPasteKeystroke !== 'function') return;
  try { ext.sendPasteKeystroke(); } catch (err) {
    console.warn('[output-router] sendPasteKeystroke failed:', err);
  }
}

function dispatchToSigmaLinkPane(
  transcript: string,
  emit: (event: string, payload: unknown) => void,
): void {
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
 * @param clipboard   Electron clipboard API (injected for portability).
 * @returns           Routing result describing what was done.
 */
export function routeTranscript(
  transcript: string,
  emit: (event: string, payload: unknown) => void,
  clipboard: ClipboardApi,
): RouteResult {
  if (!transcript.trim()) {
    return { target: 'clipboard', toast: '' };
  }

  // -------------------------------------------------------------------------
  // macOS path
  // -------------------------------------------------------------------------
  if (process.platform === 'darwin') {
    const frontmost = getFrontmostBundleId();
    if (frontmost === SIGMALINK_BUNDLE_ID) {
      dispatchToSigmaLinkPane(transcript, emit);
      return { target: 'sigmalink-pane', toast: '' };
    }

    clipboard.writeText(transcript);

    const trusted = isTrustedAX(false);
    if (trusted) {
      setTimeout(() => sendPasteKeystroke(), 50);
      return { target: 'ax-paste', toast: '' };
    }
    isTrustedAX(true);
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
  // Windows path
  // -------------------------------------------------------------------------
  if (process.platform === 'win32') {
    const fgExe = getWindowsForegroundExePath();
    if (fgExe && SIGMALINK_EXE_PATTERN.test(fgExe)) {
      dispatchToSigmaLinkPane(transcript, emit);
      return { target: 'sigmalink-pane', toast: '' };
    }

    clipboard.writeText(transcript);
    emit('voice:global-capture-toast', { message: 'Transcript copied to clipboard.', level: 'info' });
    return { target: 'clipboard', toast: 'Transcript copied to clipboard' };
  }

  // -------------------------------------------------------------------------
  // Linux path
  // -------------------------------------------------------------------------
  if (process.platform === 'linux') {
    const activePid = getLinuxActiveWindowPid();
    if (activePid > 0) {
      const exePath = getLinuxExeForPid(activePid);
      if (exePath && SIGMALINK_EXE_PATTERN.test(exePath)) {
        dispatchToSigmaLinkPane(transcript, emit);
        return { target: 'sigmalink-pane', toast: '' };
      }
    }

    clipboard.writeText(transcript);
    emit('voice:global-capture-toast', { message: 'Transcript copied to clipboard.', level: 'info' });
    return { target: 'clipboard', toast: 'Transcript copied to clipboard' };
  }

  // Fallback
  clipboard.writeText(transcript);
  emit('voice:global-capture-toast', { message: 'Transcript copied to clipboard.', level: 'info' });
  return { target: 'clipboard', toast: 'Transcript copied to clipboard' };
}
