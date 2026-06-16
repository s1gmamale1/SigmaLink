// Persisted crash diagnostics. Best-effort, never-throwing file logging for
// main-process uncaught errors AND renderer console output (we capture the
// renderer's existing `console.error('[ErrorBoundary]', …)` via the main-side
// `console-message` event — no IPC channel or preload change needed). The point
// is that after ANY crash the exact throwing component + stack is on disk, so a
// surgical fix needs no DevTools work from the user.
//
// Pure module (fs/path + a structural WebContents interface) so it lives under
// src/main (covered by the vitest include glob) and is imported by electron/main.ts.
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 256 * 1024; // cap; on overflow keep the most-recent half

/** Append a line to `file` (creating parents), trimming to the cap. Never throws. */
export function appendDiagnostic(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    const st = fs.statSync(file);
    if (st.size > MAX_LOG_BYTES) {
      const buf = fs.readFileSync(file);
      fs.writeFileSync(file, buf.subarray(buf.length - Math.floor(MAX_LOG_BYTES / 2)));
    }
  } catch {
    /* diagnostics logging must never cascade into another failure */
  }
}

/** Format a main-process error for the log. Never throws (JSON.stringify on a
 *  circular reason falls back to String). */
export function formatError(kind: string, err: unknown, iso: string): string {
  let e: Error;
  if (err instanceof Error) {
    e = err;
  } else if (typeof err === 'string') {
    e = new Error(err);
  } else {
    let serialized: string;
    try {
      serialized = JSON.stringify(err);
    } catch {
      serialized = String(err); // circular / unstringifiable reason
    }
    e = new Error(serialized);
  }
  return `[${iso}] ${kind}: ${e.message}\n${e.stack ?? ''}`;
}

interface ConsoleCapableWebContents {
  on(
    event: 'console-message',
    listener: (
      event: unknown,
      level: number,
      message: string,
      line?: number,
      sourceId?: string,
    ) => void,
  ): void;
}

/**
 * Persist renderer console ERRORS. Electron ^30 uses the legacy
 * `(event, level, message, line, sourceId)` signature where `level` is numeric:
 * 0=verbose, 1=info, 2=warning, 3=error. We capture `level >= 3` (errors only) —
 * warnings (React dev-mode noise) are excluded so they cannot push the real crash
 * out of the size-capped window — plus our own `[ErrorBoundary]` marker regardless
 * of level, since that line carries the React component stack.
 */
export function attachRendererLogCapture(wc: ConsoleCapableWebContents, file: string): void {
  wc.on('console-message', (_event, level, message) => {
    if (level >= 3 || message.startsWith('[ErrorBoundary]')) {
      appendDiagnostic(file, `[${new Date().toISOString()}] [renderer] ${message}`);
    }
  });
}
