# Ruflo MCP — canonical config & usage (SigmaLink)

**Last verified:** 2026-05-22 (live probe). Companion to spec `docs/superpowers/specs/2026-05-22-ruflo-mcp-fix-design.md`.

## TL;DR conventions

| Action | Do this | NOT this |
|---|---|---|
| **Store** a memory | `memory_store(namespace:"patterns", …)` | default namespace (`default`) |
| **Retrieve** by meaning | `memory_search_unified(query)` | `memory_search(query)` |
| Per-task verdict | store to `patterns`, key `verdict:<id>` | — |

## Why (root cause, evidenced 2026-05-22)

The store is **not** empty (~38 embedded entries; fresh writes index at 0.67 similarity). The defects are retrieval-path, not storage:

1. **`memory_search` defaults to `namespace:"default"`** — which holds ~1 entry. A search without an explicit namespace returns ~nothing. This caused the original "AgentDB is empty" misdiagnosis.
2. **Namespace fragmentation:** `patterns` (plural) = lead/human-authored release & routing memories; `pattern` (singular) = auto ReasoningBank captures. `agentdb_pattern-search` reads `pattern`; `memory_search` reads `default`.
3. **`memory_search_unified` is the only tool that sweeps multiple namespaces** — but its `searchedNamespaces` is `[default, claude-memories, auto-memory, patterns, tasks, feedback]` and **does NOT include `pattern`** (singular). So `pattern` auto-captures are invisible to every read path. → upstream PR (below).

## The `CLAUDE_FLOW_DIR` rule (spawned CLIs)

claude-flow resolves its store from env. SigmaLink writes per-workspace stores:
- stdio CLIs (autowrite): `CLAUDE_FLOW_DIR = <workspaceRoot>/.claude-flow` (`mcp-autowrite.ts` `buildRufloServer`).
- HTTP daemon (v1.15.0): now sets **both** `CLAUDE_FLOW_CWD=<root>` **and** `CLAUDE_FLOW_DIR=<root>/.claude-flow` so stdio and daemon CLIs share one store.

Every workspace gets its own `.claude-flow/.swarm/memory.db`. On open, SigmaLink seeds one `project-context` memory (namespace `patterns`) from the workspace `CLAUDE.md`/README — workspace-local only.

## `[INTELLIGENCE]` hook tuning

`app/.claude/helpers/intelligence.cjs` is a **local PageRank graph over `.md` files** (separate from the MCP store). Its `[INTELLIGENCE] Relevant patterns` suggestions scored `0.6·jaccard + 0.4·pageRank`; the floor `MIN_THRESHOLD` was `0.05`, surfacing pure-pageRank noise (0.05–0.09, never acted on).

- **Tuned to `0.15`**, overridable via env `RUFLO_INTEL_MIN_THRESHOLD`.
- **Re-gen-safe:** `ruflo init` regenerates the helper; restore with `node app/scripts/reapply-ruflo-hook-tuning.cjs`.

## Verifying it works (round-trip)

```
memory_store(key:"__check__", namespace:"patterns", value:"<unique phrase>", ttl:300)
memory_search_unified("<unique phrase>")   # must return the entry
memory_delete(key:"__check__", namespace:"patterns")
```
The v1.15.0 HTTP daemon health probe runs this automatically and surfaces `roundTrip:boolean` in daemon status.

## Related
- Memory: `reference-ruflo-agentdb-efficacy` (the efficacy probe).
- Upstream ask: `docs/10-memory/upstream/claude-flow-default-namespace-issue.md`.
