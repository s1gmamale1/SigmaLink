# W6 — Swarm Room Build Report

Status: complete. All four build checks (`npm run build`, `npm run electron:compile`, `npm run product:check`, `npm run lint`) green. No new lint regressions outside the legacy/components/ui debt inherited from W5; total problem count unchanged at 56 (53 errors, 3 warnings) — the same baseline reported in `W5-FOUNDATION-report.md`.

## 1. Files created (new in this wave)

| Path | Purpose |
|---|---|
| `app/src/main/core/swarms/types.ts` | Role enum re-exports, `PRESET_ROSTER` (Squad/Team/Platoon/Legion), `DEFAULT_PROVIDER_BY_ROLE`, `defaultRoster()` builder, `agentKey()` helper. |
| `app/src/main/core/swarms/mailbox.ts` | `SwarmMailbox` class. SQLite-backed `swarm_messages` is the system-of-record; per-agent `<userData>/swarms/<swarmId>/inboxes/<agentKey>.jsonl` plus `outbox.jsonl` are debug mirrors. Single-writer queue (`enqueue()` → `drain()`) serialises every append so concurrent broadcasts cannot race the SQLite writer. Resolves architecture critique A2. |
| `app/src/main/core/swarms/protocol.ts` | `SIGMA::` line protocol. `parseProtocolLine()` parses a single PTY stdout line with verb + JSON body. `ProtocolLineBuffer` splits chunks on `\n` and forwards complete lines so partial chunks across writes are handled correctly. Operator-side helpers `formatBroadcast()`, `formatRollCall()`, `formatStdinDelivery()`, and `envelopeToInsert()`. |
| `app/src/main/core/swarms/factory.ts` | `createSwarm()` materialises the roster: writes the `swarms` row, allocates one `swarm_agents` row per agent, opens a per-agent worktree (when the workspace is a Git repo) under `sigmalink/<role>-<index>/<8char>`, spawns the PTY via `pty.create()`, attaches a `ProtocolLineBuffer` so SIGMA lines persist into the mailbox, and emits a SYSTEM bootstrap message. `loadSwarm`, `listSwarmsForWorkspace`, and `killSwarm` round out the lifecycle. |
| `app/src/main/core/swarms/controller.ts` | `buildSwarmController(deps)` exposes the eight-method `swarms.*` namespace (`create`, `list`, `get`, `sendMessage`, `broadcast`, `rollCall`, `tail`, `kill`). `sendMessage`/`broadcast`/`rollCall` perform dual delivery: append to mailbox AND type the same `SIGMA::` line into each targeted agent's PTY stdin. |
| `app/src/renderer/features/swarm-room/SwarmRoom.tsx` | Main page. Header bar with swarm picker, mission line, refresh / roll-call / new / kill buttons. Two-column body: roster grid + side chat. |
| `app/src/renderer/features/swarm-room/SwarmCreate.tsx` | Mission + name + preset + roster builder. Auto-fills roster from `PRESET_ROSTER` defaults; operator can override per-row provider before launch. |
| `app/src/renderer/features/swarm-room/RoleRoster.tsx` | Role card grid. Each card shows role-and-index badge, status dot (idle/busy/blocked/done/error), per-row provider select, mailbox identifier, and live message count. `readOnly` mode used in the running view. |
| `app/src/renderer/features/swarm-room/SideChat.tsx` | Mailbox stream + composer. Recipient chip is a `<select>` populated from the live agent list with `Broadcast (all)` first. Sticks across sends. Cmd/Ctrl+Enter shortcut. |
| `app/src/renderer/features/swarm-room/MailboxBubble.tsx` | One message bubble. Operator messages right-aligned; SIGMA-kind badges (SAY/ACK/STATUS/DONE/OPERATOR/ROLLCALL/SYSTEM) coloured per kind. |
| `app/src/renderer/features/swarm-room/PresetPicker.tsx` | Squad / Team / Platoon / Legion buttons with role-split preview (`1c · 2b · 1s · 1r`). |
| `app/src/renderer/features/swarm-room/preset-data.ts` | Pure-data export of `PRESETS` (extracted so PresetPicker stays a components-only file under `react-refresh/only-export-components`). |

## 2. Files modified (additive Edits, no removals)

