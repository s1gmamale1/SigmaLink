# P4 — Obsidian memory + agent-memory unification (pillar f, HEADLINE) · design spec

**Status:** approved (autonomous execution under operator `/goal`). **Ships as:** `v1.40.0` (untagged, like P1–P3).
**Roadmap items:** MEM-1 (anchor), MEM-2, MEM-3, MEM-4, MEM-6, DB-2, BUG-10, BUG-11, BUG-12. **Date:** 2026-06-02.
**Baseline:** main @ `7b55693` (P1+P2+P3 shipped).

## Goal

Make the Ruflo agent memory browsable the Obsidian way, and make the Memory room feel like a real PKM
(graph/backlinks/daily-notes/tags/quick-switcher) — plus the correctness + safety fixes the subsystem owes.

## Recon findings (load-bearing — from the 3-agent recon)

- **Two unrelated "memory" systems.** The local **Memory** feature (`memory.*` RPC, `core/memory/*`) is a
  self-contained SQLite + markdown wikilink graph (this is the UI shell to reuse). **Ruflo AgentDB**
  (`ruflo.*` RPC, `core/ruflo/*`) is reachable only via **5 hard-coded tool forwards** — `embeddings.search`,
  `embeddings.generate`, `patterns.search`, `patterns.store`, `autopilot.predict`. **No list / get-by-namespace
  / neighbors / causal-edge** method exists. The stdio supervisor's `call()` is a **generic passthrough**
  (`proxy.ts:56`, no whitelist) so any tool name is reachable by the transport — only the controller gates it.
  Pattern hits carry **no stable id** (`normalizePatternHit`); embedding hits give `{id, score, text, namespace?}`.
- **Graph model** (`shared/types.ts:344-352`): `MemoryGraph { nodes:{id,label,tagCount,refCount}[], edges:{from,to}[] }`.
  **No `kind`/`type` on nodes; uniform color; edges = resolved wikilinks** (`graph.ts:8-29`). Node click passes
  `label` (the note NAME), not id (`MemoryGraph.tsx:467`), into `onSelect` → editor name-lookup.
- **MemoryRoom** is a 2-tab room (list | graph); list tab = tri-grid `260px MemoryList | 1fr MemoryEditor | 280px Backlinks`
  (`index.css:342`). Graph fetched in `MemoryRoom.tsx:52-71` (`rpc.memory.getGraph`) and passed to `MemoryGraphView` as props.
- **MEM-6 orphans + suggestions: backend FULLY SHIPPED + wired, ZERO renderer UI** (`db.listOrphans`,
  `manager.suggestConnections`, `controller.{list_orphans,suggest_connections}`, channels, MCP tools) → pure frontend add.
- **No ⌘O quick switcher** (only the global ⌘K `CommandPalette` with `memory`/`memory:new` actions). **No daily-note** path (reuse `manager.createMemory`, idempotent on existing).
- **Tags** live in a separate `memory_tags(memory_id, tag)` table (indexed) — **not** a column; no `listByTag` query exists; tags are **not** in the search index.
- **BUG-10** `frontmatter_json` is in the schema (`client.ts:136`) + sync allowlist (`engine.ts:76`) but hardcoded `null` on every write (`db.ts:168`) and never mapped in `rowToMemory`.
- **BUG-11** `MemoryEditor` hydrates on `[memory?.id]` only (`MemoryEditor.tsx:56-67`) → an external (agent/sync) update to the open note is invisible and a keystroke clobbers it via the 600ms debounced save.
- **BUG-12** `memories_ws_name_uq` is binary/case-sensitive (`client.ts:142`, no `COLLATE NOCASE`) but graph/parse resolution lowercases (`graph.ts:10`, `parse.ts:96`) and `findBacklinks` is a binary match (`db.ts:306`) → split-brain.
- **DB-2 seam**: `db/client.ts` opens better-sqlite3; `rawDb.backup(dest)` / `VACUUM INTO` available; restore = `closeDatabase()` → swap file → `initializeDatabase()` (mirrors the P1 `db/corruption.ts` quarantine-recreate).
- **PERF-14** `index.ts` is an O(n) 2-char-ASCII token scan; tags unindexed. FTS5 → a new H-7-style migration.
- **Degrade**: every `ruflo.*` returns `{ok:false, code:'ruflo-unavailable'}` when not ready; gate on `ruflo.health`/`ruflo:health` (as `MemoryList.tsx:63-80` does).

