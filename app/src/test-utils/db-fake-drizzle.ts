// Drizzle-flavoured query-builder fake. Implements the subset of
// drizzle-orm's chain API used by mailbox.ts, tools.ts, factory.ts:
//   db.select() / db.select({ alias: col }) → SelectBuilder
//   SelectBuilder.from(table) → FromBuilder
//   FromBuilder.where(sql) → FilterBuilder
//   FromBuilder.orderBy(sql) → FilterBuilder
//   FilterBuilder.all() / .get() / .orderBy(...)
//   db.insert(table).values(obj).run()
//   db.update(table).set(obj).where(sql).run()
//
// `eq(col, val)` produces an SQL with queryChunks like
//   [StringChunk(""), Column, StringChunk(" = "), Param, StringChunk("")]
// and `and(a, b)` wraps two SQL objects with paren/" and " separators. We walk
// the chunk tree to extract (column, value) equality pairs.

import {
  columnJsKey,
  ensureTable,
  registerTable,
  type DbStore,
  type DrizzleColumn,
  type DrizzleTable,
  type Predicate,
  type SqlChunk,
} from './db-fake-store';

interface EqClause {
  jsKey: string;
  value: unknown;
}

function isStringChunk(chunk: SqlChunk): boolean {
  return Array.isArray(chunk.value) && !('name' in chunk) && !('queryChunks' in chunk);
}

function isColumn(chunk: SqlChunk): chunk is SqlChunk & { name: string; table: DrizzleTable } {
  return typeof chunk.name === 'string' && chunk.table !== undefined;
}

function isParam(chunk: SqlChunk): chunk is SqlChunk & { value: unknown } {
  return 'value' in chunk && 'encoder' in chunk && !('queryChunks' in chunk);
}

function isNestedSql(chunk: SqlChunk): chunk is SqlChunk & { queryChunks: SqlChunk[] } {
  return Array.isArray(chunk.queryChunks);
}

function collectEqClauses(table: DrizzleTable, chunks: SqlChunk[]): EqClause[] {
  const out: EqClause[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (isNestedSql(chunk)) {
      out.push(...collectEqClauses(table, chunk.queryChunks));
      continue;
    }
    if (isColumn(chunk)) {
      let paramIdx = -1;
      for (let j = i + 1; j < chunks.length; j++) {
        if (isStringChunk(chunks[j])) continue;
        paramIdx = j;
        break;
      }
      if (paramIdx !== -1 && isParam(chunks[paramIdx])) {
        const jsKey = columnJsKey(table, chunk as unknown as DrizzleColumn);
        if (jsKey) out.push({ jsKey, value: chunks[paramIdx].value });
        i = paramIdx;
      }
    }
  }
  return out;
}

function parsePredicate(table: DrizzleTable, sql: SqlChunk | undefined): Predicate {
  if (!sql || !sql.queryChunks) return () => true;
  const clauses = collectEqClauses(table, sql.queryChunks);
  if (clauses.length === 0) return () => true;
  return (row) => clauses.every((c) => row[c.jsKey] === c.value);
}

function projectRow(
  row: Record<string, unknown>,
  projection: Record<string, DrizzleColumn>,
  table: DrizzleTable,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [alias, col] of Object.entries(projection)) {
    const jsKey = columnJsKey(table, col) ?? col.name;
    out[alias] = row[jsKey];
  }
  return out;
}

export interface SelectBuilder {
  from: (table: DrizzleTable) => FromBuilder;
}

export interface FromBuilder {
  where: (pred?: SqlChunk) => FilterBuilder;
  orderBy: (...args: unknown[]) => FilterBuilder;
  all: () => Record<string, unknown>[];
  get: () => Record<string, unknown> | undefined;
}

export interface FilterBuilder {
  orderBy: (...args: unknown[]) => FilterBuilder;
  all: () => Record<string, unknown>[];
  get: () => Record<string, unknown> | undefined;
}

export interface DrizzleLikeDb {
  select: (projection?: Record<string, DrizzleColumn>) => SelectBuilder;
  insert: (
    table: DrizzleTable,
  ) => { values: (v: Record<string, unknown>) => { run: () => void } };
  update: (table: DrizzleTable) => {
    set: (patch: Record<string, unknown>) => {
      where: (pred?: SqlChunk) => { run: () => void };
      run: () => void;
    };
  };
}

function makeFromBuilder(
  store: DbStore,
  table: DrizzleTable,
  sqlName: string,
  projection: Record<string, DrizzleColumn> | undefined,
): FromBuilder {
  let pendingPred: Predicate = () => true;
  let predBound = false;
  const materialise = (): Record<string, unknown>[] => {
    const rows = store.tables.get(sqlName) ?? [];
    const filtered = predBound ? rows.filter(pendingPred) : rows;
    if (!projection) return filtered.map((r) => ({ ...r }));
    return filtered.map((r) => projectRow(r, projection, table));
  };
  const makeFilter = (): FilterBuilder => ({
    orderBy: () => makeFilter(),
    all: () => materialise(),
    get: () => materialise()[0],
  });
  return {
    where: (pred) => {
      pendingPred = parsePredicate(table, pred);
      predBound = true;
      return makeFilter();
    },
    orderBy: () => makeFilter(),
    all: () => materialise(),
    get: () => materialise()[0],
  };
}

function makeSelectBuilder(
  store: DbStore,
  projection: Record<string, DrizzleColumn> | undefined,
): SelectBuilder {
  return {
    from: (table) => {
      const sqlName = registerTable(store, table);
      return makeFromBuilder(store, table, sqlName, projection);
    },
  };
}

export function makeDrizzleFake(store: DbStore): DrizzleLikeDb {
  return {
    select: (projection) => makeSelectBuilder(store, projection),
    insert: (table) => {
      const sqlName = registerTable(store, table);
      return {
        values: (v) => ({
          run: () => {
            ensureTable(store, sqlName).push({ ...v });
          },
        }),
      };
    },
    update: (table) => {
      const sqlName = registerTable(store, table);
      return {
        set: (patch) => {
          let pendingPred: Predicate | null = null;
          const exec = (): void => {
            const rows = store.tables.get(sqlName);
            if (!rows) return;
            const pred = pendingPred ?? (() => true);
            for (const row of rows) {
              if (pred(row)) Object.assign(row, patch);
            }
          };
          return {
            where: (pred?: SqlChunk) => {
              pendingPred = parsePredicate(table, pred);
              return { run: exec };
            },
            run: exec,
          };
        },
      };
    },
  };
}
