// P4 MEM-2 — Daily Notes helper. "Open today's note" jumps to (or creates)
// a note named `YYYY-MM-DD` tagged `daily`. Kept dependency-injected so the
// helper is pure-of-electron and unit-testable: the caller passes the live
// `rpc.memory.*` methods (and `new Date()`), the test passes fakes.

import type { Memory } from '@/shared/types';
import type { rpc } from '@/renderer/lib/rpc';

/**
 * Stable, local-time, zero-padded `YYYY-MM-DD` name for a daily note.
 *
 * Uses the Date's *local* calendar fields (not `toISOString`, which is UTC) so
 * the note name matches the day the user actually sees on their clock.
 */
export function dailyNoteName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Injected slice of the memory RPC the helper needs. */
export interface DailyNoteDeps {
  create: typeof rpc.memory.create_memory;
  read: typeof rpc.memory.read_memory;
}

/**
 * Resolve today's (or any date's) daily note, creating it if absent.
 *
 * Idempotent + race-tolerant:
 *  1. `read` first — if the note already exists, return it untouched (no write,
 *     so an existing daily note's body/tags are preserved).
 *  2. Otherwise `create` it with a `# YYYY-MM-DD` heading body and the `daily`
 *     tag.
 *  3. `create_memory` throws if the name was created in between (it's
 *     idempotent-throws-on-exists). We swallow that and re-`read` so a
 *     double-invoke (or a concurrent create elsewhere) still resolves the note.
 */
export async function openDailyNote(
  workspaceId: string,
  date: Date,
  deps: DailyNoteDeps,
): Promise<Memory> {
  const name = dailyNoteName(date);

  const existing = await deps.read({ workspaceId, name });
  if (existing) return existing;

  try {
    return await deps.create({
      workspaceId,
      name,
      body: `# ${name}\n`,
      tags: ['daily'],
    });
  } catch (err) {
    // Lost the create race (name now exists) — fall back to read. Only treat a
    // resolved read as recovery; otherwise surface the original create error so
    // genuine failures aren't masked.
    const recovered = await deps.read({ workspaceId, name });
    if (recovered) return recovered;
    throw err;
  }
}
