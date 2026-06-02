// P6 FEAT-3 — usage ledger DAO coverage.
//
// DB CONSTRAINT: better-sqlite3 cannot load under vitest (it is built for
// Electron's ABI), so we NEVER call `new Database()`. Instead we hand-roll a
// chainable drizzle fake (the same MockDb philosophy as memory/db.test.ts) that:
//   - captures the row passed to insert(usageLedger).values(v).run()  → recordTurn
//   - records the `sql` object passed to db.get(...) / db.all(...) and returns a
//     canned aggregate result                                         → summaries
// We extract the bound params + a flattened SQL string from drizzle's `sql`
// template (its `.queryChunks`) so the tests can assert BOTH the emitted query
// shape (WHERE binding, GROUP BY, window filter) AND the summary math (the
// mapping of SUM/COUNT columns onto UsageSummary / UsageWeekSummary).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
}));

import { recordTurn, sessionSummary, weekSummary } from './dao';
import { usageLedger } from '../db/schema';

type AnyRow = Record<string, unknown>;

// ── Flatten a drizzle `sql` object into { text, params } ──────────────────────
// drizzle-orm v0.x: `sql\`…\`` exposes `.queryChunks` — an array of StringChunk
// (`{ value: string[] }`, literal SQL fragments) and Param (`{ value, encoder }`,
// a bound value). We join the fragments and collect the bound values in order.
function flattenSql(sqlObj: unknown): { text: string; params: unknown[] } {
  const chunks = (sqlObj as AnyRow)?.queryChunks as unknown[] | undefined;
  const text: string[] = [];
  const params: unknown[] = [];
  const walk = (arr: unknown[]): void => {
    for (const chunk of arr) {
      if (chunk == null) continue;
      if (typeof chunk !== 'object') {
        params.push(chunk);
        continue;
      }
      const c = chunk as AnyRow;
      if (Array.isArray(c.queryChunks)) {
        walk(c.queryChunks as unknown[]);
        continue;
      }
      if (Array.isArray(c.value)) {
        text.push((c.value as string[]).join(''));
        continue;
      }
      if ('encoder' in c) {
        params.push(c.value);
        continue;
      }
    }
  };
  walk(chunks ?? []);
  return { text: text.join(' ').replace(/\s+/g, ' ').trim(), params };
}

// ── Chainable drizzle fake ────────────────────────────────────────────────────
class Fake {
  inserted: AnyRow[] = [];
  /** Last sql passed to get()/all(), flattened. */
  lastGet: { text: string; params: unknown[] } | null = null;
  lastAll: { text: string; params: unknown[] } | null = null;
  /** Canned results the DAO will read back. */
  getResult: AnyRow | undefined = undefined;
  allResult: AnyRow[] = [];

  insert(table: unknown) {
    expect(table).toBe(usageLedger);
    return {
      values: (v: AnyRow) => ({
        run: () => {
          this.inserted.push({ ...v });
        },
      }),
    };
  }
  get<T>(sqlObj: unknown): T {
    this.lastGet = flattenSql(sqlObj);
    return this.getResult as T;
  }
  all<T>(sqlObj: unknown): T {
    this.lastAll = flattenSql(sqlObj);
    return this.allResult as T;
  }
}

let fake: Fake;
beforeEach(() => {
  fake = new Fake();
});

function db() {
  return fake as unknown as Parameters<typeof recordTurn>[0];
}

