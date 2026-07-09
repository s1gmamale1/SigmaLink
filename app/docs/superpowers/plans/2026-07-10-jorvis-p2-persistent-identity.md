# Jorvis P2 — Persistent Identity Implementation Plan (Phase 21)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jorvis remembers across sessions and projects (durable FTS memory + postmortems), operates under the operator's Sigma-Profile charter as its base persona, spans all workspaces via a global operator scope, and can propose self-amendments that only take effect behind operator approval.

**Architecture:** One migration (memory + FTS5 + amendments tables + KV seeds), a memory DAO + 4 tools riding the established catalogue-parity trio, a vendored Sigma-Profile charter render loaded by a pure charter module, system-prompt v2 (charter persona + portfolio for global turns), KV-durable conversation pinning (kills the in-memory mission→conversation map), a wake-time context assembler spliced into the supervisor's directives, a third `postmortem` wake kind, and an amendments store + approval RPC + minimal renderer panel. Everything model-facing rides the existing `assistant.send` / tool layer — zero new model-spawning paths.

**Tech Stack:** TypeScript (erasableSyntaxOnly), drizzle + better-sqlite3 raw SQL for FTS5, vitest + `@/test-utils/db-fake` + RecordingDb migration tests, zod tool schemas, React renderer (jsdom tests).

## Global Constraints

