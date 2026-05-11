// Backing store + drizzle-table introspection shared between the raw and
// drizzle surfaces of the in-memory DB fake. See `db-fake.ts` for the public
// surface and rationale.

export const DRIZZLE_COLUMNS = Symbol.for('drizzle:Columns');
export const DRIZZLE_NAME = Symbol.for('drizzle:Name');

export interface DrizzleColumn {
  name: string;
  table: unknown;
}

export interface DrizzleTable {
  [DRIZZLE_NAME]: string;
  [DRIZZLE_COLUMNS]: Record<string, DrizzleColumn>;
}

export interface SqlChunk {
  // StringChunk has `.value` as a single-element array (e.g. `[' = ']`);
  // Column has `.name` + `.table`; Param has `.value` (raw bound value) and
  // `.encoder`; nested SQL has `.queryChunks` (an array).
  value?: unknown;
  name?: string;
  table?: unknown;
  encoder?: unknown;
  queryChunks?: SqlChunk[];
}

export type Predicate = (row: Record<string, unknown>) => boolean;

export interface DbStore {
  /** Rows per table, keyed by SQL table name. Each row uses JS-camelCase keys. */
  tables: Map<string, Record<string, unknown>[]>;
  /** sqlColumnName → jsKey, per table (e.g. workspaces → { workspace_id: "workspaceId" }). */
  sqlToJs: Map<string, Map<string, string>>;
  /** Registered tables, keyed by SQL name. */
  tableRefs: Map<string, DrizzleTable>;
}

export function makeStore(): DbStore {
  return {
    tables: new Map(),
    sqlToJs: new Map(),
    tableRefs: new Map(),
  };
}

export function registerTable(store: DbStore, table: DrizzleTable): string {
  const sqlName = table[DRIZZLE_NAME];
  if (!store.tableRefs.has(sqlName)) {
    store.tableRefs.set(sqlName, table);
    // Preserve rows seeds may have inserted before drizzle first touched
    // this table — registration must not clobber existing state.
    if (!store.tables.has(sqlName)) store.tables.set(sqlName, []);
    const cols = table[DRIZZLE_COLUMNS];
    const map = new Map<string, string>();
    for (const [jsKey, col] of Object.entries(cols)) {
      map.set(col.name, jsKey);
    }
    store.sqlToJs.set(sqlName, map);
  }
  return sqlName;
}

export function columnJsKey(table: DrizzleTable, col: DrizzleColumn): string | null {
  const cols = table[DRIZZLE_COLUMNS];
  for (const [jsKey, candidate] of Object.entries(cols)) {
    if (candidate === col) return jsKey;
  }
  // Fallback by name match — column instance equality should hold in practice.
  return Object.entries(cols).find(([, c]) => c.name === col.name)?.[0] ?? null;
}

export function ensureTable(store: DbStore, sqlName: string): Record<string, unknown>[] {
  let rows = store.tables.get(sqlName);
  if (!rows) {
    rows = [];
    store.tables.set(sqlName, rows);
  }
  return rows;
}

export function sqlNameToJsKey(store: DbStore, table: string, sqlCol: string): string {
  const map = store.sqlToJs.get(table);
  if (map?.has(sqlCol)) return map.get(sqlCol)!;
  // If the table hasn't been registered via drizzle yet, fall back to the raw
  // SQL column name. Tests can still read what they wrote.
  return sqlCol;
}
