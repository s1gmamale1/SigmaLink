# Jorvis P1a — Mission Board (data layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jorvis a persistent **mission board** — a mission (natural-language goal) decomposed into ordered task cards on a kanban, manipulated only through audited tools and rendered live in a new Missions room. This is the *data layer* of ROADMAP Phase 20; the autonomous supervisor loop that drives it is P1b (a separate plan).

**Architecture:** A new bounded context `core/missions/` (pure state machine + DAO over three new tables) beside the unchanged assistant engine. Jorvis manipulates the board through five new tools added at the existing `T()` parse choke point (so they inherit the P0 arg-coercion + auth + tracing). A new `missions.*` RPC namespace + a `missions:changed` event feed a new renderer Missions room. NO pane launches, NO model wake loop, NO autonomy in this plan — those are P1b.

**Tech Stack:** TypeScript (Electron main + React renderer), Drizzle/better-sqlite3 (main; tests use the MockDb/`@/test-utils/db-fake` fake — never `new Database()`), Zod v4 (tool schemas), Vitest, esbuild.

## Global Constraints

- **Missions are a NEW bounded context — do NOT overload the existing `tasks` table / `TasksManager`.** That table (`schema.ts:372`, enum `backlog|in_progress|in_review|done|archived`) is the Phase-6 human personal kanban and stays untouched. Missions get their own tables, DAO, tools, room. The existing `create_task` tool is unchanged. (Spec §6 P1.5 "bridge/absorb — decide at plan time": decision is **keep separate**.)
- **erasableSyntaxOnly ON (TS1294):** no parameter-properties (`constructor(private x)`), no enums, no namespaces — declare a field then assign. `TaskStatus`-style unions are string-literal `type`s, never TS `enum`.
- **Files under ~500 lines; read before edit; MockDb only in tests** (better-sqlite3 won't load under vitest — Electron ABI).
- **Migrations: forward-only, PRAGMA-guarded re-run (mirror `0037_agent_sessions_closed_at.ts`), NO `BEGIN/COMMIT` (H-7: the runner owns the txn).** Register in `migrate.ts` (`mig00NN` import + array entry).
- **New RPC channel = 5 mirror sites:** `shared/rpc-channels.ts` CHANNELS · `shared/router-shape.ts` AppRouter · `main/rpc-router.ts` handler wiring · `main/core/rpc/schemas.ts` zod entry · `shared/rpc-channels.test.ts` TYPED_ROUTER_CHANNELS. A new EVENT = the `EVENTS` set + its membership test. The `rpc-channels.test.ts` parity test passing is the proof.
- **New tool = catalogue parity:** add to BOTH `tools.ts` `TOOLS` and `tool-catalogue.ts` `JORVIS_TOOL_CATALOGUE` (1:1, enforced by `tool-catalogue.test.ts`).
- **New synced table = sync mirror discipline:** if the table should replicate, add to BOTH `core/sync/engine.ts` allowlist AND `core/sync/dirty-tracker.ts` (the two-mirror pattern). Mission tables are LOCAL-ONLY in P1a (missions are per-machine operator state) — do NOT add them to sync; add a one-line comment saying so.
- **Local gate from `app/`:** `npx tsc -b` · `npx vitest run <touched>` then full `npx vitest run` · `npx eslint .` (0 warnings) · `npm run build`. Commit on a feature branch off `origin/main`. NEVER push/tag/release without the operator.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `app/src/main/core/db/migrations/0039_missions.ts` | DDL: `missions` + `mission_tasks` + `mission_events` (+ test) | 1 |
| `app/src/main/core/db/schema.ts` | drizzle table defs + row types (mirror of the DDL) | 1 |
| `app/src/main/core/db/migrate.ts` | register mig0039 | 1 |
| `app/src/shared/types.ts` | `Mission`/`MissionTask`/`MissionEvent` + status unions (cross-process) | 2 |
| `app/src/main/core/missions/state.ts` | pure lifecycle state machine + mission-status rollup | 2 |
| `app/src/main/core/missions/state.test.ts` | state-machine unit tests | 2 |
| `app/src/main/core/missions/dao.ts` | mission/task/event CRUD reads+writes | 3 |
| `app/src/main/core/missions/dao.test.ts` | DAO tests (MockDb) | 3 |
| `app/src/main/core/assistant/tools.ts` | 5 mission tools + schemas | 4 |
| `app/src/main/core/assistant/tool-catalogue.ts` | catalogue mirror of the 5 tools | 4 |
| `app/src/main/core/assistant/tools.missions.test.ts` | mission-tool tests | 4 |
| `app/src/shared/rpc-channels.ts` / `router-shape.ts` / `rpc-router.ts` / `core/rpc/schemas.ts` / `rpc-channels.test.ts` | `missions.list`/`get`/`events` RPC + `missions:changed` event (mirrors) | 5 |
| `app/src/renderer/features/missions/` (new dir) | Missions room: list + kanban + task detail | 6 |
| `app/src/renderer/app/state.types.ts` / `room-loaders.ts` / `App.tsx` / `rooms-menu-items.ts` | register the `'missions'` room | 6 |

---

## Task 1: Schema + migration (missions / mission_tasks / mission_events)

**Files:**
- Create: `app/src/main/core/db/migrations/0039_missions.ts`
- Create: `app/src/main/core/db/migrations/0039_missions.test.ts`
- Modify: `app/src/main/core/db/schema.ts` (append the three drizzle tables + row types near `jorvisPaneEvents`, `schema.ts:563`)
- Modify: `app/src/main/core/db/migrate.ts` (import `mig0039`, append to the array — `migrate.ts:46,100`)

**Interfaces:**
- Produces: three tables. `missions(id TEXT PK, title TEXT NOT NULL, goal TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('local','telegram','external','autonomous')), client_label TEXT, workspace_id TEXT, status TEXT NOT NULL CHECK(status IN ('draft','active','paused','done','failed','cancelled')) DEFAULT 'draft', report TEXT, created_at INTEGER, updated_at INTEGER)`. `mission_tasks(id TEXT PK, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, title TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('backlog','dispatched','working','reviewing','needs_input','done','blocked')) DEFAULT 'backlog', assignee_session_id TEXT, worktree_path TEXT, attempt INTEGER NOT NULL DEFAULT 0, order_idx INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER)`. `mission_events(id TEXT PK, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, task_id TEXT, kind TEXT NOT NULL, body TEXT, ts INTEGER)`. Indexes: `mission_tasks(mission_id, status)`, `mission_tasks(assignee_session_id)`, `mission_events(mission_id, ts)`, `missions(status)`. `workspace_id` nullable = a global (workspace-less) mission.

- [ ] **Step 1: Write the failing migration test**

Create `0039_missions.test.ts` mirroring `0037_agent_sessions_closed_at.test.ts` (read it first for the exact harness — it opens an in-memory better-sqlite3, runs `up`, asserts columns/tables exist, and asserts idempotent re-run). If `0037`'s test uses a real `better-sqlite3` (it can, because migration tests run in the node/main vitest project that CAN load it — confirm by reading the top of `0037_agent_sessions_closed_at.test.ts`), do the same here.

```typescript
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { up } from './0039_missions';

function tables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
}
function cols(db: Database.Database, t: string): string[] {
  return (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);
}

describe('0039_missions', () => {
  it('creates the three mission tables with the expected columns', () => {
    const db = new Database(':memory:');
    up(db);
    const t = tables(db);
    expect(t).toEqual(expect.arrayContaining(['missions', 'mission_tasks', 'mission_events']));
    expect(cols(db, 'missions')).toEqual(expect.arrayContaining(['id', 'goal', 'origin', 'workspace_id', 'status', 'report']));
    expect(cols(db, 'mission_tasks')).toEqual(expect.arrayContaining(['mission_id', 'spec', 'status', 'assignee_session_id', 'worktree_path', 'attempt', 'order_idx']));
    expect(cols(db, 'mission_events')).toEqual(expect.arrayContaining(['mission_id', 'task_id', 'kind', 'body', 'ts']));
  });

  it('is idempotent (re-run is a no-op, no throw)', () => {
    const db = new Database(':memory:');
    up(db);
    expect(() => up(db)).not.toThrow();
  });

  it('CASCADE deletes tasks + events when a mission is dropped', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    up(db);
    db.prepare(`INSERT INTO missions (id,title,goal,origin,status,created_at,updated_at) VALUES ('m1','t','g','local','active',0,0)`).run();
    db.prepare(`INSERT INTO mission_tasks (id,mission_id,title,spec,status,attempt,order_idx,created_at,updated_at) VALUES ('t1','m1','tt','',​'backlog',0,0,0,0)`).run();
    db.prepare(`INSERT INTO mission_events (id,mission_id,task_id,kind,body,ts) VALUES ('e1','m1','t1','created',null,0)`).run();
    db.prepare(`DELETE FROM missions WHERE id='m1'`).run();
    expect(db.prepare(`SELECT count(*) c FROM mission_tasks`).get()).toMatchObject({ c: 0 });
    expect(db.prepare(`SELECT count(*) c FROM mission_events`).get()).toMatchObject({ c: 0 });
  });
});
```

> Note: the CASCADE test contains a zero-width char artifact risk — type the INSERT plainly; do NOT copy invisible characters. If `0037`'s test does NOT use real better-sqlite3, follow whatever harness it uses instead.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/db/migrations/0039_missions.test.ts`
Expected: FAIL — `./0039_missions` has no `up` export.

- [ ] **Step 3: Write the migration**

Create `0039_missions.ts` mirroring `0037`'s structure (the `hasColumn`/table-exists PRAGMA guard style, the H-7 no-txn comment). Use `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` so the whole `up` is idempotent without per-column guards:

```typescript
// 0039 — Mission board: missions / mission_tasks / mission_events.
//
// The data layer of the Jorvis Persistent Operator arc (Phase 20). A mission is
// a natural-language goal decomposed into ordered task cards; the autonomous
// supervisor loop that drives them is P1b. LOCAL-ONLY (per-machine operator
// state) — deliberately NOT added to the sync allowlist.
//
// H-7: the runner owns the transaction; this migration MUST NOT issue BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0039_missions';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('local','telegram','external','autonomous')),
      client_label TEXT,
      workspace_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','active','paused','done','failed','cancelled')),
      report TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK (status IN ('backlog','dispatched','working','reviewing','needs_input','done','blocked')),
      assignee_session_id TEXT,
      worktree_path TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      order_idx INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      task_id TEXT,
      kind TEXT NOT NULL,
      body TEXT,
      ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS mission_tasks_mission_status_idx ON mission_tasks (mission_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS mission_tasks_assignee_idx ON mission_tasks (assignee_session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS mission_events_mission_ts_idx ON mission_events (mission_id, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS missions_status_idx ON missions (status)`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/core/db/migrations/0039_missions.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Add drizzle table defs + register the migration**

In `schema.ts`, after `jorvisPaneEvents` (`:563-578`), add the three tables (mirror the DDL exactly — same columns, same CHECK enums as drizzle `enum` option, same indexes) and export their `$inferSelect`/`$inferInsert` row types:

```typescript
export const missions = sqliteTable(
  'missions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    goal: text('goal').notNull(),
    origin: text('origin', { enum: ['local', 'telegram', 'external', 'autonomous'] }).notNull(),
    clientLabel: text('client_label'),
    workspaceId: text('workspace_id'),
    status: text('status', { enum: ['draft', 'active', 'paused', 'done', 'failed', 'cancelled'] })
      .notNull()
      .default('draft'),
    report: text('report'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ missionsStatusIdx: index('missions_status_idx').on(t.status) }),
);

export const missionTasks = sqliteTable(
  'mission_tasks',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id').notNull(),
    title: text('title').notNull(),
    spec: text('spec').notNull().default(''),
    status: text('status', {
      enum: ['backlog', 'dispatched', 'working', 'reviewing', 'needs_input', 'done', 'blocked'],
    })
      .notNull()
      .default('backlog'),
    assigneeSessionId: text('assignee_session_id'),
    worktreePath: text('worktree_path'),
    attempt: integer('attempt').notNull().default(0),
    orderIdx: integer('order_idx').notNull().default(0),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    missionTasksMissionStatusIdx: index('mission_tasks_mission_status_idx').on(t.missionId, t.status),
    missionTasksAssigneeIdx: index('mission_tasks_assignee_idx').on(t.assigneeSessionId),
  }),
);

export const missionEvents = sqliteTable(
  'mission_events',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id').notNull(),
    taskId: text('task_id'),
    kind: text('kind').notNull(),
    body: text('body'),
    ts: integer('ts').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ missionEventsMissionTsIdx: index('mission_events_mission_ts_idx').on(t.missionId, t.ts) }),
);

export type MissionRow = typeof missions.$inferSelect;
export type MissionInsert = typeof missions.$inferInsert;
export type MissionTaskRow = typeof missionTasks.$inferSelect;
export type MissionTaskInsert = typeof missionTasks.$inferInsert;
export type MissionEventRow = typeof missionEvents.$inferSelect;
export type MissionEventInsert = typeof missionEvents.$inferInsert;
```

(Confirm `sql`, `index`, `integer`, `text`, `sqliteTable` are already imported at the top of `schema.ts` — they are, used by sibling tables.)

In `migrate.ts`: add `import * as mig0039 from './migrations/0039_missions';` next to the `mig0038` import (`:46`), and append `mig0039,` to the migrations array (after `mig0038,`, `:100`).

- [ ] **Step 6: Full assistant+db gate + commit**

Run: `npx vitest run src/main/core/db && npx tsc -b && npx eslint src/main/core/db/migrations/0039_missions.ts src/main/core/db/migrations/0039_missions.test.ts src/main/core/db/schema.ts src/main/core/db/migrate.ts`
Expected: PASS + clean.

```bash
git add src/main/core/db/migrations/0039_missions.ts src/main/core/db/migrations/0039_missions.test.ts src/main/core/db/schema.ts src/main/core/db/migrate.ts
git commit -m "feat(missions): schema + migration 0039 — missions/mission_tasks/mission_events (P1a)"
```

---

## Task 2: Types + pure state machine

**Files:**
- Modify: `app/src/shared/types.ts` (add mission types near `TaskStatus`, `:632`)
- Create: `app/src/main/core/missions/state.ts`
- Create: `app/src/main/core/missions/state.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `MissionStatus = 'draft'|'active'|'paused'|'done'|'failed'|'cancelled'`
  - `MissionTaskStatus = 'backlog'|'dispatched'|'working'|'reviewing'|'needs_input'|'done'|'blocked'`
  - `MissionOrigin = 'local'|'telegram'|'external'|'autonomous'`
  - `Mission`, `MissionTask`, `MissionEvent` interfaces (camelCase, cross-process).
  - `isLegalTaskTransition(from: MissionTaskStatus, to: MissionTaskStatus): boolean`
  - `rollupMissionStatus(taskStatuses: MissionTaskStatus[], current: MissionStatus): MissionStatus` — derives mission status from its tasks (empty → unchanged; any `blocked`/`needs_input` and none `working`/`dispatched` → stays `active` but flagged elsewhere; all terminal `done` → `done`; all terminal with ≥1 non-done-terminal is NOT auto-failed — a mission only fails/cancels explicitly). Keep the rollup CONSERVATIVE: it only ever promotes `active`→`done` when EVERY task is `done`; it never auto-fails or auto-pauses. Returns `current` unchanged in every other case.

- [ ] **Step 1: Write the failing state-machine test**

Create `state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isLegalTaskTransition, rollupMissionStatus } from './state';
import type { MissionTaskStatus } from '../../../shared/types';