- Branch: `feat/jorvis-p2-persistent-identity`, based on the P1c branch tip (stacked; rebase onto main when #225/P1c merge).
- TypeScript erasableSyntaxOnly: NO enums, NO namespaces, NO constructor parameter properties.
- NEVER `new Database()` in vitest (Electron ABI) — drizzle-shaped tests use `@/test-utils/db-fake`; raw-SQL DAOs get SQL-shape tests against a recording fake; migrations get RecordingDb tests (mirror `0040_missions_autonomy_kv.test.ts`).
- Tool changes touch ALL of: `tool-catalogue.ts` (pure data) + `tools.ts` (zod + handler) + `system-prompt.ts` TOOL_BLURB + `authz-external.ts` classification. The parity test (`tool-catalogue.test.ts`) enforces the first three; check it for any hardcoded tool-count assertion and bump if present.
- New RPC channels touch ALL 4 mirror sites: `shared/router-shape.ts` + `rpc-router.ts` + `shared/rpc-channels.ts` CHANNELS (+EVENTS if new event) + `shared/rpc-channels.test.ts` — missing the allowlist means the preload silently rejects.
- New tables must be registered wherever the P1a mission tables were registered in the sync engine (`core/sync/engine.ts` + `core/sync/dirty-tracker.ts`) — grep `mission_events` in `src/main/core/sync/` and mirror exactly.
- Migration number 0041 assumed next — verify `ls src/main/core/db/migrations/ | tail -1` is 0040 at execution time; renumber if something landed meanwhile. Migrations NEVER issue BEGIN/COMMIT (the runner owns the transaction, H-7).
- Keep files ≤~500 lines; split rather than bloat.
- NEVER push, tag, or merge. Commits stay local to the branch.
- The Sigma-Profile cross-repo change (Task 4a) is done by the LEAD, not a worker agent.

## Design decisions (locked)

- **D1 Global scope = KV-marked, not schema-typed (ADR-008 pattern).** `conversations.workspaceId` stays NOT NULL (no FK, sentinel strings are safe rows). A shared exported constant `JORVIS_GLOBAL_WORKSPACE_ID = 'jorvis-missions-global'` replaces the two hand-duplicated literals. THE global operator conversation is pinned by KV `jorvis.operator.conversationId`; mission conversations are pinned by KV `jorvis.mission.conversation.<missionId>` (kills the restart-lossy in-memory map).
- **D2 Charter = vendored generated TS module.** Sigma-Profile gains a `jorvis` target (same `system-prompt` format as hermes, `out: dist/jorvis`); SigmaLink vendors the render via `scripts/sync-jorvis-charter.cjs` → `src/main/core/operator/charter-default.ts` (JSON.stringify-wrapped string export — no runtime file resolution, no packaging changes, esbuild inlines it). KV `jorvis.charter.path` overrides with a file read (fail-soft to bundled).
- **D3 Charter is default-ON** (prompt-surface change, reversible, not a safety gate). Autonomy (`missions.autonomy.enabled`) remains the only safety gate.
- **D4 Memory recall auto-injection happens on WAKES only** (supervisor directives via context.ts); interactive chat uses the `recall` tool on demand. Char-cap constants (MAX_EXCERPT_CHARS pattern), not KV.
- **D5 All four memory tools + propose_amendment → `EXTERNAL_ESCALATE_TOOLS`** (operator-private memory; conservative for recall too). None are DANGEROUS_REMOTE — autonomous/telegram wakes use memory freely; proposals are inert until approved.
- **D6 Amendments append AFTER the charter** at prompt-build time, never edit it. Telegram `/approve` is P3; P2 ships store + tool + app RPC + minimal renderer panel.

---

### Task 1: Migration 0041 — jorvis_memory + FTS5 + jorvis_amendments + KV seeds

**Files:**
- Create: `src/main/core/db/migrations/0041_jorvis_identity.ts`
- Create: `src/main/core/db/migrations/0041_jorvis_identity.test.ts`
- Modify: `src/main/core/db/schema.ts` (drizzle table defs)
- Modify: `src/main/shared/types.ts` (JorvisMemory/JorvisAmendment types)
- Modify: sync-engine registration sites (grep `mission_events` under `src/main/core/sync/` and mirror for the two new tables)

**Interfaces:**
- Produces (types, `shared/types.ts`):

```typescript
export type JorvisMemoryKind = 'fact' | 'playbook' | 'preference' | 'postmortem';
export interface JorvisMemory {
  id: string;
  kind: JorvisMemoryKind;
  title: string;
  body: string;
  tags: string[]; // stored as JSON text
  workspaceId: string | null;
  confidence: number; // 0..1
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}
export type JorvisAmendmentStatus = 'proposed' | 'approved' | 'denied';
export interface JorvisAmendment {
  id: string;
  text: string;
  rationale: string | null;
  status: JorvisAmendmentStatus;
  decisionReason: string | null;
  proposedAt: number;
  decidedAt: number | null;
}
```

- Produces (drizzle, `schema.ts` — mirror the missions tables' style exactly): `jorvisMemory` (table `jorvis_memory`), `jorvisAmendments` (table `jorvis_amendments`).

- [ ] **Step 1: Write the failing migration test** — mirror `0041`'s neighbours: RecordingDb asserting (a) CREATE TABLE jorvis_memory with all columns, (b) CREATE VIRTUAL TABLE jorvis_memory_fts USING fts5 with `content='jorvis_memory'`, (c) the three FTS sync triggers + the one-time `('rebuild')` insert, (d) CREATE TABLE jorvis_amendments, (e) indexes `(kind)`, `(workspace_id)` on memory and `(status)` on amendments, (f) KV seeds `INSERT OR IGNORE` for `jorvis.charter.path=''`. Read `0031_memory_fts5.ts` and `0040_missions_autonomy_kv.ts` FIRST and clone their statement shapes/test style.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/core/db/migrations/0041_jorvis_identity.test.ts` → module not found.
- [ ] **Step 3: Implement the migration** — tables:

```sql
CREATE TABLE IF NOT EXISTS jorvis_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS jorvis_memory_kind_idx ON jorvis_memory(kind);
CREATE INDEX IF NOT EXISTS jorvis_memory_ws_idx ON jorvis_memory(workspace_id);
-- FTS5 external-content + triggers + rebuild: clone 0031_memory_fts5.ts verbatim,
-- substituting table jorvis_memory and columns (title, body).
CREATE TABLE IF NOT EXISTS jorvis_amendments (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  decision_reason TEXT,
  proposed_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS jorvis_amendments_status_idx ON jorvis_amendments(status);
```

KV seeds (0040 DEFAULTS-array idiom): `jorvis.charter.path` = `''`.
- [ ] **Step 4: schema.ts + types.ts + sync-engine registration** — add drizzle defs + the two types; register both tables exactly where `mission_events`/`missions` are registered in `core/sync/`.
- [ ] **Step 5: Full migration-dir + sync tests green** — `npx vitest run src/main/core/db src/main/core/sync`.
- [ ] **Step 6: Commit** — `feat(jorvis): migration 0041 — jorvis_memory (FTS5) + jorvis_amendments + charter KV (P2 T1)`

---

### Task 2: Memory DAO — `core/operator/memory.ts`

**Files:**
- Create: `src/main/core/operator/memory.ts`
- Create: `src/main/core/operator/memory.test.ts`

**Interfaces:**
- Consumes: `getDb()`/`getRawDb()` from `../db/client`, drizzle `jorvisMemory` from Task 1.
- Produces:

```typescript
export function rememberMemory(input: {
  kind: JorvisMemoryKind; title: string; body: string;
  tags?: string[]; workspaceId?: string | null; confidence?: number;
}): JorvisMemory;
export function recallMemories(input: {
  query: string; k?: number; kind?: JorvisMemoryKind; workspaceId?: string | null;
}): JorvisMemory[];               // FTS5 MATCH + bm25() rank; touches last_used_at on hits
export function updateMemory(id: string, patch: {
  title?: string; body?: string; tags?: string[]; confidence?: number;
}): JorvisMemory;
export function forgetMemory(id: string): void;   // hard delete; FTS triggers clean the index
export function listMemories(filter?: { kind?: JorvisMemoryKind; limit?: number }): JorvisMemory[];
```

- [ ] **Step 1: Failing tests.** CRUD paths on `createDbFake()` (drizzle ops, mirror `missions/dao` tests). `recallMemories` is raw SQL — test it as an SQL-shape test: mock `getRawDb` with a recording `prepare()` fake and assert the query contains `jorvis_memory_fts`, `MATCH`, `bm25(`, `LIMIT`, and that the FTS query string is passed as a bound parameter (never interpolated). Sanitize the user query for FTS syntax: wrap each whitespace-token in double quotes (`"a" "b"`) so `-`/`:` in queries can't crash MATCH — test a query containing `feat: x-y` produces quoted tokens. Also test: recall failure (prepare throws) returns `[]` (fail-soft, never throws).
- [ ] **Step 2: Verify fail → implement.** `recallMemories` shape:

```typescript
const sql = `
  SELECT m.* FROM jorvis_memory m
  JOIN jorvis_memory_fts f ON f.rowid = m.rowid
  WHERE jorvis_memory_fts MATCH ?
  ${kind ? 'AND m.kind = ?' : ''}
  ORDER BY bm25(jorvis_memory_fts) LIMIT ?`;
```

wrapped in try/catch → `[]`. Touch `last_used_at` for returned ids in one UPDATE…IN(…).
- [ ] **Step 3: Green + commit** — `feat(jorvis): memory DAO — FTS recall + CRUD (P2 T2)`

---

### Task 3: Memory tools — remember / recall / update_memory / forget

**Files:**
- Modify: `src/main/core/assistant/tool-catalogue.ts` (4 entries)
- Modify: `src/main/core/assistant/tools.ts` (4 zod schemas + 4 `T(...)` handlers calling the Task-2 DAO)
- Modify: `src/main/core/assistant/system-prompt.ts` (TOOL_BLURB lines)
- Modify: `src/main/core/assistant/authz-external.ts` (all 4 → `EXTERNAL_ESCALATE_TOOLS`, with a "operator-private memory" comment)
- Modify/extend: the assistant tools test file that covers mission tools (mirror its harness)

**Interfaces:**
- `remember({kind, title, body, tags?, workspaceId?})` → `{memoryId}`; `recall({query, k?, kind?})` → `{memories: JorvisMemory[]}`; `update_memory({memoryId, title?, body?, tags?, confidence?})` → `{ok: true}`; `forget({memoryId})` → `{ok: true}`.
- zod: `kind: z.enum(['fact','playbook','preference','postmortem'])`, `k: z.number().int().min(1).max(20).optional()`.

- [ ] Steps: failing tool tests (happy path + recall passes k through + forget of unknown id throws) → implement 4 tools → `npx vitest run src/main/core/assistant/tool-catalogue.test.ts <tools test file>` green (parity across all three surfaces + authz classification asserted in `authz-external`'s own test — extend it: the 4 new names classify `escalate` for external, absent from DANGEROUS_REMOTE) → commit `feat(jorvis): memory tools — remember/recall/update_memory/forget (P2 T3)`.

---

### Task 4: Charter — sync script + vendored default + loader (+ cross-repo target, LEAD-only)

**(4a — LEAD, cross-repo, NOT the worker):** in `/Users/aisigma/projects/Sigma-Profile`: add `"jorvis": { "format": "system-prompt", "out": "dist/jorvis" }` to `core/targets.json` targets; `node build/render.mjs`; `node build/render.mjs --check` green; commit targets.json + `dist/jorvis/**` on branch `feat/jorvis-target`. NEVER push.

**Files (worker, SigmaLink):**
- Create: `scripts/sync-jorvis-charter.cjs`
- Create: `src/main/core/operator/charter-default.ts` (GENERATED — run the script once)
- Create: `src/main/core/operator/charter.ts`
- Create: `src/main/core/operator/charter.test.ts`

**Interfaces:**

```typescript
// charter-default.ts (generated)
export const JORVIS_CHARTER_DEFAULT: string; // full rendered system-prompt.md text

// charter.ts (pure, DI'd)
export function loadJorvisCharter(deps: {
  kvGet: (key: string) => string | null;
  readFile?: (path: string) => string; // DI seam; default fs.readFileSync utf8
}): string; // KV 'jorvis.charter.path' non-empty → read file, fail-soft to bundled; else bundled
export function appendApprovedAmendments(charter: string, amendments: JorvisAmendment[]): string;
// approved-only, appended under '\n\n## Approved amendments (operator-signed)\n', each as '- <text>'
```

- [ ] **sync script:** reads `/Users/aisigma/projects/Sigma-Profile/dist/jorvis/system-prompt.md` (arg-overridable path), writes charter-default.ts as `// GENERATED by scripts/sync-jorvis-charter.cjs — DO NOT hand-edit; re-run the script.\nexport const JORVIS_CHARTER_DEFAULT: string = ${JSON.stringify(content)};\n`. Errors loudly if source missing.
- [ ] **tests:** bundled default non-empty + contains a stable charter marker (grep the render for one, e.g. `Verify before trust` — confirm against the actual render); KV path set + readFile succeeds → file content; readFile throws → bundled fallback; amendments append only `approved`, preserves order, empty list → charter unchanged.
- [ ] Green → commit `feat(jorvis): Sigma-Profile charter — vendored render + loader + amendment append (P2 T4)`.

---

### Task 5: System prompt v2 — charter persona · portfolio · durable global conversation

**Files:**
- Create: `src/main/core/operator/global.ts` (the shared sentinel + KV keys)
- Modify: `src/main/core/assistant/system-prompt.ts`
- Modify: `src/main/core/assistant/runClaudeCliTurn.args.ts`
- Modify: `src/main/core/operator/supervisor.ts` (KV-durable conversation map; import sentinel)
- Modify: `src/main/rpc-router.ts` (pass kv deps; replace duplicated literal)
- Tests: `system-prompt.test.ts` / args tests / `supervisor.test.ts` extensions

**Interfaces:**

```typescript
// global.ts
export const JORVIS_GLOBAL_WORKSPACE_ID = 'jorvis-missions-global'; // value MUST stay identical (existing rows)
export const KV_OPERATOR_CONVERSATION = 'jorvis.operator.conversationId';
export const KV_MISSION_CONVERSATION_PREFIX = 'jorvis.mission.conversation.';

// system-prompt.ts — context grows (all optional, backward-compatible):
export interface JorvisSystemPromptContext {
  workspaceName: string; workspaceRoot: string;
  charter?: string;                       // replaces the inline persona paragraph when present
  portfolio?: Array<{ name: string; root: string }>; // global turns: replaces the single-workspace block
  amendments?: JorvisAmendment[];         // appended via appendApprovedAmendments
}

// supervisor.ts — SupervisorDeps grows:
kvGet: (key: string) => string | null;
kvSet: (key: string, value: string) => void;
```

- [ ] **system-prompt.ts:** when `charter` present → persona paragraph = charter text (TOOL_BLURB + STYLE_RULES retained after it); when `portfolio` present → workspace block lists every `name — root` under a "Portfolio (all workspaces)" heading. Tests: charter text present + old inline persona absent; portfolio renders all entries; legacy call (no new fields) byte-identical to today's output (pin with a snapshot-style assertion).
- [ ] **args.ts:** `defaultSystemPromptForWorkspace` — when `workspaceId === JORVIS_GLOBAL_WORKSPACE_ID`, list all workspaces (drizzle) → portfolio; else single workspace as today. BOTH paths load charter via `loadJorvisCharter({kvGet})` + `listAmendments('approved')`, fail-soft (try/catch → undefined charter → legacy persona). kvGet here = raw-SQL read of the kv table (mirror `allowedReadRoots`'s inline kv read in tools.ts).
- [ ] **supervisor.ts:** `ensureMissionConversation` — in-memory map → check `kvGet(PREFIX + missionId)` (verify the conversation row still exists via `getConversation`) → create + `kvSet` + cache. Test: a SECOND `createSupervisor` instance (fresh map, same fake KV) reuses the first's conversation id — restart durability.
- [ ] **rpc-router.ts:** pass `kvGet: controlKv.get, kvSet: controlKv.set` into `createSupervisor`; replace the duplicated `'jorvis-missions-global'` literal with the import.
- [ ] Full assistant + operator suites green → commit `feat(jorvis): charter persona + portfolio prompt + KV-durable global/mission conversations (P2 T5)`.

---

### Task 6: context.ts — wake-time assembly under a char budget

**Files:**
- Create: `src/main/core/operator/context.ts` + `context.test.ts`
- Modify: `src/main/core/operator/directive.ts` (optional trailing `extraContext?: string` param on both builders, appended verbatim after a blank line)
- Modify: `src/main/core/operator/supervisor.ts` (recall + assemble before building directives)

**Interfaces:**

```typescript
// context.ts (pure)
export const MAX_MEMORY_CONTEXT_CHARS = 3000;
export function buildMemoryContext(memories: JorvisMemory[]): string;
// '## Operator memory\n- [kind] title: body' lines, hard-capped at MAX_MEMORY_CONTEXT_CHARS
// (truncate whole entries, never mid-line; empty input → '')
```

- [ ] **supervisor:** both `runDecompose` and `runReview` do `let extra = ''; try { extra = buildMemoryContext(recallMemories({ query: <mission.title + ' ' + mission.goal (+ task.title + task.spec for review)>, k: 5 })); } catch { extra = ''; }` → pass to the directive builder. A broken recall must NEVER kill a wake (test: recallMemories throws → runTurn still called, directive has no memory block).
- [ ] Tests: cap enforced on oversized memories; entry-boundary truncation; directive builders append the block only when non-empty.
- [ ] Green → commit `feat(jorvis): wake-time memory context assembly (P2 T6)`.

---

### Task 7: Postmortem wake kind — the learning loop

**Files:**
- Modify: `src/main/core/operator/scheduler.ts` (`WakeKind` union gains `'postmortem'`)
- Modify: `src/main/core/operator/directive.ts` (`buildPostmortemDirective(mission, tasks)`)
- Modify: `src/main/core/operator/supervisor.ts` (`runPostmortem`; `SupervisorDeps` gains `enqueue?: (kind, missionId) => void`)
- Modify: `src/main/rpc-router.ts` (complete_mission tool-trace → `missionScheduler?.enqueue('postmortem', missionId)`, mirroring the create_mission hook; supervisor's `enqueue` dep late-bound as `(k, m) => missionScheduler?.enqueue(k, m)`)
- Modify: `src/main/core/operator/__e2e__/mission-loop.e2e.test.ts` (extend the happy-path drive: after complete_mission, a postmortem wake fires and the scripted brain writes a postmortem via the DAO)

**Interfaces:**

```typescript
export function buildPostmortemDirective(mission: Mission, tasks: MissionTask[]): string;
// mission title/goal/report + per-task one-liners (title · status · attempt), then:
// 'Write ONE postmortem memory: call remember(kind: "postmortem", title: "<mission title>", body: what worked / what failed / what to do differently next time). Then stop — do not call any other tool.'
```

- [ ] **supervisor:** `runPostmortem(wake)` — load mission (+tasks), build directive, `runTurn`. On the MAX_ATTEMPTS block path, after appending `task_max_attempts`, call `deps.enqueue?.('postmortem', task.missionId)` (blocker postmortems). Budget/gates apply automatically (it's a normal wake).
- [ ] Tests: directive content; supervisor routes `kind:'postmortem'`; MAX_ATTEMPTS path enqueues; e2e proves one extra scripted turn writes a `jorvis_memory` row (assert via DAO list).
- [ ] Green → commit `feat(jorvis): postmortem wake — missions distill into durable memory (P2 T7)`.

---

### Task 8: Amendments — store · propose_amendment tool · approval RPC · renderer panel

**Files:**
- Create: `src/main/core/operator/amendments.ts` + `amendments.test.ts` (DAO: `proposeAmendment({text, rationale?})`, `listAmendments(status?)`, `decideAmendment(id, approved: boolean, reason?)` — decide is idempotent-guarded: only `proposed` rows can be decided, else throw)
- Modify: the tool trio + authz for `propose_amendment` (external → escalate; NOT dangerous; emits `ctx.emit?.('jorvis:amendments-changed', {})`)
- Modify: 4 RPC mirror sites for `jorvis.amendmentsList` / `jorvis.amendmentsDecide` (+ `jorvis:amendments-changed` in EVENTS)
- Create: renderer `AmendmentsPanel` inside the Missions room (list proposed with text+rationale, Approve/Deny buttons → `jorvis.amendmentsDecide`; badge count; re-fetch on the changed event) + jsdom test (vi.hoisted mocks, afterEach cleanup, query by role)
- Modify: `runClaudeCliTurn.args.ts` already appends approved amendments (Task 5) — extend its test to prove a newly-approved amendment shows up in the NEXT turn's prompt.

- [ ] Steps: DAO tests → DAO → tool (trio + authz + parity) → RPC (all 4 mirrors + schemas in `core/rpc/schemas.ts` if that's where sibling channels validate — grep `missions.list`'s schema entry and mirror) → renderer panel + test → prompt-append proof → full gate: `npx tsc -b && npx vitest run && npx eslint . --max-warnings 0 && npm run build`.
- [ ] Commit — `feat(jorvis): self-amendments behind operator approval — store, tool, RPC, panel (P2 T8)`.

---

## Branch-final gate (LEAD)

1. Full local gate in the MAIN tree: `npx tsc -b && npx vitest run && npx eslint . --max-warnings 0 && npm run build`.
2. Opus whole-branch review (correctness · tests · safety · consistency · readability · scope, ≥85 each).
3. sigma-check on the PR; classifier-gated merge stays with the operator.

## Exit criteria (from ROADMAP Phase 21, restated)

- App restart → Jorvis recalls a fact + a playbook from before (KV-durable conversations + FTS memory).
- A repeated mission demonstrably consults the prior postmortem (context.ts injection visible in the wake directive).
- Persona verifiably = the Sigma-Profile render (charter marker present in a real turn's `--append-system-prompt`).
- An amendment takes effect only after approval and is auditable (proposed→approved flow + prompt-append test).
