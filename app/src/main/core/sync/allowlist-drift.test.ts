// v1.5.2-C — Allowlist drift detector (v1.5.1 PR #57 reviewer follow-up).
//
// Asserts that every column declared in the Drizzle schema for each synced
// table is present in the COLUMN_ALLOWLIST in engine.ts. If a future
// migration adds a column to a synced table (and SYNCED_TABLES is updated)
// but COLUMN_ALLOWLIST is not, this test will fail immediately — making the
// oversight visible rather than silently dropping the new column at sync time.
//
// Uses drizzle-orm's `getTableColumns()` helper to introspect each table's
// SQLite column names from the typed schema definition.

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from '@/main/core/db/schema';
import { COLUMN_ALLOWLIST } from './engine';
import { SYNCED_TABLES } from './dirty-tracker';

// ------------------------------------------------------------------
// Build a map from SQLite table name → drizzle table object.
// Introspect every export from schema.ts that is a drizzle SQLiteTable.
// ------------------------------------------------------------------

// Drizzle table objects carry a Symbol property `[IsDrizzleTable] = true`.
// We detect them via duck-typing: getTableConfig() succeeds only on table
// objects; it throws on type exports (interfaces, plain objects, strings).
function buildTableNameMap(): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [, value] of Object.entries(schema)) {
    if (!value || typeof value !== 'object') continue;
    try {
      const cfg = getTableConfig(value as never);
      if (cfg?.name) {
        map.set(cfg.name, value);
      }
    } catch {
      // Not a table object — skip (type exports, plain objects, strings, etc.)
    }
  }
  return map;
}

const drizzleTableByName = buildTableNameMap();

// ------------------------------------------------------------------
// Drift detection test
// ------------------------------------------------------------------

describe('COLUMN_ALLOWLIST drift detector', () => {
  it('contains every Drizzle column for each table in SYNCED_TABLES — no columns must be missing', () => {
    const driftReport: string[] = [];

    for (const tableName of SYNCED_TABLES) {
      const drizzleTable = drizzleTableByName.get(tableName);
      if (!drizzleTable) {
        // Table is in SYNCED_TABLES but has no Drizzle schema definition.
        // This itself is a configuration error; flag it.
        driftReport.push(
          `[${tableName}] is in SYNCED_TABLES but has no corresponding Drizzle table export in schema.ts`,
        );
        continue;
      }

      // Extract the SQLite column names from the Drizzle table definition.
      const columns = getTableColumns(drizzleTable as never);
      const drizzleColNames: string[] = Object.values(columns).map(
        (col) => (col as { name: string }).name,
      );

      const allowlist = COLUMN_ALLOWLIST.get(tableName);
      if (!allowlist) {
        // Table is in SYNCED_TABLES but has no allowlist entry at all.
        driftReport.push(
          `[${tableName}] is in SYNCED_TABLES but is missing from COLUMN_ALLOWLIST entirely`,
        );
        continue;
      }

      // Check for columns present in the Drizzle schema but absent from the allowlist.
      const missingFromAllowlist = drizzleColNames.filter((col) => !allowlist.has(col));
      if (missingFromAllowlist.length > 0) {
        driftReport.push(
          `[${tableName}] Drizzle columns not in COLUMN_ALLOWLIST: ${missingFromAllowlist.join(', ')}`,
        );
      }
    }

    if (driftReport.length > 0) {
      // Emit a clear, actionable failure message.
      const msg = [
        'COLUMN_ALLOWLIST drift detected — the following Drizzle schema columns are',
        'missing from engine.ts COLUMN_ALLOWLIST. Sync will silently drop these columns',
        'on remote apply. Add them to COLUMN_ALLOWLIST (or explicitly exclude the table',
        'from SYNCED_TABLES if it should not be synced):',
        '',
        ...driftReport,
      ].join('\n');
      expect.fail(msg);
    }
  });

  it('every entry in COLUMN_ALLOWLIST corresponds to a table in SYNCED_TABLES', () => {
    // Inverse check: make sure COLUMN_ALLOWLIST does not reference tables
    // that have been removed from SYNCED_TABLES.
    const spurious: string[] = [];
    for (const tableName of COLUMN_ALLOWLIST.keys()) {
      if (!SYNCED_TABLES.has(tableName)) {
        spurious.push(tableName);
      }
    }
    if (spurious.length > 0) {
      expect.fail(
        `COLUMN_ALLOWLIST references tables not in SYNCED_TABLES: ${spurious.join(', ')}. ` +
        `Remove them from COLUMN_ALLOWLIST or add them to SYNCED_TABLES.`,
      );
    }
  });
});