describe('isLegalTaskTransition', () => {
  it('allows the forward lifecycle', () => {
    expect(isLegalTaskTransition('backlog', 'dispatched')).toBe(true);
    expect(isLegalTaskTransition('dispatched', 'working')).toBe(true);
    expect(isLegalTaskTransition('working', 'reviewing')).toBe(true);
    expect(isLegalTaskTransition('reviewing', 'done')).toBe(true);
    expect(isLegalTaskTransition('reviewing', 'working')).toBe(true); // advance re-prompt
    expect(isLegalTaskTransition('working', 'blocked')).toBe(true);
    expect(isLegalTaskTransition('working', 'needs_input')).toBe(true);
    expect(isLegalTaskTransition('needs_input', 'working')).toBe(true);
    expect(isLegalTaskTransition('blocked', 'dispatched')).toBe(true); // retry a blocked task
  });
  it('rejects illegal jumps', () => {
    expect(isLegalTaskTransition('backlog', 'done')).toBe(false);
    expect(isLegalTaskTransition('done', 'working')).toBe(false); // done is terminal
    expect(isLegalTaskTransition('backlog', 'reviewing')).toBe(false);
  });
  it('a status can stay itself (idempotent update)', () => {
    expect(isLegalTaskTransition('working', 'working')).toBe(true);
  });
});

