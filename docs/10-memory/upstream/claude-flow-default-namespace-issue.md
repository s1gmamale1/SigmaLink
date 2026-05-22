# Upstream draft — claude-flow MCP: default-namespace + `pattern`/`patterns` retrieval gaps

**Status:** DRAFT — staged in-repo. **Operator fires it** on the third-party repo (`@claude-flow/cli`). Not auto-submitted.

**Target:** github.com/(ruvnet)/claude-flow (or wherever `@claude-flow/cli` is sourced). Verify the canonical repo before filing.

**Affected:** `@claude-flow/cli@latest` (3.x alpha), MCP memory tools.

---

## Summary

Memory entries are stored and embedded correctly, but the primary retrieval tools miss them by default, making the store appear empty to naive callers.

## Evidence (probe 2026-05-22)

- `memory_stats`: 48 entries, 43 embedded; namespaces `pattern(18)`, `patterns(20)`, `feedback(5)`, `causal-edges(5)`, `default(1)`.
- `memory_search("…")` with **no namespace** → 0 results (defaults to `default`, which holds 1 entry).
- `memory_search("…", namespace:"patterns")` → relevant hits up to 0.67 similarity. So the index works; the **default namespace is the trap**.
- `memory_search_unified(...)` reports `searchedNamespaces: [default, claude-memories, auto-memory, patterns, tasks, feedback]` — it **omits `pattern`** (singular), where the auto/ReasoningBank captures live. Those entries are unreachable by any read path.
- `agentdb_pattern-search` reads `pattern` (singular) while `memory_store` / `memory_search_unified` use `patterns` (plural).

## Requests (any one helps; all three ideal)

1. **`memory_search` default = search-all-namespaces** (or expose a `searchAllNamespaces` flag / make the default namespace configurable). The silent default to a near-empty `default` namespace is the highest-impact footgun.
2. **`memory_search_unified` should include `pattern`** (singular) in `searchedNamespaces` — or auto-discover all extant namespaces — so auto-captured patterns are retrievable.
3. **Unify `pattern` and `patterns`** (or document which tools use which) so `agentdb_pattern-search` and `memory_store` share a namespace.

## Workaround we shipped (no dependency on this PR)

- Convention: write `namespace:"patterns"`, read `memory_search_unified`.
- Daemon sets `CLAUDE_FLOW_DIR` explicitly so stdio + HTTP CLIs share one store.
- `[INTELLIGENCE]` hook floor raised 0.05→0.15 (`RUFLO_INTEL_MIN_THRESHOLD`).

## Repro

```
npx @claude-flow/cli@latest mcp start   # then via MCP:
memory_store(key:"x", value:"alpha bravo charlie", namespace:"patterns")
memory_search("alpha bravo charlie")                  # → 0 results (BUG: searched 'default')
memory_search("alpha bravo charlie", namespace:"patterns")  # → finds it
memory_search_unified("alpha bravo charlie")          # → finds it (but never searches 'pattern')
```
