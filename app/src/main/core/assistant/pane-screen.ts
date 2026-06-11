// read_pane support — turns a raw PTY scrollback snapshot (ANSI escape
// sequences, CR overwrites, control chars) into model-readable plain text.
// Pure function: no Electron/DB imports so it unit-tests in isolation and
// stays cheap to call against the 256 KiB ring-buffer snapshot.

// CSI (ESC [ … cmd), OSC (ESC ] … BEL|ST), DCS/SOS/PM/APC (ESC P/X/^/_ … ST),
// and single-char ESC sequences. Terminal emulation is intentionally NOT
// performed — CR-overwritten lines (spinners, progress bars) appear as
// separate lines, which is acceptable for an agent reading pane status.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\_-])/g;
// Remaining C0 control chars + DEL, except \n (\x0a) and \t (\x09).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export interface PaneScreen {
  text: string;
  truncated: boolean;
}

/**
 * Strip terminal escape sequences and control characters from a raw PTY
 * snapshot and return at most the trailing `maxBytes` characters.
 */
export function extractPaneScreen(rawSnapshot: string, maxBytes: number): PaneScreen {
  const stripped = rawSnapshot
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL_RE, '');
  if (stripped.length <= maxBytes) return { text: stripped, truncated: false };
  return { text: stripped.slice(stripped.length - maxBytes), truncated: true };
}
