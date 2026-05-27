// SF-10 — display-only CLI label on a pane.
//
// An operator can launch a plain `shell` pane and run a CLI inside it manually
// (e.g. `cursor-agent`). This column lets them TAG that pane with which CLI it
// is running so the pane header shows the CLI's name + colour instead of
// "SHELL" — purely cosmetic. It does NOT change spawn/resume/MCP behaviour:
// the session's real `provider_id` is untouched, so resume args, the model
// catalogue, and MCP autobind keep treating it as whatever was launched.
//
// Schema change:
//   agent_sessions.display_provider_id  TEXT  (nullable)
//   NULL  = show the real provider_id (default, every existing row)
//   '<id>' = a provider id from shared/providers.ts to show instead
//
// Single ALTER TABLE ADD COLUMN, applied without an explicit transaction
// wrapper (per the H-7 note in migrate.ts — nesting BEGIN inside the runner's
// transaction crashes fresh-DB startup). Run via prepare().run() (equivalent
// to exec for a single DDL statement).

import type Database from 'better-sqlite3';

export const name = '0025_agent_sessions_display_provider';

export function up(db: Database.Database): void {
  db.prepare(
    `ALTER TABLE agent_sessions ADD COLUMN display_provider_id TEXT;`,
  ).run();
}
