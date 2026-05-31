// DB-1 — SQLite corruption-recovery helpers.
//
// Pure, side-effect-free decision functions used by initializeDatabase()
// (client.ts) to detect a corrupt sigmalink.db at boot and decide whether to
// quarantine the file and recreate a fresh database so the app still boots.
//
// These are factored out of client.ts so they can be unit-tested WITHOUT a real
// better-sqlite3 handle (the native module is built for Electron's ABI and
// cannot load under vitest). The Database wiring itself in client.ts stays
// untested (documented gap) — only the corruption-decision + quarantine-naming
// logic lives here and is covered by corruption.test.ts.

/**
 * Decide whether a thrown error from opening / pragma-ing the database is a
 * corruption signal that warrants quarantining the file.
 *
 * better-sqlite3 surfaces SQLite error codes on `err.code`. The two codes that
 * indicate the on-disk file is unusable as a database are:
 *   - `SQLITE_CORRUPT`  — the file is a malformed SQLite database.
 *   - `SQLITE_NOTADB`   — the file is not a database (e.g. truncated / garbage).
 *
 * Any other error (locked, permission, disk full, …) is NOT a corruption signal
 * and must be re-thrown by the caller so it surfaces normally.
 */
export function isCorruptionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB';
}

/**
 * Decide whether a `PRAGMA quick_check` result means the database should be
 * quarantined. `quick_check` returns the single string `'ok'` on a healthy
 * database; anything else (e.g. an array of error descriptions, or a row whose
 * value is not `'ok'`) indicates structural corruption.
 *
 * Accepts the raw result shape better-sqlite3 yields. We normalise it down to
 * the first reported value: a healthy DB yields exactly `'ok'`.
 */
export function shouldQuarantine(quickCheckResult: unknown): boolean {
  const value = firstQuickCheckValue(quickCheckResult);
  if (value === undefined || value === null) {
    // No / empty result is itself anomalous — treat as corruption.
    return true;
  }
  return String(value).trim().toLowerCase() !== 'ok';
}

/**
 * Extract the first meaningful value from a `PRAGMA quick_check` result.
 *
 * better-sqlite3 `.pragma()` with `{ simple: true }` returns the scalar `'ok'`;
 * without it (or via `.prepare().all()`) it returns rows like
 * `[{ quick_check: 'ok' }]` or, on corruption, multiple rows describing the
 * problems. This normaliser handles the scalar, array-of-rows, and
 * single-row-object shapes.
 */
function firstQuickCheckValue(result: unknown): unknown {
  if (Array.isArray(result)) {
    if (result.length === 0) return undefined;
    return firstQuickCheckValue(result[0]);
  }
  if (result && typeof result === 'object') {
    // Row object: the column is conventionally named `quick_check`, but fall
    // back to the first own value if the column name differs.
    const row = result as Record<string, unknown>;
    if ('quick_check' in row) return row.quick_check;
    const values = Object.values(row);
    return values.length > 0 ? values[0] : undefined;
  }
  return result;
}

/**
 * Build the quarantine path for a corrupt database file.
 *
 * Renames `…/sigmalink.db` to `…/sigmalink.db.corrupt-<timestamp>` so the bad
 * file is PRESERVED (for forensic / recovery purposes) rather than deleted.
 * `now` is injected (defaults to `Date.now()`) so the naming is deterministic
 * under test.
 */
export function corruptBackupPath(filePath: string, now: number = Date.now()): string {
  return `${filePath}.corrupt-${now}`;
}