describe('recordTurn', () => {
  it('inserts a usage_ledger row keyed by conversationId with all token fields', () => {
    recordTurn(db(), {
      sessionId: null,
      conversationId: 'conv-1',
      providerId: 'claude',
      modelId: 'claude-sonnet',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
      totalCostUsd: 0.0123,
      recordedAt: 1_700_000_000_000,
    });
    expect(fake.inserted).toHaveLength(1);
    const row = fake.inserted[0];
    expect(row).toMatchObject({
      sessionId: null,
      conversationId: 'conv-1',
      providerId: 'claude',
      modelId: 'claude-sonnet',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
      totalCostUsd: 0.0123,
      recordedAt: 1_700_000_000_000,
    });
    // a generated id is always present
    expect(typeof row.id).toBe('string');
    expect((row.id as string).length).toBeGreaterThan(0);
  });

  it('hardens malformed/negative token fields to 0 and keeps null cost null', () => {
    recordTurn(db(), {
      sessionId: null,
      conversationId: 'conv-2',
      providerId: 'claude',
      modelId: null,
      inputTokens: Number.NaN,
      outputTokens: -42,
      cacheCreationTokens: 7.9, // truncated to 7
      cacheReadTokens: undefined as unknown as number,
      totalCostUsd: null,
      recordedAt: 123,
    });
    const row = fake.inserted[0];
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
    expect(row.cacheCreationTokens).toBe(7);
    expect(row.cacheReadTokens).toBe(0);
    expect(row.totalCostUsd).toBeNull();
  });

  it('coerces a non-finite cost to null', () => {
    recordTurn(db(), {
      sessionId: null,
      conversationId: 'c',
      providerId: 'claude',
      modelId: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCostUsd: Number.POSITIVE_INFINITY,
      recordedAt: 1,
    });
    expect(fake.inserted[0].totalCostUsd).toBeNull();
  });
});

describe('sessionSummary', () => {
  it('sums the per-session aggregate and binds the sessionId in the WHERE', () => {
    fake.getResult = {
      inputTokens: 300,
      outputTokens: 120,
      cacheCreationTokens: 30,
      cacheReadTokens: 15,
      totalCostUsd: 0.5,
      turnCount: 3,
    };
    const out = sessionSummary(db(), 'sess-9');
    expect(out).toEqual({
      inputTokens: 300,
      outputTokens: 120,
      cacheCreationTokens: 30,
      cacheReadTokens: 15,
      totalCostUsd: 0.5,
      turnCount: 3,
    });
    // emitted query: aggregates over usage_ledger filtered by session_id
    expect(fake.lastGet?.text).toMatch(/SUM\(input_tokens\)/i);
    expect(fake.lastGet?.text).toMatch(/FROM usage_ledger/i);
    expect(fake.lastGet?.text).toMatch(/WHERE session_id =/i);
    expect(fake.lastGet?.params).toContain('sess-9');
  });

  it('returns the empty summary when there are no rows (null get result)', () => {
    fake.getResult = undefined;
    const out = sessionSummary(db(), 'sess-empty');
    expect(out).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCostUsd: null,
      turnCount: 0,
    });
  });

  it('maps a zero-turn aggregate (COUNT 0, null SUMs) to a clean empty summary', () => {
    fake.getResult = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCostUsd: null,
      turnCount: 0,
    };
    const out = sessionSummary(db(), 'sess-zero');
    expect(out.turnCount).toBe(0);
    expect(out.totalCostUsd).toBeNull();
    expect(out.inputTokens).toBe(0);
  });
});

describe('weekSummary', () => {
  it('groups by provider, binds the workspace + since window, and maps the rows', () => {
    fake.allResult = [
      { providerId: 'claude', totalCostUsd: 0.9, inputTokens: 500, outputTokens: 200, turnCount: 4 },
      { providerId: 'codex', totalCostUsd: null, inputTokens: 10, outputTokens: 5, turnCount: 1 },
    ];
    const since = 1_699_000_000_000;
    const out = weekSummary(db(), 'ws-7', since);
    expect(out.weekStartMs).toBe(since);
    expect(out.byProvider).toEqual([
      { providerId: 'claude', totalCostUsd: 0.9, inputTokens: 500, outputTokens: 200, turnCount: 4 },
      { providerId: 'codex', totalCostUsd: null, inputTokens: 10, outputTokens: 5, turnCount: 1 },
    ]);
    // emitted query: grouped, windowed, dual-linkage workspace filter
    const text = fake.lastAll?.text ?? '';
    expect(text).toMatch(/GROUP BY u\.provider_id/i);
    expect(text).toMatch(/recorded_at >=/i);
    expect(text).toMatch(/agent_sessions/i);
    expect(text).toMatch(/conversations/i);
    // both the since window and the workspaceId (twice — once per linkage) bind
    expect(fake.lastAll?.params).toContain(since);
    expect(fake.lastAll?.params?.filter((p) => p === 'ws-7')).toHaveLength(2);
  });

  it('returns an empty byProvider list when no rows match', () => {
    fake.allResult = [];
    const out = weekSummary(db(), 'ws-empty', 42);
    expect(out).toEqual({ weekStartMs: 42, byProvider: [] });
  });
});