## Scope (this phase) — two rounds

### Round 1 — backend foundation + MEM-1 headline + correctness/safety
**Foundation (lead-owned, committed first as the lane base — load-bearing + interdependent):**
- `shared/types.ts`: extend `MemoryGraph` — `nodes[]` gains `kind?: 'note'|'ruflo'`, `group?: string` (Ruflo namespace), `color?: string`; `edges[]` gains `kind?: 'wikilink'|'similarity'|'causal'` + `weight?: number`. Add `RufloEntry { id, text, namespace, score?, tags?, createdAt? }` + `RufloEntryEdge { fromId, toId, kind:'similarity'|'causal', weight }`. Add `Memory.frontmatter?: Record<string,unknown>` (BUG-10).
- **New Ruflo backend methods** (`ruflo/controller.ts` + `ruflo/types.ts` whitelist + `rpc-channels.ts` + `proxy.ts` TOOL_TIMEOUTS):
  - `ruflo.entries.list({ query?, limit? })` → forwards `memory_search_unified` (sweep) → normalized `RufloEntry[]` **preserving id + namespace + timestamp** (new `normalizeEntry`).
  - `ruflo.entries.neighbors({ id|text, topK? })` → forwards `embeddings_search` with the entry text → `RufloEntryEdge[]` (similarity). Causal edges (`agentdb_causal-edge`) attempted best-effort, tolerated-absent.
  - All return the uniform `{ok:false, code:'ruflo-unavailable'}` envelope; never throw.
- **Memory backend** (`core/memory/{db,manager,controller,graph,parse}.ts`): BUG-10 (parse YAML frontmatter on save → store `frontmatter_json`; map in `rowToMemory`); BUG-12 (migration `0027` recreating `memories_ws_name_uq` + `memory_links` lookups `COLLATE NOCASE`, H-7-transactional — no nested BEGIN; align `findBacklinks`); `listTags(workspaceId)` + `listByTag(workspaceId, tag)` manager/controller/db methods + channels (for MEM-3).
- **DB-2 backend** (`db/client.ts`): `backupDatabase(destPath)` (`VACUUM INTO`) + `restoreDatabase(srcPath)` (close→validate via `quick_check`→swap→reopen, reusing the corruption-recovery sequence) + a `memory.backup`/`memory.restore` (or `app.db.*`) RPC.
- Foundation tests: ruflo-entries normalize + envelope; frontmatter parse; migration 0027 (MockDb); backup/restore (MockDb/`VACUUM INTO` shape); listTags/listByTag.

**Renderer lanes (file-disjoint, off the foundation commit):**
- **Lane A1 — `useRufloGraphOverlay.ts` (NEW hook).** Fetches `ruflo.entries.list` + `neighbors` (gated on `ruflo.health` ready; `rpcSilent`; empty on unavailable), maps to graph `nodes` (`kind:'ruflo'`, `group=namespace`, color/size by score/recency) + `edges` (`kind:'similarity'|'causal'`). Returns `{nodes, edges, ready}` for the lead to merge into the room graph. Leaf — no other file.
- **Lane A2 — `MemoryGraph.tsx`.** Branch node fill on `kind` (Ruflo = distinct color/glyph), edge style on `kind` (similarity = dashed), + a small legend overlay. Honor the existing PERF-13 settle/reduced-motion. Node click on a Ruflo node calls `onSelect` with a stable Ruflo ref. + tests.
- **Lane A3 — `MemoryEditor.tsx`.** (a) BUG-11: hydrate on `[memory?.id, memory?.updatedAt]` + a non-destructive "changed on disk — reload?" affordance when dirty. (b) A `readOnly` mode for Ruflo virtual notes (disable textarea, hide Save/Delete, suppress update/delete RPC, show namespace/score chip). + tests.
- **Lead integration:** merge the overlay into `MemoryRoom`'s graph payload; open a Ruflo node as a read-only virtual note (synthesize a `Memory`-shaped read-only object the editor + Backlinks accept); re-gate.

