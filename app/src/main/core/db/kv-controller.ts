// Tiny key/value access layer over the existing `kv` SQLite table. Used by
// the renderer to persist UI preferences (theme, sidebar collapse, onboarded
// flag) without spinning up a dedicated controller per setting.
//
// Keys are namespaced informally (e.g. `app.theme`, `app.sidebar.collapsed`).
// Values are stored as opaque strings; callers serialize their own JSON if
// needed.

import { defineController } from '../../../shared/rpc';
import { getRawDb } from './client';

export function buildKvController() {
  return defineController({
    get: async (key: string): Promise<string | null> => {
      if (typeof key !== 'string' || !key) return null;
      const row = getRawDb()
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    },
    set: async (key: string, value: string): Promise<void> => {
      if (typeof key !== 'string' || !key) {
        throw new Error('kv.set: key must be a non-empty string');
      }
      const v = typeof value === 'string' ? value : String(value ?? '');
      getRawDb()
        .prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch() * 1000)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, v);
    },
  });
}
