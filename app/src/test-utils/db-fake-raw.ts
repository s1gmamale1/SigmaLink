// Raw better-sqlite3-style fake. Production seeding code in unit tests uses
// `getRawDb().prepare(sql).run(...)`; we parse a minimal SQL subset so test
// fixtures keep their SQL-flavoured shape without touching the native module.
// Supported shapes:
//   - INSERT INTO <table> (...) VALUES (...) — params bind to placeholders
//   - SELECT <col> FROM <table> WHERE <key> = ? — kv-style reads
//   - UPDATE <table> SET ... WHERE ... — used by skills tests
// Anything else returns a no-op statement so misc. PRAGMA / TX bookkeeping
// does not blow up.

import { ensureTable, sqlNameToJsKey, type DbStore } from './db-fake-store';

export interface RawStatement {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Record<string, unknown>[];
}

export interface RawDbLike {
  prepare: (sql: string) => RawStatement;
  pragma: (statement: string) => unknown;
  transaction: <T extends (...args: unknown[]) => unknown>(fn: T) => T;
  exec: (sql: string) => void;
  close: () => void;
}

interface InsertShape {
  table: string;
  cols: string[];
}

interface SelectShape {
  table: string;
  selectCols: '*' | string[];
  wherePredicates: SelectPredicate[];
}

interface UpdateShape {
  table: string;
  setCols: string[];
  whereCols: string[];
}

type SelectPredicate =
  | { kind: 'eq'; sqlCol: string }
  | { kind: 'isNotNull'; sqlCol: string }
  | { kind: 'in'; sqlCol: string; values: string[] };

const INSERT_RE =
  /^\s*INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES/i;
const SELECT_RE = /^\s*SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is;
const UPDATE_RE = /^\s*UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is;

function parseColumnList(s: string): string[] {
  return s
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

function extractWhereCols(whereRaw: string): string[] {
  if (!whereRaw) return [];
  const out: string[] = [];
  for (const part of whereRaw.split(/\s+AND\s+/i)) {
    const m = /^\s*(\w+)\s*=\s*\?/.exec(part);
    if (m) out.push(m[1]);
  }
  return out;
}

function parseSqlStringList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const quoted = /^'([^']*)'$/.exec(trimmed);
      return quoted ? quoted[1] : trimmed;
    })
    .filter(Boolean);
}

function extractSelectPredicates(whereRaw: string): SelectPredicate[] {
  if (!whereRaw) return [];
  const out: SelectPredicate[] = [];
  for (const part of whereRaw.split(/\s+AND\s+/i)) {
    const eq = /^\s*(\w+)\s*=\s*\?/.exec(part);
    if (eq) {
      out.push({ kind: 'eq', sqlCol: eq[1] });
      continue;
    }
    const notNull = /^\s*(\w+)\s+IS\s+NOT\s+NULL\s*$/i.exec(part);
    if (notNull) {
      out.push({ kind: 'isNotNull', sqlCol: notNull[1] });
      continue;
    }
    const inList = /^\s*(\w+)\s+IN\s*\(([^)]+)\)\s*$/i.exec(part);
    if (inList) {
      out.push({
        kind: 'in',
        sqlCol: inList[1],
        values: parseSqlStringList(inList[2]),
      });
    }
  }
  return out;
}

function parseInsert(sql: string): InsertShape | null {
  const m = INSERT_RE.exec(sql);
  return m ? { table: m[1], cols: parseColumnList(m[2]) } : null;
}

function parseSelect(sql: string): SelectShape | null {
  const m = SELECT_RE.exec(sql);
  if (!m) return null;
  const colsRaw = m[1].trim();
  const whereRaw = (m[3]?.trim() ?? '').replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, '');
  return {
    table: m[2],
    selectCols: colsRaw === '*' ? '*' : parseColumnList(colsRaw),
    wherePredicates: extractSelectPredicates(whereRaw),
  };
}