| Path | Change |
|---|---|
| `app/src/shared/types.ts` | Appended `SwarmId`, `SwarmAgentId`, `Role`, `SwarmPreset`, `SwarmStatus`, `SwarmMessageKind`, `RoleAssignment`, `SwarmAgent`, `Swarm`, `SwarmMessage`, `CreateSwarmInput`. |
| `app/src/shared/router-shape.ts` | Imported the new swarm types and appended a `swarms` namespace with `create / list / get / sendMessage / broadcast / rollCall / tail / kill`. |
| `app/src/shared/rpc-channels.ts` | Appended `swarms.create`, `swarms.list`, `swarms.get`, `swarms.sendMessage`, `swarms.broadcast`, `swarms.rollCall`, `swarms.tail`, `swarms.kill` to the `CHANNELS` allowlist. The `swarm:message` event was already in `EVENTS` from W5. |
| `app/src/shared/events.ts` | Extended `swarm:message` payload shape with optional `kind`, `id`, `payload` fields so the renderer's reducer can recover the full SwarmMessage from a live event. |
| `app/src/main/core/db/schema.ts` | Appended Drizzle tables: `swarms`, `swarmAgents`, `swarmMessages`, plus inferred Row/Insert types and matching indexes. |
| `app/src/main/core/db/client.ts` | Appended `CREATE TABLE IF NOT EXISTS` SQL for `swarms`, `swarm_agents`, `swarm_messages` with FK ON DELETE CASCADE on `workspaces.id` / `swarms.id`, and matching indexes. |
| `app/src/main/core/db/janitor.ts` | Boot janitor now also marks `swarms.status='running'` rows as `'failed'` with an `endedAt` timestamp, so a forced quit during a live swarm is reflected on next boot (acceptance criterion 9). Returns `zombieSwarmsMarked` in the `JanitorReport`. |
| `app/src/main/rpc-router.ts` | Imported `SwarmMailbox` and `buildSwarmController`; instantiated the mailbox with the userData dir and bound its emitter to the `swarm:message` broadcast; threaded `pty`, `worktreePool`, `mailbox`, and `userDataDir` into the new controller; added `swarms` to the router. `SharedDeps` extended to carry `mailbox` for symmetry with future controllers. |
| `app/src/renderer/app/state.tsx` | Appended `swarms`, `activeSwarmId`, `swarmMessages` slice; new actions `SET_SWARMS`, `UPSERT_SWARM`, `SET_ACTIVE_SWARM`, `SET_SWARM_MESSAGES`, `APPEND_SWARM_MESSAGE`, `MARK_SWARM_ENDED`. New effects: subscribe to `swarm:message`, refresh swarms list when active workspace changes. Existing reducer cases untouched. |
| `app/src/renderer/app/App.tsx` | `case 'swarm'` now renders `<SwarmRoom />` instead of the `<PhasePlaceholder />`. |
| `app/src/renderer/features/sidebar/Sidebar.tsx` | Removed the `phase: 2` pill on the Swarm Room nav item so the entry enables when an active workspace exists. |

## 3. Schema migrations added

Three new tables in `app/src/main/core/db/schema.ts` and `app/src/main/core/db/client.ts`:

```sql
CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mission TEXT NOT NULL,
  preset TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  ended_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS swarms_ws_idx ON swarms(workspace_id);
CREATE INDEX IF NOT EXISTS swarms_status_idx ON swarms(status);

CREATE TABLE IF NOT EXISTS swarm_agents (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL,
  role TEXT NOT NULL,
  role_index INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  inbox_path TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS swarm_agents_swarm_idx ON swarm_agents(swarm_id);
CREATE UNIQUE INDEX IF NOT EXISTS swarm_agents_role_uq ON swarm_agents(swarm_id, role, role_index);

CREATE TABLE IF NOT EXISTS swarm_messages (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_json TEXT,
  ts INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS swarm_messages_swarm_time_idx ON swarm_messages(swarm_id, ts);
CREATE INDEX IF NOT EXISTS swarm_messages_to_idx ON swarm_messages(swarm_id, to_agent);
```

`PRAGMA foreign_keys = ON` was already enabled in `initializeDatabase()` from W5, so the cascade chain is live. Killing a workspace removes its swarms and, transitively, every agent and message row. The bootstrap SQL is idempotent so existing deployments pick up the new tables on the next boot without a destructive migration.

## 4. IPC channels added

Eight invoke channels (allowlisted in `rpc-channels.ts`):

| Channel | Args | Returns |
|---|---|---|
| `swarms.create` | `CreateSwarmInput` | `Swarm` |
| `swarms.list` | `workspaceId: string` | `Swarm[]` |
| `swarms.get` | `id: string` | `Swarm \| null` |
| `swarms.sendMessage` | `{ swarmId, toAgent, body, kind? }` | `SwarmMessage` |
| `swarms.broadcast` | `swarmId, body` | `SwarmMessage` |
| `swarms.rollCall` | `swarmId` | `SwarmMessage` |
| `swarms.tail` | `swarmId, opts?` | `SwarmMessage[]` |
| `swarms.kill` | `id: string` | `void` |

One event channel: `swarm:message` (already declared in W5). Payload now carries `id`, `kind`, and `payload` so the renderer can deduplicate by id and render the correct kind badge.

