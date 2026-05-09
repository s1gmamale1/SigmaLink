# MCP Tool Catalog
Compiled: 2026-05-09

Documented BridgeMCP tools across BridgeMCP server and BridgeMemory hub. Sources: docs-mcp, mcp-setup, blog-bridgememory, products-bridgespace.

## BridgeMCP server (10 tools)

Server URL: `https://mcp.bridgemind.ai/mcp`
API key format: `bm_live_xxxxxxxxxxxx`
Auth: header `Authorization: Bearer KEY` or `?apiKey=KEY` query.

### Project
| Tool | Parameters | Returns |
|------|------------|---------|
| list_projects | (none) | array {id, name, description} |
| create_project | name: string (required), description?: string | created project |

### Task
| Tool | Parameters | Returns |
|------|------------|---------|
| list_tasks | projectId: UUID | array of tasks (id, status, instructions summary, knowledge) |
| get_task | taskId: UUID | full task |
| create_task | projectId: UUID, instructions: string [1–5000], taskKnowledge?: string [≤50000], status?: string="todo" | created task |
| update_task | taskId: UUID, instructions?, taskKnowledge?, status? (≥1 non-id arg required) | updated task |

### Agent
| Tool | Parameters | Returns |
|------|------------|---------|
| list_agents | projectId: UUID | array {id, name, systemPrompt} |
| get_agent | agentId: UUID | full agent |
| create_agent | projectId: UUID, name: string [1–255], systemPrompt: string [1–100000] | created agent |
| update_agent | agentId: UUID, name?, systemPrompt? | updated agent |
| delete_agent | agentId: UUID | confirmation |

Note: docs-mcp lists 10; mcp-setup omits `delete_agent` from public list — safe to include.

### Built-in prompt
- `bridgemind_developer_guide` — internal LLM-facing prompt teaching agents tool use and brand voice.

### Task lifecycle states
todo → in-progress → in-review → complete; or cancelled.

### Transports
- streamableHttp (recommended): POST /mcp.
- sse (legacy): GET /sse + POST /messages, 30-minute session timeout.

---

## BridgeMemory MCP tools (12, three groups)
Source: blog-bridgememory ("Twelve tools, three groups").
Parameter signatures NOT documented publicly for these — open question.

### CRUD (6)
- list_memories
- read_memory
- create_memory
- update_memory
- append_to_memory
- delete_memory

### Discovery (4)
- search_memories — title hits ranked higher than body, ties by recency.
- find_backlinks
- list_orphans
- suggest_connections — keyword-based ranking (no embeddings); tokenize active memory, filter stop-words, rank by shared 4+ char keywords.

### Hub Management (2)
- init_hub
- hub_status

### Storage
- Local-first directory: `.bridgememory/` at workspace root.
- Markdown files; titles are unique IDs.
- Edges = `[[Title]]` wikilinks.
- Atomic writes via temp-file-plus-rename.
- Appends use POSIX O_APPEND.
- Token storage at `~/.bridgespace/runtime.session` mode 0600.

### Visualization
- Force-directed graph in BridgeSpace (canvas-based). Drag, zoom, search with pulse highlight, shift-hover for ego mode.

---

## Comparison to bridgemcp landing page (4 tools cited)
The bridgemcp page cites 4 tools (create_memory, search_memories, find_backlinks, suggest_connections) as the headline subset of the 12 BridgeMemory tools.

---

## Skill-based tools (BridgeWard, BridgeSecurity)
These are not MCP tools, but slash-commands provided as Anthropic Agent Skills:

- `/injection-audit <target>` — file/dir/URL/MCP target audit (BridgeWard).
- `/security-audit <target>` — file/dir/URL/PR target audit (BridgeSecurity).

Subagents (read-only):
- `injection-auditor` (BridgeWard).
- `security-auditor` (BridgeSecurity).
