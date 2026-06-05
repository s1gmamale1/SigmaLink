// BUG-V1.1.2-02 — Session restore.
//
// Persist the renderer's last-known workspace + room on quit so a restart can
// resume where the user left off instead of dumping them back on the
// Workspaces picker. Implementation uses the emit-on-change pattern: the
// renderer sends an `app:session-snapshot` event on every relevant dispatch,
// we cache it in module state, and the kv write fires from the main process
// `before-quit` handler (renderer may already be torn down at that point, so
// query-on-quit is not reliable).
//
// CRIT-3: `before-quit` is never called on a SIGKILL force-quit, so workspaces
// are lost on a crash. A trailing-edge throttled flush (~2 s) is scheduled from
// `rememberSessionSnapshot` so a crash loses at most a few seconds of state.
// The timer is unref'd so it never keeps the process alive by itself. The
// `before-quit` flush remains as the final, immediate write.
//
// Storage key: kv['app.lastSession'] — a JSON-encoded session envelope. v1.1.3
// stores `{ activeWorkspaceId, openWorkspaces: [{ workspaceId, room }] }`;
// v1.1.2's legacy `{ workspaceId, room }` remains readable as a fallback.

import { z } from 'zod';
import { getRawDb } from '../db/client';

/**
 * Zod schemas for the `app:session-snapshot` (renderer → main) and
 * `app:session-restore` (main → renderer) event payloads. Mirrored on both
 * ends — the renderer narrows incoming snapshots through `SessionSnapshot`
 * before dispatching SET_ROOM, the main process validates outgoing writes
 * through `parse` so a malicious/buggy renderer can't poison the kv row.
 */
export const LegacySessionSnapshotSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  room: z.string().min(1).max(80),
});

export const SessionSnapshotSchema = z.object({
  activeWorkspaceId: z.string().min(1).max(200),
  openWorkspaces: z
    .array(
      z.object({
        workspaceId: z.string().min(1).max(200),
        room: z.string().min(1).max(80),
      }),
    )
    .min(1)
    .max(50),
});

export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

const KV_KEY = 'app.lastSession';

// CRIT-3: trailing-edge throttle for opportunistic kv flush.
const FLUSH_THROTTLE_MS = 2000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let cached: SessionSnapshot | null = null;

function normalizeSessionSnapshot(snapshot: unknown): SessionSnapshot | null {
  const current = SessionSnapshotSchema.safeParse(snapshot);
  if (current.success) return current.data;

  const legacy = LegacySessionSnapshotSchema.safeParse(snapshot);
  if (legacy.success) {
    return {
      activeWorkspaceId: legacy.data.workspaceId,
      openWorkspaces: [
        {
          workspaceId: legacy.data.workspaceId,
          room: legacy.data.room,
        },
      ],
    };
  }

  return null;
}

/**
 * Schedule a trailing-edge opportunistic kv flush ~2 s after the first call
 * in a burst. Coalesces multiple rapid snapshot updates into a single write.
 * The timer is unref'd so it never keeps the event loop alive solely for
 * this purpose — before-quit (or the next snapshot event) will flush instead.
 */
function scheduleOpportunisticFlush(): void {
  if (flushTimer) return; // already scheduled — trailing-edge coalesces the burst
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      persistCachedSnapshot();
    } catch (err) {
      /* a failed opportunistic write is non-fatal — before-quit retries */
      console.warn('[session] opportunistic snapshot flush failed:', err);
    }
  }, FLUSH_THROTTLE_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Cache a snapshot from the renderer. Called from the IPC handler bound to
 * `app:session-snapshot`. Does NOT write to kv on every call — the quit-time
 * flush in `before-quit` is the final write. However, an opportunistic
 * trailing-edge throttled flush is also scheduled (~2 s) so a SIGKILL
 * force-quit loses at most a few seconds of session state (CRIT-3).
 *
 * Returns `true` when the payload validated and was cached, `false`
 * otherwise. Callers can ignore the return value — it exists to make the
 * unit test boundary explicit.
 */
export function rememberSessionSnapshot(snapshot: unknown): boolean {
  const parsed = normalizeSessionSnapshot(snapshot);
  if (!parsed) return false;
  cached = parsed;
  scheduleOpportunisticFlush();
  return true;
}

/**
 * Return whatever snapshot the renderer last reported, or `null` if the
 * renderer has not emitted one yet this session.
 */
export function getCachedSnapshot(): SessionSnapshot | null {
  return cached;
}

/**
 * Flush the cached snapshot to kv. Idempotent — calling with nothing cached
 * is a no-op so first-run-then-quit doesn't write a junk row.
 */
export function persistCachedSnapshot(): void {
  if (!cached) return;
  try {
    writeSessionSnapshot(cached);
  } catch {
    /* before-quit must never throw — a failed write just means the user
       lands on the picker on next launch, identical to first-run. */
  }
}

/**
 * Direct write helper. Exposed so the unit test can exercise the codec
 * without spinning up the renderer. Re-validates the shape so a misuse
 * inside main (programming bug) is rejected before we touch kv.
 */
export function writeSessionSnapshot(snapshot: SessionSnapshot): void {
  const parsed = normalizeSessionSnapshot(snapshot);
  if (!parsed) return;
  const value = JSON.stringify(parsed);
  getRawDb()
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KV_KEY, value);
}

/**
 * Read the persisted snapshot from kv. Returns `null` when:
 *   - no row exists (first run);
 *   - the row is malformed JSON;
 *   - the JSON does not match the SessionSnapshot shape.
 *
 * Caller is responsible for verifying the workspace still exists on disk
 * before dispatching — a deleted/moved workspace must fall back gracefully
 * to the picker rather than crashing the renderer.
 */
export function readSessionSnapshot(): SessionSnapshot | null {
  let raw: string | null = null;
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_KEY) as { value?: string } | undefined;
    raw = row?.value ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = SessionSnapshotSchema.safeParse(parsedJson);
  if (parsed.success) return parsed.data;
  return normalizeSessionSnapshot(parsedJson);
}

/**
 * Test-only: clear the in-memory cache and any pending throttle timer between
 * tests so module state doesn't leak across cases. Not exposed in the
 * production export path; the test suite imports the module directly.
 */
export function __resetForTests(): void {
  cached = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export const SESSION_KV_KEY = KV_KEY;