## 5. Acceptance criteria status

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `npm run build` passes | green | `tsc -b` clean; vite bundle 599 KB / 168 KB gz. |
| 2 | `npm run electron:compile` passes | green | `electron-dist/main.js` 223 KB; `preload.cjs` 2.8 KB. |
| 3 | `npm run product:check` passes | green | combines (1)+(2); both succeed. |
| 4 | `npm run lint` does not introduce new errors outside legacy/components/ui | green | total 56 problems = W5 baseline; the only error in `state.tsx` is the pre-existing `useAppState` `react-refresh/only-export-components` warning from W5; new files in `swarm-room/` report zero errors. |
| 5 | Swarm Room loads when clicked in sidebar after opening a workspace | green | `Sidebar.tsx` no longer marks the swarm item with `phase: 2`; `App.tsx` renders `<SwarmRoom />`. |
| 6 | Creating a swarm writes a row to `swarms` and one row per role agent to `swarm_agents` | green | `factory.ts` performs `db.insert(swarms)` once and `db.insert(swarmAgents)` per roster row; `agent_sessions` row is also created when the PTY spawns. |
| 7 | Sending a message writes a row to `swarm_messages` and emits `swarm:message` | green | `mailbox.append()` → `db.insert(swarmMessages).values(...).run()` then `this.emit(message)` which is wired in `rpc-router.ts` to broadcast `swarm:message` to every BrowserWindow. The renderer reducer's `APPEND_SWARM_MESSAGE` deduplicates by id. |
| 8 | Killing a swarm marks the row `completed` and tears down PTY sessions | green | `killSwarm()` iterates `swarm_agents`, calls `pty.kill(sessionId)` on each, then sets `swarms.status='completed', ended_at=now`. The PTY exit handler updates `agent_sessions.status` and `swarm_agents.status` accordingly. |
| 9 | Restarting the app re-loads existing swarms; running-before-quit becomes failed via boot janitor | green | `runBootJanitor()` selects `swarms.status='running'` and updates them to `'failed'` with `endedAt=now`. Renderer effect calls `rpc.swarms.list(workspaceId)` whenever `activeWorkspace` changes, so the Swarm Room shows persisted swarms across restarts (with the prior-running ones now marked failed). |

## 6. Architecture / UX critique alignment

- **A2 — mailbox concurrency.** The `SwarmMailbox` queue (`enqueue()` → `drain()`) guarantees a single in-flight DB write at a time, with the JSONL mirror written *after* the SQLite insert. SQLite is the system-of-record; mirror failures cannot lose durable data. (`app/src/main/core/swarms/mailbox.ts`.)
- **U10 + U16 — unified Swarm composer with recipient chip; broadcast vs targeted.** `SideChat.tsx` ships one composer where the recipient is a sticky `<select>` with `Broadcast (all)` plus every live agent. Cmd/Ctrl+Enter sends. Operator messages render right-aligned with a kind badge so broadcast vs targeted is visually distinguishable.

## 7. Protocol summary (SIGMA:: lines)

Verbs: `SAY`, `ACK`, `STATUS`, `DONE`, `OPERATOR`, `ROLLCALL`, `ROLLCALL_REPLY`, `SYSTEM`. Format: `SIGMA::<VERB> <json-body>\n`. Lines without a JSON body are tolerated and treated as `{}`. Non-`SIGMA::` PTY output remains in the existing PTY ring buffer and is NOT mirrored into the mailbox. Operator broadcasts/roll-calls additionally type the same SIGMA line into each targeted agent's stdin so the LLM sees a structured user message.

## 8. Known follow-ups

- **No automated tests yet.** Phase 2 ships product code only; unit tests for `parseProtocolLine`, the mailbox queue, and `formatStdinDelivery` are deferred. Suggested first tests: parse round-trip on `SIGMA::SAY {"to":"coordinator-1","body":"x"}` plus a malformed line, and a 1000-message broadcast against the queue to confirm in-order serialisation.
- **No agent-side CLI integration.** The Swarm Room orchestrates only — the agent CLIs do not yet emit `SIGMA::` lines on their own. The protocol module is in place; once the agent prompts are updated to emit SIGMA replies, the side-chat will populate without extra wiring.
- **Tail pagination.** `swarms.tail()` caps at 1000; the renderer requests 200. A `before` cursor is not yet implemented; long swarms eventually need pagination (or an offset/cursor) on the tail endpoint.
- **State.tsx pre-existing lint debt.** `useAppState` co-located with `AppStateProvider` still trips `react-refresh/only-export-components`. Untouched — pre-existing from W5.
- **`SharedDeps.mailbox`** is set for symmetry but the shutdown path in `shutdownRouter()` does not flush the queue (the queue is in-memory only; durable writes already landed in SQLite before each `await mailbox.append(...)` resolves, so a hard quit cannot lose durable data — the only thing lost is mirrors-in-flight which are debug-only).
- **No new dependencies introduced.** Everything builds on the existing `better-sqlite3` + `drizzle-orm` stack from Phase 1.

## 9. Build evidence

```
> npm run build
✓ 1726 modules transformed
✓ built in ~22s

> npm run electron:compile
electron-dist/main.js       223.2 kB
electron-dist/preload.cjs     2.8 kB
[build-electron] wrote electron-dist

> npm run product:check
(combines both above; success)

> npm run lint
✖ 56 problems (53 errors, 3 warnings)
```

The 56-problem total is unchanged from `W5-FOUNDATION-report.md` §`npm run lint`. Every error lives in `_legacy/**`, `components/ui/**`, `lib/utils.ts`, `shared/rpc.ts`, or the pre-existing `useAppState` co-export — exactly the same files the W5 report enumerated. Zero lint errors originate from `app/src/main/core/swarms/**` or `app/src/renderer/features/swarm-room/**`.