describe('rollupMissionStatus', () => {
  it('promotes active → done only when every task is done', () => {
    expect(rollupMissionStatus(['done', 'done'], 'active')).toBe('done');
    expect(rollupMissionStatus(['done', 'working'], 'active')).toBe('active');
    expect(rollupMissionStatus(['done', 'blocked'], 'active')).toBe('active');
  });
  it('never auto-fails, auto-pauses, or touches a terminal mission', () => {
    expect(rollupMissionStatus(['blocked'], 'active')).toBe('active');
    expect(rollupMissionStatus([], 'active')).toBe('active');
    expect(rollupMissionStatus(['done'], 'cancelled')).toBe('cancelled');
    expect(rollupMissionStatus(['done'], 'failed')).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/missions/state.test.ts`
Expected: FAIL — `./state` not found.

- [ ] **Step 3: Add the types + implement the state machine**

In `shared/types.ts` after the `TaskComment` block (near `:632`), add:

```typescript
// ── Mission board (Jorvis Persistent Operator, Phase 20) ────────────────────
export type MissionOrigin = 'local' | 'telegram' | 'external' | 'autonomous';
export type MissionStatus = 'draft' | 'active' | 'paused' | 'done' | 'failed' | 'cancelled';
export type MissionTaskStatus =
  | 'backlog'
  | 'dispatched'
  | 'working'
  | 'reviewing'
  | 'needs_input'
  | 'done'
  | 'blocked';

export interface Mission {
  id: string;
  title: string;
  goal: string;
  origin: MissionOrigin;
  clientLabel: string | null;
  workspaceId: string | null;
  status: MissionStatus;
  report: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MissionTask {
  id: string;
  missionId: string;
  title: string;
  spec: string;
  status: MissionTaskStatus;
  assigneeSessionId: string | null;
  worktreePath: string | null;
  attempt: number;
  orderIdx: number;
  createdAt: number;
  updatedAt: number;
}

export interface MissionEvent {
  id: string;
  missionId: string;
  taskId: string | null;
  kind: string;
  body: string | null;
  ts: number;
}
```

Create `core/missions/state.ts`:

```typescript
// Pure lifecycle state machine for the mission board. No I/O, no DB — every
// legal transition + the mission-status rollup lives here so the DAO and the
// (P1b) supervisor share ONE source of truth and it is exhaustively testable.

import type { MissionStatus, MissionTaskStatus } from '../../../shared/types';

const TASK_TRANSITIONS: Record<MissionTaskStatus, MissionTaskStatus[]> = {
  backlog: ['dispatched'],
  dispatched: ['working', 'blocked', 'needs_input'],
  working: ['reviewing', 'blocked', 'needs_input', 'done'],
  reviewing: ['working', 'done', 'blocked', 'needs_input'],
  needs_input: ['working', 'dispatched', 'blocked'],
  blocked: ['dispatched', 'working'],
  done: [], // terminal
};

export function isLegalTaskTransition(from: MissionTaskStatus, to: MissionTaskStatus): boolean {
  if (from === to) return true; // idempotent update
  return TASK_TRANSITIONS[from].includes(to);
}

const TERMINAL_MISSION: MissionStatus[] = ['done', 'failed', 'cancelled'];

/**
 * Derive mission status from its task statuses. CONSERVATIVE: only ever
 * promotes an `active` mission to `done` when EVERY task is `done`. Never
 * auto-fails, auto-pauses, or touches an already-terminal mission — those are
 * explicit operator/supervisor decisions. Empty task list → unchanged.
 */
export function rollupMissionStatus(
  taskStatuses: MissionTaskStatus[],
  current: MissionStatus,
): MissionStatus {
  if (TERMINAL_MISSION.includes(current)) return current;
  if (current === 'active' && taskStatuses.length > 0 && taskStatuses.every((s) => s === 'done')) {
    return 'done';
  }
  return current;
}
```

- [ ] **Step 4: Run to verify it passes + commit**

Run: `npx vitest run src/main/core/missions/state.test.ts && npx tsc -b && npx eslint src/main/core/missions/state.ts src/main/core/missions/state.test.ts src/shared/types.ts`
Expected: PASS + clean.

```bash
git add src/shared/types.ts src/main/core/missions/state.ts src/main/core/missions/state.test.ts
git commit -m "feat(missions): mission types + pure lifecycle state machine (P1a)"
```

---

## Task 3: DAO

**Files:**
- Create: `app/src/main/core/missions/dao.ts`
- Create: `app/src/main/core/missions/dao.test.ts`

**Interfaces:**
- Consumes: `getDb` (`../db/client`), the drizzle tables (`../db/schema`), `isLegalTaskTransition`/`rollupMissionStatus` (`./state`), the types (`../../../shared/types`).
- Produces (all synchronous — better-sqlite3):
  - `createMission(input: { title: string; goal: string; origin: MissionOrigin; clientLabel?: string | null; workspaceId?: string | null }): Mission` (status `'draft'`, writes a `mission_events` `created` row).
  - `getMission(id: string): Mission | null`
  - `listMissions(filter?: { workspaceId?: string | null; status?: MissionStatus }): Mission[]` (most-recent `updatedAt` first).
  - `setMissionStatus(id: string, status: MissionStatus): void` (writes `updated_at` + a `status` event).
  - `setMissionReport(id: string, report: string): void`
  - `addTask(input: { missionId: string; title: string; spec?: string; orderIdx?: number }): MissionTask` (status `'backlog'`; `orderIdx` defaults to current max+1; writes a `task_created` event).
  - `getTask(id: string): MissionTask | null`
  - `listTasks(missionId: string): MissionTask[]` (by `orderIdx` asc).
  - `moveTask(id: string, to: MissionTaskStatus): MissionTask` — throws `Error('illegal transition: <from> → <to>')` if `!isLegalTaskTransition`; else updates status + `updated_at`, writes a `task_moved` event, and re-derives+persists the parent mission status via `rollupMissionStatus`. Returns the updated task.
  - `updateTask(id: string, patch: { title?: string; spec?: string; assigneeSessionId?: string | null; worktreePath?: string | null; attempt?: number; orderIdx?: number }): MissionTask`
  - `listEvents(missionId: string, limit?: number): MissionEvent[]` (most-recent `ts` first, default limit 200).
  - Internal `appendEvent(missionId, taskId, kind, body?)`.

- [ ] **Step 1: Write the failing DAO test**

Create `dao.test.ts` following the MockDb pattern from `controller.test.ts` / `conversations` tests (`vi.mock('../db/client', …)` + `createDbFake()` + `vi.mocked(getDb).mockReturnValue(...)`). Read `@/test-utils/db-fake` first to confirm it supports the `missions` tables (it fakes drizzle over the real schema — if it's schema-agnostic it works; if it enumerates tables, extend it minimally). Cover: create→get round-trip; addTask default orderIdx increments; moveTask legal path updates + emits an event; moveTask illegal path throws; rollup promotes the mission to `done` when the last task moves to `done`; listTasks order; listEvents recency.

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../db/client', () => ({ getDb: vi.fn(), getRawDb: vi.fn(), initializeDatabase: vi.fn(), closeDatabase: vi.fn() }));
import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as dao from './dao';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

describe('missions DAO', () => {
  it('creates and reads a mission', () => {
    const m = dao.createMission({ title: 'Ship X', goal: 'ship the X feature', origin: 'local' });
    expect(m.status).toBe('draft');
    expect(dao.getMission(m.id)?.goal).toBe('ship the X feature');
  });
  it('addTask auto-increments orderIdx and lists in order', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    const b = dao.addTask({ missionId: m.id, title: 'b' });
    expect(a.orderIdx).toBe(0);
    expect(b.orderIdx).toBe(1);
    expect(dao.listTasks(m.id).map((t) => t.title)).toEqual(['a', 'b']);
  });
  it('moveTask rejects an illegal transition', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    expect(() => dao.moveTask(a.id, 'done')).toThrowError(/illegal transition/);
  });
  it('rollup promotes the mission to done when its last task is done', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    dao.setMissionStatus(m.id, 'active');
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    dao.moveTask(a.id, 'dispatched');
    dao.moveTask(a.id, 'working');
    dao.moveTask(a.id, 'done');
    expect(dao.getMission(m.id)?.status).toBe('done');
  });
  it('records events (created, task_created, task_moved) newest-first', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    dao.moveTask(a.id, 'dispatched');
    const kinds = dao.listEvents(m.id).map((e) => e.kind);
    expect(kinds[0]).toBe('task_moved');
    expect(kinds).toContain('created');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/missions/dao.test.ts`
Expected: FAIL — `./dao` not found (or missing exports).

> If `createDbFake` cannot represent the mission tables, STOP and report — extending the fake is in scope but the reviewer must know it changed. Prefer the minimal extension (register the three tables the same way the fake registers `conversations`/`tasks`).

- [ ] **Step 3: Implement the DAO**

Create `dao.ts`. Keep it under ~500 lines; use `randomUUID` + `Date.now()`; map rows→camelCase interfaces via small `rowToMission`/`rowToTask`/`rowToEvent` helpers (mirror `conversations.ts`'s row-mapping style). `moveTask` calls `isLegalTaskTransition` (throw on false), updates, `appendEvent(missionId, id, 'task_moved', JSON.stringify({from,to}))`, then reads all sibling task statuses and `setMissionStatus(missionId, rollupMissionStatus(...))` only if it changed. `appendEvent` inserts a `mission_events` row. Full code follows the interface block above — write each function explicitly (no "similar to X").

- [ ] **Step 4: Run to verify it passes + commit**

Run: `npx vitest run src/main/core/missions && npx tsc -b && npx eslint src/main/core/missions`
Expected: PASS + clean.

```bash
git add src/main/core/missions/dao.ts src/main/core/missions/dao.test.ts
git commit -m "feat(missions): DAO — CRUD + state-machine-guarded moveTask + event log (P1a)"
```

---

## Task 4: Mission tools (board manipulation surface)

**Files:**
- Modify: `app/src/main/core/assistant/tools.ts` (add 5 schemas + 5 `T(...)` entries to `TOOLS`; add `missions` DAO to `ToolContext` if the handlers need it — they call the DAO module directly, so no ctx change needed, mirror how `create_task` uses `ctx.tasks`… actually the DAO is a module, import it directly)
- Modify: `app/src/main/core/assistant/tool-catalogue.ts` (add the 5 catalogue entries — name + JSON-schema, 1:1)
- Create: `app/src/main/core/assistant/tools.missions.test.ts`

**Interfaces:**
- Consumes: the DAO (`../missions/dao`), the `T()` helper (`tools.ts`), `findTool`.
- Produces 5 tools (added to `TOOLS` + `JORVIS_TOOL_CATALOGUE`):
  - `create_mission({ title, goal, workspaceId? })` → `{ missionId, status }`. Creates a `draft` mission. (Origin is `'local'` here — the telegram/external origins are set by their own callers in P3; in P1a chat-driven creation is always local.)
  - `add_mission_task({ missionId, title, spec? })` → `{ taskId, orderIdx }`.
  - `mission_board({ missionId? })` → if `missionId` given, `{ mission, tasks, events }`; else `{ missions }` (the list). The "look at the board" read.
  - `move_mission_task({ taskId, status })` → `{ taskId, status }` or a thrown error surfaced as a tool failure on an illegal transition.
  - `complete_mission({ missionId, report })` → sets status `done` + report → `{ ok: true }`.
- These are BOARD-DATA tools only — none launches a pane or wakes the model. `dispatch_task` (which launches a worktree pane) + the supervisor are P1b.

- [ ] **Step 1: Write the failing tool test**

Create `tools.missions.test.ts` mirroring `tools.missions`… follow `tools.test.ts`/`tools.arg-coercion.test.ts` harness (the same `vi.mock('../db/client')` + db-fake, `findTool('create_mission')!.handler(args, ctx)`). Assert: `create_mission` returns a missionId + persists a draft; `add_mission_task` appends; `mission_board` with no id lists missions, with an id returns `{mission,tasks,events}`; `move_mission_task` legal path returns the new status, illegal path → handler result `ok:false` (or throws — match how the existing tools surface a failure; check `read_pane`/`prompt_agent` error convention and mirror it); `complete_mission` sets done+report. Arg-coercion is already covered globally — don't re-test it here.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/assistant/tools.missions.test.ts`
Expected: FAIL — the tools aren't registered (`findTool('create_mission')` is undefined).

- [ ] **Step 3: Implement the 5 tools + catalogue entries**

In `tools.ts`, add the zod schemas (near the other `s*` schemas, `:225-313`):

```typescript
const sCreateMission = z.object({ title: z.string().min(1), goal: z.string().min(1), workspaceId: z.string().optional() });
const sAddMissionTask = z.object({ missionId: z.string().min(1), title: z.string().min(1), spec: z.string().optional() });
const sMissionBoard = z.object({ missionId: z.string().optional() });
const sMoveMissionTask = z.object({
  taskId: z.string().min(1),
  status: z.enum(['backlog', 'dispatched', 'working', 'reviewing', 'needs_input', 'done', 'blocked']),
});
const sCompleteMission = z.object({ missionId: z.string().min(1), report: z.string().min(1) });
```

Add 5 `T(...)` entries to the `TOOLS` array (mirror an existing entry's shape — `id`, human `name`, `description`, `inputSchema` JSON-schema object, the zod schema, the handler). Handlers import + call the DAO directly (`import * as missionsDao from '../missions/dao';`). `move_mission_task` wraps `missionsDao.moveTask` in try/catch and returns `{ ok: false, error: message }` on the illegal-transition throw, matching the tool-failure convention the other tools use (verify against `prompt_agent`'s liveness-guard error return). `mission_board` branches on `args.missionId`.

In `tool-catalogue.ts`, add the 5 matching catalogue entries (name + description + JSON-schema `inputSchema`, byte-parity with the `inputSchema` objects you passed to `T()` — the `tool-catalogue.test.ts` parity test enforces this 1:1). Follow an existing catalogue entry exactly.

- [ ] **Step 4: Run the tool + parity tests + commit**

Run: `npx vitest run src/main/core/assistant/tools.missions.test.ts src/main/core/assistant/tool-catalogue.test.ts && npx tsc -b && npx eslint src/main/core/assistant/tools.ts src/main/core/assistant/tool-catalogue.ts src/main/core/assistant/tools.missions.test.ts`
Expected: PASS (parity test proves catalogue↔tools agree) + clean.

```bash
git add src/main/core/assistant/tools.ts src/main/core/assistant/tool-catalogue.ts src/main/core/assistant/tools.missions.test.ts
git commit -m "feat(missions): 5 board-manipulation tools + catalogue parity (P1a)"
```

---

## Task 5: RPC surface (missions.list / get / events + missions:changed event)

**Files:**
- Modify (5 mirror sites): `app/src/shared/rpc-channels.ts`, `app/src/shared/router-shape.ts`, `app/src/main/rpc-router.ts`, `app/src/main/core/rpc/schemas.ts`, `app/src/shared/rpc-channels.test.ts`
- Modify: `app/src/shared/rpc-channels.ts` EVENTS + `rpc-channels.test.ts` event membership (for `missions:changed`)

**Interfaces:**
- Consumes: the DAO.
- Produces:
  - `missions.list({ workspaceId? })` → `Mission[]`
  - `missions.get({ missionId })` → `{ mission: Mission | null; tasks: MissionTask[]; events: MissionEvent[] }`
  - Event `missions:changed` → broadcast (no payload needed beyond a marker; renderer refetches) whenever a mission/task/event write happens. Wire the DAO to emit it: add an optional `onChanged?: () => void` the rpc-router injects, OR (simpler, matches `tasks:changed`) broadcast from the rpc-router mission handlers + the mission tools' controller path. Choose the `tasks:changed` pattern — read how `TasksManager` emits `tasks:changed` and mirror it: the DAO stays pure-DB, the emit happens at the controller/router boundary after each mutating tool call. Since mission tools run inside `invokeAssistantTool`, add a post-tool hook: if the tool id starts with a mission-mutating set, `broadcast('missions:changed', {})`. Simplest correct: broadcast in each mission tool handler via `ctx.emit?.('missions:changed', {})` (the tools already receive `ctx.emit`).

- [ ] **Step 1: Write the failing mirror/parity test expectation**

The `rpc-channels.test.ts` parity test will FAIL once you add the channels to CHANNELS but not to TYPED_ROUTER_CHANNELS (or vice-versa). Add the three channels to `TYPED_ROUTER_CHANNELS` and `missions:changed` to the events membership list FIRST, run the test, watch it fail (channels not yet in CHANNELS), then add them to CHANNELS to make it pass. (This is the TDD loop the parity test gives you for free.)

Run: `npx vitest run src/shared/rpc-channels.test.ts`
Expected: FAIL — `missions.list/get/events` in TYPED_ROUTER_CHANNELS but not CHANNELS.

- [ ] **Step 2: Wire all 5 mirror sites + the event**

1. `shared/rpc-channels.ts` CHANNELS — add `'missions.list'`, `'missions.get'`, `'missions.events'` in a new `// Mission board (Phase 20)` block. Add `'missions:changed'` to EVENTS.
2. `shared/router-shape.ts` AppRouter — add a `missions:` block: `list(input: { workspaceId?: string }): Promise<Mission[]>`, `get(input: { missionId: string }): Promise<{ mission: Mission | null; tasks: MissionTask[]; events: MissionEvent[] }>`, `events(input: { missionId: string; limit?: number }): Promise<MissionEvent[]>`. Import the mission types.
3. `main/rpc-router.ts` — build a `missions` controller object (`{ list, get, events }`) calling the DAO, pass it into the router registration next to the `assistant` controller. Confirm the generic `registerRouter` picks it up (it iterates `Object.entries` — same as Task 4 of P0 verified for `assistant.newSession`).
4. `main/core/rpc/schemas.ts` — add zod input entries: `'missions.list': z.object({ workspaceId: z.string().max(200).optional() })`, `'missions.get': z.object({ missionId: z.string().min(1).max(200) })`, `'missions.events': z.object({ missionId: z.string().min(1).max(200), limit: z.number().int().positive().max(1000).optional() })`.
5. `shared/rpc-channels.test.ts` — add the three to `TYPED_ROUTER_CHANNELS`; add `'missions:changed'` to the events list the membership test checks.

Then make the mission tools emit: in each mutating mission tool handler (`create_mission`, `add_mission_task`, `move_mission_task`, `complete_mission`), after the DAO write, call `ctx.emit?.('missions:changed', {})`.

- [ ] **Step 3: Run parity + a live-ish handler test**

Run: `npx vitest run src/shared/rpc-channels.test.ts src/main/core/assistant`
Expected: PASS (parity green = all mirrors agree).

- [ ] **Step 4: tsc + eslint + commit**

Run: `npx tsc -b && npx eslint src/shared/rpc-channels.ts src/shared/router-shape.ts src/main/rpc-router.ts src/main/core/rpc/schemas.ts src/shared/rpc-channels.test.ts src/main/core/assistant/tools.ts`
Expected: clean.

```bash
git add src/shared/rpc-channels.ts src/shared/router-shape.ts src/main/rpc-router.ts src/main/core/rpc/schemas.ts src/shared/rpc-channels.test.ts src/main/core/assistant/tools.ts src/main/core/assistant/tool-catalogue.ts
git commit -m "feat(missions): missions.* RPC (list/get/events) + missions:changed event (P1a)"
```

---

## Task 6: Missions room (renderer)

**Files:**
- Create: `app/src/renderer/features/missions/MissionsRoom.tsx`, `MissionList.tsx`, `MissionBoard.tsx` (kanban columns by task status), `MissionTaskCard.tsx`, `MissionDetail.tsx` (linked pane, worktree, event timeline, report), `use-missions.ts` (hook: list + active mission + `missions:changed` subscription + refetch)
- Modify: `app/src/renderer/app/state.types.ts` (add `'missions'` to `RoomId`), `app/src/renderer/app/room-loaders.ts` (lazy-load), `app/src/renderer/app/App.tsx` (render in the RoomSwitch), `app/src/renderer/features/top-bar/rooms-menu-items.ts` (menu entry)
- Test: `app/src/renderer/features/missions/use-missions.test.ts` + `MissionBoard.test.tsx` (renderer vitest: jsdom docblock + `vi.hoisted` mocks + `afterEach(cleanup)`, per the renderer test convention)

**Interfaces:**
- Consumes: `missions.list`/`missions.get` RPC, `missions:changed` event (`onEvent`).
- Produces: a routable `'missions'` room. Read-only display in P1a (the operator watches Jorvis build the board via chat; no manual drag/edit UI yet — that's optional P1b polish). Columns are the 7 task statuses; a mission-list rail on the left; clicking a mission loads its board + detail.

- [ ] **Step 1: Write the failing hook test**

Create `use-missions.test.ts` (jsdom). Mock `rpc.missions.list`/`get` + `onEvent`. Assert: on mount it fetches the list; a `missions:changed` event triggers a refetch; picking a mission id fetches its board. Follow `use-jorvis-conversations.test.ts`'s hydrate-token pattern for the "last pick wins" guard (missions can be picked fast — reuse the monotonic-token discipline).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/features/missions/use-missions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook + components + register the room**

Build `use-missions.ts` (list state, active mission id, hydrate-token guard, `missions:changed` subscription → refetch). Build the components (kanban columns keyed by the 7 `MissionTaskStatus` values; `MissionTaskCard` shows title + status dot + linked pane name if `assigneeSessionId`; `MissionDetail` shows the event timeline + report). Register the room: add `'missions'` to `RoomId` (`state.types.ts:23`), a lazy loader (`room-loaders.ts`, mirror the `jorvis` entry), a `RoomSwitch` case in `App.tsx` (mirror `jorvis`, wrapped in Suspense+ErrorBoundary), and a `rooms-menu-items.ts` entry (icon: a `ListChecks`/`Kanban` lucide icon).

- [ ] **Step 4: Run the renderer tests + full gate + commit**

Run: `npx vitest run src/renderer/features/missions && npx tsc -b && npx eslint src/renderer/features/missions src/renderer/app/state.types.ts src/renderer/app/room-loaders.ts src/renderer/app/App.tsx src/renderer/features/top-bar/rooms-menu-items.ts`
Expected: PASS + clean.

```bash
git add src/renderer/features/missions src/renderer/app/state.types.ts src/renderer/app/room-loaders.ts src/renderer/app/App.tsx src/renderer/features/top-bar/rooms-menu-items.ts
git commit -m "feat(missions): Missions room — list + kanban + detail/timeline (P1a)"
```

---

## Task 7: Full gate + phase-slice verification

- [ ] **Step 1: Full local gate**

Run from `app/`:
```bash
npx tsc -b && npx vitest run && npx eslint . && npm run build
```
Expected: all green, eslint 0 warnings. (Re-run the full vitest once if a single unrelated under-load flake appears — known class.)

- [ ] **Step 2: Manual smoke (operator, documented — needs the app + a real claude turn)**

1. Open the new **Missions** room → empty state renders.
2. In Jorvis chat: "create a mission to add a footer to the landing page, break it into 3 tasks" → Jorvis calls `create_mission` + 3× `add_mission_task` → the Missions room populates live (via `missions:changed`), 3 cards in `backlog`.
3. Ask Jorvis to "move task 1 to working" → the card moves columns live; ask to complete the mission → status flips to `done`, report shows in the detail pane.
4. Confirm an illegal move ("move a backlog task straight to done") returns a legible tool error in chat, not a crash.

- [ ] **Step 3: Definition-of-done check (P1a slice)**

Jorvis can create a mission, decompose it into ordered task cards, move them through the legal lifecycle, and write a report — all through audited tools — and the operator watches it live in the Missions room. NO autonomy yet (that's P1b: `dispatch_task` launches panes, the supervisor loop drives the board, the wake scheduler + stub-CLI e2e). The board data model + tools + RPC + room are the foundation P1b builds on.

---

## Self-Review notes (author)

- **Spec §6 coverage (P1a slice):** P1.1 schema → Task 1; P1.2 state machine → Task 2; P1.3 mission tools → Task 4 (board-data subset; `dispatch_task` deferred to P1b by the plan's stated split); P1.5 Missions room → Task 6. **P1.4 supervisor loop + the scheduler + the stub-CLI e2e are DEFERRED to the P1b plan** — called out explicitly at the top and in Task 7 Step 3, not a silent gap.
- **The `create_task`/TasksManager bridge decision (spec §6 P1.5 "decide at plan time"):** RESOLVED — keep missions a separate bounded context; the existing human `tasks` kanban is untouched; `create_task` unchanged. Documented in Global Constraints.
- **Grep-at-execution unknowns (flagged, not placeholders):** whether `@/test-utils/db-fake` needs a minimal extension for the mission tables (Task 3 Step 2 says STOP+report if so); the exact tool-failure return convention (`{ok:false,error}` vs throw) to mirror (Task 4 Step 3 says verify against `prompt_agent`); whether `0037`'s migration test uses real better-sqlite3 (Task 1 Step 1 says match it). Each names the sibling to read.
- **Type consistency:** `MissionTaskStatus` (7 values) is defined once in Task 2 (`shared/types.ts`) and reused verbatim in the DAO (Task 3), the `move_mission_task` zod enum (Task 4), and the kanban columns (Task 6). `moveTask` throws `illegal transition: <from> → <to>` (Task 3) and the tool catches it (Task 4). `missions:changed` is the event name in Tasks 5 + 6.
