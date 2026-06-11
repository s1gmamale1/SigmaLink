// win32-db-lifecycle (2026-06-11) — boot-time database open with bounded
// BUSY retry + WAL reclaim.
//
// `initializeDatabase` throws straight through `registerRouter()` (correct for
// corruption — DB-1 quarantines those — but a SQLITE_BUSY from a transient
// lock-holder became the "JavaScript error in the main process" crash dialog).
// On Windows the lock-holders are real: orphaned per-CLI mcp-memory-server
// children from a PREVIOUS run (see core/process/orphan-sweep.ts). The boot
// sweep kills them first, but orphans spawned by OLDER builds exist on every
// device the moment this update lands, and each CLI child also runs its own
// bootstrap DDL (mcp-server.ts → initializeDatabase) so short write contention
// is by-design. Busy is therefore RETRYABLE at boot; everything else is not.
//
// On success we also best-effort `wal_checkpoint(TRUNCATE)` — historic failed
// quit-checkpoints (orphan readers pinned the WAL) left devices with -wal
// files tens of MB large; this reclaims them at the first healthy boot and is
// ~free when the WAL is already small.

import type Database from 'better-sqlite3';

export interface BootOpenDeps<T extends { raw: Database.Database }> {
  /** Prod: db/client's initializeDatabase. Injected for tests. */
  initialize: (userDataDir: string) => T;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** A lock-contention signal — transient by nature, worth retrying at boot. */
export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_RECOVERY' || code === 'SQLITE_BUSY_SNAPSHOT') {
    return true;
  }
  return /database is locked|database table is locked/i.test(err.message);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open the database with a bounded retry on busy/locked errors. Non-busy
 * errors (corruption already handled inside initialize, EACCES, …) rethrow
 * immediately — retrying those would just delay an honest failure. After a
 * successful open, best-effort TRUNCATE-checkpoint the WAL.
 */
export async function openDatabaseWithBootRetry<T extends { raw: Database.Database }>(
  userDataDir: string,
  deps: BootOpenDeps<T>,
): Promise<T> {
  const attempts = deps.attempts ?? 4;
  const delayMs = deps.delayMs ?? 1500;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((msg: string) => console.warn(msg));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const out = deps.initialize(userDataDir);
      // Boot WAL reclaim — quit-side checkpoints have historically failed on
      // Windows (orphan readers), growing -wal unboundedly. Best-effort.
      try {
        out.raw.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        log(`[boot] wal_checkpoint(TRUNCATE) failed (non-fatal): ${String(err)}`);
      }
      return out;
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastErr = err;
      if (attempt < attempts) {
        log(
          `[boot] sigmalink.db is locked (attempt ${attempt}/${attempts}) — ` +
            `a previous run's process may still be releasing it; retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}
