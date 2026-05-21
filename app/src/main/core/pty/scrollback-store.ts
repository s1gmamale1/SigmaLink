// v1.9-scrollback — Optional, DEFAULT-OFF persistence of the PTY ring buffer
// across app restarts. All I/O is best-effort: errors are logged and swallowed
// so this path can NEVER crash the main process or alter flag-off behaviour.
//
// Storage layout:  <userData>/scrollback/<sessionId>.log
// Atomic write:    write to <sessionId>.log.tmp → rename to .log
//
// Callers must check the `pty.scrollbackPersistence` KV flag BEFORE invoking
// any function here; this module is flag-unaware by design (single
// responsibility, easy to unit-test without mocking KV).

import fs from 'node:fs';
import path from 'node:path';

/** Maximum bytes accepted by persist(); excess is tail-truncated. */
export const SCROLLBACK_MAX_BYTES = 256 * 1024; // 256 KiB — matches RingBuffer default

function scrollbackDir(userDataDir: string): string {
  return path.join(userDataDir, 'scrollback');
}

function scrollbackPath(userDataDir: string, sessionId: string): string {
  return path.join(scrollbackDir(userDataDir), `${sessionId}.log`);
}

/**
 * Write the ring-buffer snapshot for `sessionId` to disk.
 *
 * Uses an atomic tmp→rename sequence so a mid-write crash never leaves a
 * partial file that would be loaded on the next boot.
 *
 * Caps content to SCROLLBACK_MAX_BYTES (tail) before writing.
 * Best-effort: logs + swallows all I/O errors.
 */
export function persistScrollback(userDataDir: string, sessionId: string, text: string): void {
  try {
    const dir = scrollbackDir(userDataDir);
    fs.mkdirSync(dir, { recursive: true });

    const capped =
      Buffer.byteLength(text, 'utf8') > SCROLLBACK_MAX_BYTES
        ? text.slice(-SCROLLBACK_MAX_BYTES) // rough char-level truncation (safe: ASCII terminal data)
        : text;

    const dest = scrollbackPath(userDataDir, sessionId);
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, capped, 'utf8');
    fs.renameSync(tmp, dest);
  } catch (err) {
    console.warn('[scrollback-store] persistScrollback failed:', err);
  }
}

/**
 * Load the persisted ring-buffer snapshot for `sessionId`.
 *
 * Returns '' when the file is absent (normal first-boot case) or on any
 * read error.
 */
export function loadScrollback(userDataDir: string, sessionId: string): string {
  try {
    const p = scrollbackPath(userDataDir, sessionId);
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[scrollback-store] loadScrollback failed:', err);
    }
    return '';
  }
}

/**
 * Remove scrollback files for sessions that are no longer live.
 *
 * Called once at boot with the set of session IDs that are present in the DB
 * (or otherwise considered still live). Any `.log` files whose base names are
 * NOT in `liveSessionIds` are deleted best-effort.
 *
 * Never throws.
 */
export function gcScrollback(userDataDir: string, liveSessionIds: ReadonlySet<string>): void {
  try {
    const dir = scrollbackDir(userDataDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // dir doesn't exist yet — nothing to GC
    }
    for (const entry of entries) {
      if (!entry.endsWith('.log')) continue;
      const sessionId = entry.slice(0, -'.log'.length);
      if (!liveSessionIds.has(sessionId)) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {
          /* best-effort; ignore */
        }
      }
    }
  } catch (err) {
    console.warn('[scrollback-store] gcScrollback failed:', err);
  }
}
