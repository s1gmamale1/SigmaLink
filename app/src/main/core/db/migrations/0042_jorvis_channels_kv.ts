// 0042 — Seed Jorvis P3 channels KV defaults (P3 Task 1).
//
// The Telegram bridge's proactive-push primitive (`pushToOperator`) and the
// daily-brief scheduler both read KV keys that need an explicit, discoverable
// default on a fresh install rather than a silent code fallback:
//   - remote.telegram.operatorChatId=''  no operator chat captured yet. The
//     bridge auto-captures this on every allowlisted inbound message
//     (last-writer-wins); an empty value means pushToOperator() no-ops
//     (audited drop) until the operator has said something at least once.
//   - jorvis.brief.enabled='0'           CRITICAL safety-adjacent default —
//     the daily brief stays OFF until an operator opts in (mirrors
//     missions.autonomy.enabled from 0040).
//   - jorvis.brief.time='09:00'          the plan's default fire time for the
//     scheduled board digest, HH:MM 24h local.
//
// INSERT OR IGNORE is safe to re-run (0040/0041 idiom): it skips a row once
// the key already exists (e.g. an operator has changed it, or the bridge has
// already captured a chat id).
//
// H-7: the runner owns the transaction; this migration MUST NOT issue BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0042_jorvis_channels_kv';

const DEFAULTS: Array<{ key: string; value: string }> = [
  { key: 'remote.telegram.operatorChatId', value: '' },
  { key: 'jorvis.brief.enabled', value: '0' },
  { key: 'jorvis.brief.time', value: '09:00' },
];

export function up(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, (unixepoch() * 1000))`,
  );
  for (const { key, value } of DEFAULTS) {
    insert.run(key, value);
  }
}