### Round 2 — PKM surfaces
- **MEM-4 — ⌘O Quick Switcher** (`MemoryQuickSwitcher.tsx`, cmdk `CommandDialog`): fuzzy over note names **and** Ruflo entries; ↵ jumps (note → select; Ruflo → open read-only). Bound globally via `bindShortcut('meta+o')`. Leaf component; lead wires the binding.
- **MEM-2 — Daily Notes** (`daily-note.ts` helper + a sidebar button + a palette command): create/open `YYYY-MM-DD` note via `manager.createMemory` (idempotent), tag `daily`; optional agent-activity digest body (best-effort from `ruflo.entries.list` of today's verdicts — degrade to empty).
- **MEM-3 — Tags pane** (`TagsPane.tsx`): list workspace tags (`listTags`) with counts; clicking a tag filters the note list (`listByTag`) **and** the graph (dim non-matching). Leaf; lead wires the filter state into MemoryRoom + MemoryList + MemoryGraph.
- **MEM-6 — Orphans & suggestions** (`MemoryAssistPanel.tsx`): surface the shipped `list_orphans` + `suggest_connections` (per active note) with click-to-open / insert-link. Pure frontend.
- **DB-2 UI** (`StorageTab.tsx`): "Back up database" (save dialog → `memory.backup`) + "Restore from backup" (open dialog → confirm AlertDialog → `memory.restore` → relaunch/reload). Leaf.

## Deferred → WISHLIST (P4.2)
MEM-5 (aliases), MEM-7 (unlinked mentions), MEM-8 (templates), MEM-9 (properties/outline editor — BUG-10 lays the `frontmatter` groundwork), PERF-14 (FTS5 — "low priority until vaults grow"). Causal-edge read is best-effort in round 1; full causal-graph visualization is P4.2 if the daemon's edge API proves rich enough.

## Error handling / security (SEC-1)
- Ruflo offline → local-only graph (the always-available base layer); all `ruflo.entries.*` via `rpcSilent`, `{ok:false}`/reject → empty.
- **MEM-1 renders Ruflo-stored text (agent-authored) as graph labels + read-only note bodies** — this is an H-19-class ingestion surface. Render as escaped React children (no `dangerouslySetInnerHTML`); run the phase through `snitch`/Opus review. Read-only virtual notes must NOT be writable back to Ruflo or the local DB.
- DB-2 restore is destructive → validate the incoming file with `PRAGMA quick_check` BEFORE swapping; confirm via AlertDialog; keep the pre-restore DB as a `.bak` sidecar.
- BUG-12 migration must be H-7-safe (runner owns the transaction; no nested BEGIN).

## Exit criteria (ROADMAP P4)
Ruflo patterns appear as a distinct node class with similarity/causal edges + backlinks (read-only); ⌘O jumps
to any note/pattern from anywhere; a "Today" note auto-creates; tag-click filters the list + graph; DB backup
round-trips (backup → restore → identical state). Graph degrades to local-only when Ruflo is offline.

## Gate (each round, before PR)
`tsc -b` · `vitest run` · build + `electron:compile` · full `tests/e2e/` · **`npm run lint`** · Opus review (+ SEC-1 ingestion lens). **Worktree base:** lanes branch off the pre-commit `origin/main` snapshot — each lane prompt carries an explicit `git merge --ff-only <FOUNDATION_SHA>` step (the P3 worktree-base lesson).
