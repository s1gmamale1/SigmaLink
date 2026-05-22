# Ruflo MCP — end-to-end fix (memory store + retrieval, lead + hooks + spawned CLIs)

**Date:** 2026-05-22
**Status:** Approved (autonomous, per operator taste)
**Approach:** C — Hybrid (convention + config + migration now; enforcement proxy only if measurement shows convention failing)
**Scope:** Full (env + app + migration + automation + Windows + docs + upstream PR)

## 1. Problem (evidence-based root cause)

Earlier verdict ("AgentDB empty / garbage-in") was **wrong**, corrected by live probe 2026-05-22:

- `memory_search` **works** — a fresh canary returns at 0.67 similarity; `"shell-first pane architecture phase"` returns the right entry at 0.57. The HNSW index is healthy and syncs fresh writes.
- ~38 embedded, retrievable entries exist (`memory_stats`: 48 total, 43 embedded).

The real defects:

1. **Default-namespace trap.** `memory_search` defaults to `namespace:"default"`, which holds **1 entry**. Any search that does not pass a namespace returns ~nothing. (My original 0-result probe didn't pass a namespace.)
2. **Namespace fragmentation.** `patterns` (plural, 20) = lead-authored release/routing memories (the "After Success → store" ritual *is* landing them). `pattern` (singular, 18) = auto hook-generated `pattern_<ts>_<hash>`. `agentdb_pattern-search` reads `pattern`; `memory_search` defaults to `default`; the good content in `patterns` is reachable by neither naive path.
3. **Only `memory_search_unified` sweeps all namespaces** — it is the correct retrieval entrypoint and returned the relevant entries (0.30–0.46).
4. **Spawn-config env split.** Stdio autowrite sets `CLAUDE_FLOW_DIR=<root>/.claude-flow` (`mcp-autowrite.ts:131`); the HTTP daemon sets `CLAUDE_FLOW_CWD=<root>` (`http-daemon-supervisor.ts:234/445`). Must verify both resolve to the same `.claude-flow/.swarm/memory.db`.
5. **Empty per-workspace stores.** Each user workspace's `.claude-flow` starts empty; spawned CLIs have nothing seeded and hit the same default-namespace trap.
6. **`[INTELLIGENCE]` hook noise.** The `UserPromptSubmit → route` hook (`.claude/helpers/intelligence.cjs`) injects suggestions at 0.05–0.09 relevance (a frequency/recency score, not cosine), every one `0x accessed` — token cost, no use.

The hooks are Ruflo-**vendored/generated** (`app/.claude/helpers/hook-handler.cjs` + `intelligence.cjs`, also `~/.claude/helpers/…`); editable but a `ruflo init` re-run clobbers raw edits.

## 2. Architecture — 3 stores × 3 caller classes

**Stores:** (a) lead/app `.claude-flow` (this repo); (b) each user-workspace `.claude-flow` (per spawned CLI); (c) AgentDB/ReasoningBank layer (accessed via `*_unified` / `agentdb_*`).

**Callers:** (1) **lead** — MCP tools, fully controllable; (2) **`.claude` hooks** — vendored `.cjs`, editable but re-gen-fragile; (3) **spawned CLIs** — connect directly to daemon/stdio, **no SigmaLink interception** (`RufloProxy` only wraps the in-app `ruflo.*` controller), so convention-only unless a reverse proxy is inserted (Approach B, deferred).

**Canonical convention (all callers):** writes → `namespace:"patterns"`; reads → `memory_search_unified`.

## 3. Workstreams

### WS1 — Namespace consolidation (data, env-level)
Migrate the 18 `pattern_*` entries → `patterns` via MCP tools (`memory_retrieve`/`memory_list` → `memory_store(namespace:"patterns", upsert:true)` → `memory_delete` from `pattern`). Idempotent; dry-run/list first; preserve keys (prefix `migrated-` if collision). Remove the diagnostic canary. Lead-executed directly — no release.

### WS2 — Retrieval convention (env-level + doc)
Standardize: reads → `memory_search_unified`; writes → `namespace:"patterns"`. Enforced in lead behavior + hooks (WS3); documented for CLIs (WS4 CLAUDE.md block + WS7 doc).

### WS3 — `[INTELLIGENCE]` hook retune (env-level)
In `app/.claude/helpers/intelligence.cjs` (+ `~/.claude/` copy): relevance floor → **0.3**; query across all namespaces (unified) not `default`; auto-store task verdicts to `patterns` on `post-task`/`session-end`. **Re-gen safety:** drive the floor/namespace from a small `ruflo.intelligence.json` (or env) the hook reads, so `ruflo init` re-runs don't clobber the tuning; if the generated hook can't read config, add a `scripts/reapply-ruflo-hook-tuning.cjs` idempotent patcher + cover it in the upstream PR (WS7). Lead-executed directly — no release.

### WS4 — SigmaLink spawn-config fix (APP CODE — gated v1.15.0 release)
1. **Shared store:** make stdio + daemon CLIs resolve to **one** workspace store. Verify `CLAUDE_FLOW_CWD=<root>` resolves to `<root>/.claude-flow` (same as `CLAUDE_FLOW_DIR`); if not, align both env vars in `mcp-autowrite.ts` + `http-daemon-supervisor.ts`. Add a unit test asserting both paths resolve identically.
2. **Seeding:** on `openWorkspace`, best-effort seed the workspace `.claude-flow` with **one** "project context" memory derived from the workspace-root `CLAUDE.md`/`README` (namespace `patterns`, key `project-context`). **Workspace-local only — never copy global/app memories** (cross-project bleed). Failure logged, never blocks open.
3. **CLI convention block:** autowrite an idempotent marker-delimited block (`<!-- ruflo-memory-convention:start -->…:end -->`) into the workspace-root `CLAUDE.md` teaching the namespace/tool convention. Same managed-block discipline as `mcp-autowrite` config blocks; refuse if a user-owned conflicting block exists.
4. **Daemon health round-trip:** extend the daemon health probe to do a `memory_store`→`memory_search_unified` round-trip (canary key, TTL'd) and surface pass/fail in daemon status. This is also the WS5 measurement.
5. Owns: `mcp-autowrite.ts`, `http-daemon-supervisor.ts`, workspace `factory.ts` open path, + tests.

### WS5 — Measurement gate
The WS4 round-trip + a periodic check record whether CLI writes land in `patterns` and are retrievable. This is the empirical trigger for Approach B (reverse-proxy enforcement) — built only if dogfood shows convention failing. No proxy in this packet.

### WS6 — Windows
win32 unit tests for the config/seeding/CLAUDE.md-block paths; the cross-platform round-trip; **operator-led Windows dogfood** (no Windows host in CI; smoke e2e is macOS). Config-only, no new flag, fully revertable (delete the managed block / seeded memory).

### WS7 — Docs + upstream PR
- Root-cause + canonical-config doc (`docs/10-memory/ruflo-mcp-canonical-config.md`): the default-namespace trap, the `patterns` convention, `memory_search_unified` as the read path, the env-var resolution, seeding, the re-gen-safe hook tuning. Cross-link the `reference-ruflo-agentdb-efficacy` memory.
- **Upstream PR draft** (staged in-repo under `docs/10-memory/upstream/`, NOT auto-filed on the third-party claude-flow repo): proposes `memory_search` default = search-all-namespaces (or a configurable default), and unifying `pattern`/`patterns`. Operator fires it.

## 4. Data flow (after fix)
- **Store:** any caller → `memory_store(namespace:"patterns")`.
- **Retrieve:** any caller → `memory_search_unified(query)` (sweeps `default`/`pattern`/`patterns`/`feedback`/…).
- **Spawned CLI:** workspace opens → daemon spawned (shared store) → seeded with project-context memory → CLI reads CLAUDE.md convention block → stores/retrieves canonically.

## 5. Error handling / fallback
Daemon down → stdio fallback (unchanged, now same store). Migration idempotent + dry-run. Seeding + CLAUDE.md block best-effort (logged, never blocks open). Round-trip probe failure → warning surfaced in daemon status, not fatal.

## 6. Testing
- WS4 app code: vitest units — env resolution identical (stdio vs daemon), seeding (workspace-local only, idempotent, failure-safe), CLAUDE.md block idempotency + user-owned-conflict refusal, daemon round-trip pass/fail.
- WS1 migration: dry-run assertion + post-migration `pattern` empty / `patterns` superset.
- Full gate in main: tsc -b | eslint --max-warnings 0 | vitest | vite build | electron:compile | Playwright smoke.

## 7. Success criteria
- A spawned CLI in a **fresh** workspace can store a fix and retrieve it by meaning in a later turn/session.
- Lead + `[INTELLIGENCE]` surface relevant past memories (no 0-result on real queries; injection floor 0.3).
- `pattern` consolidated into `patterns`; `memory_search_unified` is the documented read path.
- Documented; upstream PR drafted + staged.

## 8. Risks
- Hook re-gen clobber → config-driven tuning + idempotent re-apply script + upstream PR.
- claude-flow alpha protocol churn → convention not proxy; no dependence on upstream landing.
- Seeding cross-project bleed → explicitly workspace-local context only.
- Windows un-dogfoodable in CI → operator-led; config-only + revertable.
- `CLAUDE_FLOW_CWD` vs `DIR` resolving differently → unit test asserts identical resolution before relying on shared store.

## 9. Sequencing & dispatch
1. **Env-level now (lead, no release):** WS1 migration, WS3 hook retune, WS7 doc + PR draft.
2. **App-level (v1.15.0, parallel coders, isolated worktrees, scope-bound HARD, lead-merge + full gate):** WS4 (split by file ownership: autowrite/CLAUDE.md-block coder vs daemon-supervisor/health-roundtrip coder vs workspace-open/seeding coder), WS6 win32 tests folded in.
3. Lead merges A→B→C, full gate in main, ship v1.15.0. Agents never push/tag/release.

## 10. Out of scope
- Approach B reverse-proxy enforcement (deferred behind WS5 measurement).
- Forking/pinning claude-flow (operator chose our-level + upstream PR).
- Auto-filing the upstream PR on the third-party repo.
