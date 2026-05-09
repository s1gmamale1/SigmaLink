# BridgeMind MCP Setup Page
URL: https://www.bridgemind.ai/mcp
Fetched: 2026-05-09

## Headings (verbatim)
- H1: BridgeMCP
- H2: Quick Start
- H2: One-Click Install
- H2: Available Tools
- H2: Supported AI Tools
- H2: Ready to Connect?
- H3: Get Your API Key
- H3: Configure Your AI Tool
- H3: Restart & Verify
- H3: Projects, Tasks, Agents

## Configuration (verbatim)
Server URL: `https://mcp.bridgemind.ai/mcp`
API Key format: `bm_live_xxxxxxxxxxxx`

```json
{
  "mcpServers": {
    "bridgemind": {
      "url": "https://mcp.bridgemind.ai/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

File location for Cursor: Cursor Settings → Features → MCP → Edit Config.

## Available tools (verbatim)
- list_projects, create_project
- list_tasks, get_task, create_task, update_task
- list_agents, get_agent, create_agent (system prompt up to 100KB), update_agent

## Supported AI tools
- Cursor, Claude Code, Codex CLI, Claude Desktop, Windsurf, OpenClaw.

## Source quote (≤15 words, in quotes)
"Bearer YOUR_API_KEY"
