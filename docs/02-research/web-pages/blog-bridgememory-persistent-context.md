# Blog: BridgeMemory: Persistent Context for AI Pair Programmers
URL: https://www.bridgemind.ai/blog/bridgememory-persistent-context
Fetched: 2026-05-09

## Headings (verbatim)
- H1: BridgeMemory: Persistent Context for AI Pair Programmers
- H2: Why your AI keeps forgetting
- H2: What BridgeMemory actually is
- H2: The 12 MCP tools every agent gets
- H2: [[Wikilinks]] turn notes into a graph
- H2: The force-directed graph view
- H2: Local-first, atomic-safe, yours
- H2: How to start using BridgeMemory
- H2: Final takeaway
- H2: Related Articles

## The 12 BridgeMemory MCP tools (verbatim, three groups)

### CRUD (6)
1. list_memories
2. read_memory
3. create_memory
4. update_memory
5. append_to_memory
6. delete_memory

### Discovery (4)
7. search_memories
8. find_backlinks
9. list_orphans
10. suggest_connections

### Hub Management (2)
11. init_hub
12. hub_status

(Parameter signatures not given in this post.)

## Knowledge graph schema
- Nodes = "memories" (individual markdown files).
- Edges = wikilinks ([[Title]] syntax).
- Titles serve as unique identifiers.

## Embedding model
- None. suggest_connections "tokenizes the active memory, filters stop-words, and ranks every other memory by shared four-plus-character keywords" (keyword-based, not embeddings).

## Storage details
- Local-first directory: `.bridgememory/` at workspace root.
- Format: Markdown files.
- Atomic writes via temp-file-plus-rename.
- Appends use POSIX O_APPEND at kernel boundary.
- Token storage: `~/.bridgespace/runtime.session` mode 0600.

## How memories surface
- Force-directed graph visualization (canvas-based) in BridgeSpace; drag, zoom, search with pulse highlight, shift-hover for ego mode.
- search_memories scores title hits higher than body hits, ties by recency.
- Backlinks reveal which notes point at the open one.
- suggest_connections ranks rest of hub by shared keywords.
- Best-practice prompt: "search the memory hub for prior context."

## Visible CTAs / buttons / form fields
- Standard nav.

## Pricing / plan info
- Mentions Pro tier includes BridgeMemory.

## Screenshots / images present
- Not enumerated by WebFetch.

## Source quote (≤15 words, in quotes)
"Twelve tools, three groups."
