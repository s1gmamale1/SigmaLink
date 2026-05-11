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
// Storage key: kv['app.lastSession'] — a JSON-encoded `{ workspaceId, room }`
// envelope. Reads validate the shape and fail closed (returns null), so a
// corrupt or stale value never crashes boot — the user just lands on the
// picker as if first-run.

import { z } from 'zod';
import { getRawDb } from '../db/client';

/**
 * Zod schemas for the `app:session-snapshot` (renderer → main) and
 * `app:session-restore` (main → renderer) event payloads. Mirrored on both
 * ends — the renderer narrows incoming snapshots through `SessionSnapshot`
 * before dispatching SET_ROOM, the main process validates outgoing writes
 * through `parse` so a malicious/buggy renderer can't poison the kv row.
 */
export const SessionSnapshotSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  room: z.string().min(1).max(80),
});

export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

const KV_KEY = 'app.lastSession';

let cached: SessionSnapshot | null = null;

/**
 * Cache a snapshot from the renderer. Called from the IPC handler bound to
 * `app:session-snapshot`. Does NOT write to kv on every call — the kv write
 * happens once at quit so we don't thrash the WAL during a normal session.
 *
 * Returns `true` when the payload validated and was cached, `false`
 * otherwise. Callers can ignore the return value — it exists to make the
 * unit test boundary explicit.
 */
export function rememberSessionSnapshot(snapshot: unknown): boolean {
  const parsed = SessionSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return false;
  cached = { workspaceId: parsed.data.workspaceId, room: parsed.data.room };
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
  const parsed = SessionSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return;
  const value = JSON.stringify(parsed.data);
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
  return parsed.success ? parsed.data : null;
}

/**
 * Test-only: clear the in-memory cache between tests so module state doesn't
 * leak across cases. Not exposed in the production export path; the test
 * suite imports the module directly.
 */
export function __resetForTests(): void {
  cached = null;
}

export const SESSION_KV_KEY = KV_KEY;
