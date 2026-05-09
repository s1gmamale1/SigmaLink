# BridgeMCP Documentation
URL: https://docs.bridgemind.ai/docs/mcp
Fetched: 2026-05-09

## Headings (verbatim)
- BridgeMCP / MCP server reference
- Project Tools, Task Tools, Agent Tools
- Setup: Cursor, Claude Code, Claude Desktop, Windsurf, Codex CLI
- Core Concepts (Task Lifecycle, Knowledge Field)
- Authentication
- Transport Protocols

## MCP tool catalog (verbatim signatures)

### Project tools
- `list_projects()` — returns array {id, name, description}.
- `create_project(name: string, description?: string)` — returns project.

### Task tools
- `list_tasks(projectId: UUID)` — returns array of tasks.
- `get_task(taskId: UUID)` — full task details.
- `create_task(projectId: UUID, instructions: string [1-5000], taskKnowledge?: string [<=50000], status?: string="todo")` — returns task.
- `update_task(taskId: UUID, instructions?, taskKnowledge?, status?)` — returns task.

### Agent tools
- `list_agents(projectId: UUID)` — returns array.
- `get_agent(agentId: UUID)` — full agent.
- `create_agent(projectId: UUID, name: string [1-255], systemPrompt: string [1-100000])` — returns agent.
- `update_agent(agentId: UUID, name?, systemPrompt?)` — returns agent.
- `delete_agent(agentId: UUID)` — returns confirmation.

## Setup snippets

### Cursor
- One-click button OR Settings → Tools & MCP → Add new MCP server (name=bridgemind, type=streamableHttp, url=https://mcp.bridgemind.ai/mcp, header Authorization: Bearer ...).
- `.cursor/mcp.json` config file.

### Claude Code (CLI)
```
claude mcp add --transport http --header "Authorization: Bearer KEY" bridgemind https://mcp.bridgemind.ai/mcp
```
Scopes: local (default), project, user.

### Claude Desktop config files
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

### Windsurf config files
- macOS/Linux: `~/.codeium/windsurf/mcp_config.json`
- Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- Cmd+Shift+P → "Windsurf: Configure MCP Servers".

### Codex CLI
```
codex mcp add --transport http --header "Authorization: Bearer KEY" bridgemind https://mcp.bridgemind.ai/mcp
```
Or `~/.codex/config.toml` `[mcp_servers.bridgemind]`.

## Core concepts
- Task lifecycle states: todo, in-progress, in-review, complete, cancelled.
- Task knowledge field: up to 50,000 chars; architecture decisions, file paths, API specs, doc links, constraints.

## Authentication
- Header: `Authorization: Bearer your_api_key_here`.
- Fallback query: `?apiKey=your_api_key_here`.
- Keys generated at bridgemind.ai dashboard; scoped per account.

## Transport protocols
- Streamable HTTP (recommended): POST /mcp; stateless.
- SSE (legacy): GET /sse; POST /messages; 30-min session timeout.

## Built-in prompt
- `bridgemind_developer_guide` — comprehensive prompt teaching agents tool usage and brand voice.

## Source quote (≤15 words, in quotes)
"Give your AI coding agent access to BridgeMind projects and tasks."
