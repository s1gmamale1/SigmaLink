// 0040 — Seed missions.autonomy.* KV defaults (P1b Task 5).
//
// The wake scheduler (core/operator/scheduler.ts) reads three KV keys, each
// with its own built-in fallback if the key is absent (enabled → disabled,
// dailyBudget → 20, quietHours → none). This migration seeds them explicitly
// so a fresh install's autonomy posture is visible in the kv table instead
// of hidden behind code fallbacks:
//   - missions.autonomy.enabled='0'      CRITICAL safety default — autonomy
//     stays OFF until an operator opts in.
//   - missions.autonomy.dailyBudget='40' the plan's default, NOT the
//     scheduler's built-in fallback of 20 — seeding this means that 20
//     fallback is never actually live on a fresh install.
//   - missions.autonomy.quietHours=''    "no quiet hours" (the plan's
//     default: none). An empty string reads identically to an absent key in
//     isQuietHours() — seeded explicitly so the key is discoverable in the
//     kv table rather than silently absent.
//
// INSERT OR IGNORE is safe to re-run: it skips a row once the key already
// exists (e.g. an operator has changed it).
//
// H-7: the runner owns the transaction; this migration MUST NOT issue BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0040_missions_autonomy_kv';

const DEFAULTS: Array<{ key: string; value: string }> = [
  { key: 'missions.autonomy.enabled', value: '0' },
  { key: 'missions.autonomy.dailyBudget', value: '40' },
  { key: 'missions.autonomy.quietHours', value: '' },
];

export function up(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, (unixepoch() * 1000))`,
  );
  for (const { key, value } of DEFAULTS) {
    insert.run(key, value);
  }
}