function parseUpdate(sql: string): UpdateShape | null {
  const m = UPDATE_RE.exec(sql);
  if (!m) return null;
  const setCols: string[] = [];
  for (const seg of m[2].split(',')) {
    const c = /^\s*(\w+)\s*=\s*\?/.exec(seg.trim());
    if (c) setCols.push(c[1]);
  }
  return {
    table: m[1],
    setCols,
    whereCols: extractWhereCols(m[3]?.trim() ?? ''),
  };
}

function filterSelect(
  store: DbStore,
  select: SelectShape,
  params: unknown[],
): Record<string, unknown>[] {
  const rows = store.tables.get(select.table) ?? [];
  const filtered = rows.filter((row) => {
    let paramIdx = 0;
    for (const pred of select.wherePredicates) {
      const jsKey = sqlNameToJsKey(store, select.table, pred.sqlCol);
      const value = row[jsKey];
      if (pred.kind === 'eq') {
        if (value !== params[paramIdx]) return false;
        paramIdx += 1;
      } else if (pred.kind === 'isNotNull') {
        if (value === null || value === undefined) return false;
      } else if (!pred.values.includes(String(value))) {
        return false;
      }
    }
    return true;
  });
  if (select.selectCols === '*') return filtered.map((r) => ({ ...r }));
  return filtered.map((row) => {
    const out: Record<string, unknown> = {};
    for (const sqlCol of select.selectCols) {
      const jsKey = sqlNameToJsKey(store, select.table, sqlCol);
      out[sqlCol] = row[jsKey];
    }
    return out;
  });
}

function execInsert(
  store: DbStore,
  insert: InsertShape,
  params: unknown[],
): { changes: number; lastInsertRowid: number } {
  const rows = ensureTable(store, insert.table);
  const row: Record<string, unknown> = {};
  for (let i = 0; i < insert.cols.length; i++) {
    const jsKey = sqlNameToJsKey(store, insert.table, insert.cols[i]);
    row[jsKey] = params[i];
  }
  rows.push(row);
  return { changes: 1, lastInsertRowid: rows.length };
}

function execUpdate(
  store: DbStore,
  update: UpdateShape,
  params: unknown[],
): { changes: number; lastInsertRowid: number } {
  const rows = store.tables.get(update.table) ?? [];
  const setValues = params.slice(0, update.setCols.length);
  const whereValues = params.slice(update.setCols.length);
  let changes = 0;
  for (const row of rows) {
    const match = update.whereCols.every((sqlCol, idx) => {
      const jsKey = sqlNameToJsKey(store, update.table, sqlCol);
      return row[jsKey] === whereValues[idx];
    });
    if (match) {
      for (let i = 0; i < update.setCols.length; i++) {
        const jsKey = sqlNameToJsKey(store, update.table, update.setCols[i]);
        row[jsKey] = setValues[i];
      }
      changes += 1;
    }
  }
  return { changes, lastInsertRowid: 0 };
}

export function makeRawFake(store: DbStore): RawDbLike {
  return {
    prepare: (sql: string): RawStatement => {
      const trimmed = sql.trim();
      const insert = parseInsert(trimmed);
      const select = parseSelect(trimmed);
      const update = parseUpdate(trimmed);
      return {
        run: (...params) => {
          if (insert) return execInsert(store, insert, params);
          if (update) return execUpdate(store, update, params);
          return { changes: 0, lastInsertRowid: 0 };
        },
        get: (...params) => {
          if (!select) return undefined;
          return filterSelect(store, select, params)[0];
        },
        all: (...params) => {
          if (!select) return [];
          return filterSelect(store, select, params);
        },
      };
    },
    pragma: () => undefined,
    // better-sqlite3 transactions are synchronous wrappers; we return the
    // function untouched. The fake has no rollback semantics.
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
    exec: () => undefined,
    close: () => undefined,
  };
}
