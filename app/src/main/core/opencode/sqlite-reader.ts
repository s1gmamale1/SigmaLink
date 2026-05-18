// v1.4.7 packet-06 — Direct SQLite read of the OpenCode session database.
//
// Replaces the `opencode session list --format json --max-count 50` subprocess
// in session-disk-scanner's listOpencodeSessions(). The subprocess approach
// added ~200-400ms cold-start latency per workspace open and failed silently
// when the CLI was missing from PATH; direct SQLite read drops latency to
// <100ms and tolerates missing CLI by simply returning an empty list (the
// caller already handles that case).
//
// OpenCode storage layout (verified v1.x, 2026-05):
//   • macOS:   ~/.local/share/opencode/opencode.db   (XDG default)
//   • Linux:   ~/.local/share/opencode/opencode.db
//   • Windows: %LOCALAPPDATA%/opencode/opencode.db
//
// We open in `readonly: true` mode so concurrent OpenCode writes are safe.
// Schema drift is tolerated — the SELECT only references columns guaranteed
// since v0.x of OpenCode; future ALTER TABLE ADD COLUMN entries do not break
// us. Missing tables / locked DB / parse errors all degrade gracefully to
// an empty list and the disk-scanner falls back to its existing subprocess
// path (which itself also returns []).

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Public shape used by `session-disk-scanner.listOpencodeSessions` after the
 * subprocess swap. Identical to the post-parse shape so the call-site swap
 * is mechanical.
 */
export interface OpencodeSessionRow {
  /** Session id (e.g. `ses_1f1c37391ffeR5SzdOZJywVGyC`). */
  id: string;
  /** Absolute working directory the session was launched against. */
  directory: string;
  /** Human-readable title — may be empty. */
  title: string;
  /** Created timestamp, ms epoch. */
  timeCreated: number;
  /** Last-updated timestamp, ms epoch. */
  timeUpdated: number;
}

/**
 * Resolve the OpenCode SQLite database path for the host OS. Returns `null`
 * when no candidate exists on disk — caller treats this as "OpenCode not
 * installed or never run".
 *
 * Env override: `OPENCODE_HOME` points to the directory containing
 * `opencode.db`. Useful for tests + non-standard installs.
 */
export function resolveOpencodeDbPath(homeDir?: string): string | null {
  const home = homeDir ?? os.homedir();
  // When OPENCODE_HOME is set we trust it exclusively — fall through to OS
  // defaults would defeat tests + intentional non-standard installs.
  const candidates: string[] = [];
  if (process.env.OPENCODE_HOME) {
    candidates.push(path.join(process.env.OPENCODE_HOME, 'opencode.db'));
  } else {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      candidates.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
    }
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        candidates.push(path.join(localAppData, 'opencode', 'opencode.db'));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* Inaccessible candidate — try the next one. */
    }
  }
  return null;
}

/**
 * List OpenCode sessions for the given workspace directory, newest first.
 *
 * @param cwd          Absolute workspace directory (matched against `session.directory`).
 * @param maxCount     Cap on returned rows; defaults to 50 to match the subprocess.
 * @param opts.homeDir Override `os.homedir()` for tests.
 *
 * Returns `[]` when:
 *   • OpenCode DB does not exist on disk (CLI not installed / never run)
 *   • DB is locked (concurrent write) — fall through to subprocess path
 *   • Schema is missing the `session` table (very old / very new OpenCode)
 *   • Any other read error — never throws into the caller
 */
export function listOpencodeSessionsFromDb(
  cwd: string,
  maxCount = 50,
  opts: { homeDir?: string } = {},
): OpencodeSessionRow[] {
  const dbPath = resolveOpencodeDbPath(opts.homeDir);
  if (!dbPath) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // SELECT only columns guaranteed since OpenCode v0.x. The `session` table
    // has gained columns over time (`workspace_id`, `path`, `agent`, `model`,
    // cost/token counters) but the five we read are stable.
    const rows = db
      .prepare(
        `SELECT
           id,
           directory,
           title,
           time_created AS timeCreated,
           time_updated AS timeUpdated
         FROM session
         WHERE directory = ?
         ORDER BY time_updated DESC
         LIMIT ?`,
      )
      .all(cwd, maxCount) as OpencodeSessionRow[];
    return rows;
  } catch {
    // SQLITE_BUSY (concurrent write), SQLITE_CANTOPEN (perms),
    // SQLITE_NOTADB (corrupt), SQLITE_ERROR (no such table) all land here.
    // Treat as "no sessions" — the disk-scanner falls back to the subprocess.
    return [];
  } finally {
    db?.close();
  }
}
