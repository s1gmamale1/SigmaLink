# SigmaLink Ground-Up Rebuild Plan

Synthesis of research from: existing app audit, BridgeSpace public docs/marketing, Emdash (Apache-2.0) source patterns, Anthropic Skills + Playwright MCP patterns, BridgeSpace_Research_Report.docx, and the YouTube launch video transcript.

## North Star

A local-first, Electron desktop **agentic development environment** that:

1. Launches grids of CLI coding agents (Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Aider, custom) in real PTYs.
2. Isolates each agent in a Git worktree.
3. Lets the operator launch a *swarm* of role-bearing agents (Coordinator / Builder / Scout / Reviewer) that talk to each other through a file-system mailbox.
4. Ships a drag-and-drop Skills loader (Anthropic Skills format) that fans out to each provider's native location.
5. Ships an in-app browser pane that any agent can drive via Playwright MCP over CDP.
6. Provides a shared-memory MCP server (wikilink notes, BridgeMemory-equivalent) that every agent can read/write.
7. Persists everything (workspaces, tasks, conversations, messages, terminals) in SQLite.

## Architecture (target)

```
electron/
  main.ts                  bootstrap, window, protocol, db init, RPC router
  preload.ts               ONE generic invoke + event bridge (proxy-driven)
  rpc-router.ts            assembles all controllers
  core/
    pty/                   ring-buffer PTY with atomic subscribe (Emdash pattern)
    git/                   worktree pool, commit/merge, status/diff
    workspaces/            workspace factory, launcher presets (1/2/4/6/8/10/12/14/16)
    providers/             provider registry + PATH probe + auto-detect
    swarm/                 role roster, mailbox bus, broadcast, roll-call
    skills/                drag-drop ingest, validate, fan-out to .claude/.codex/.gemini
    browser/               WebContentsView pane + CDP endpoint + Playwright MCP supervisor
    memory/                SQLite-backed wikilink graph + MCP server (Bridge memory eq.)
    mcp/                   per-agent mcp.json writer, server catalog, lifecycle
    tasks/                 Kanban board state, task->agent assignment
    db/                    Drizzle ORM, migrations, schema
src/
  shared/
    rpc.ts                 typed router/client (Proxy-based)
    events.ts              typed pub/sub
    providers.ts           AgentProviderDefinition[] + helpers
    skills.ts              SKILL.md frontmatter schema, Zod validators
    mcp.ts                 McpServer canonical + adapter table
    swarm.ts               Role enum, mailbox message schema
  renderer/
    main.tsx               root + theme + RPC client
    app/
      App.tsx
      router.tsx           rooms: workspace / swarm / review / memory / browser
    features/
      workspace-launcher/  preset picker, agent assignment, launch
      command-room/        terminal grid (mosaic/columns/focus)
      swarm-room/          roster setup, side-chat, mailbox, broadcast
      review-room/         diff viewer, test runner, commit/merge
      memory/              graph view, note editor, search
      browser/             in-app browser pane, tabs, agent-drive indicator
      skills/              skill library, drop zone, install/remove
      tasks/               Kanban board (Todo / In Progress / In Review / Done)
      command-palette/     Cmd+K fuzzy search across all actions
      settings/            providers, themes, MCP servers
    components/ui/         shadcn (already installed, keep)
```

## Reuse from current SigmaLink app

These already work and survive the rebuild:

- `electron/main.ts` PTY plumbing (lines 74-250) — fold into `core/pty/local-pty.ts`
- `electron/main.ts` Git ops (lines 117-369) — fold into `core/git/`
- `src/sections/TerminalPane.tsx` xterm rendering — fold into `renderer/features/command-room/Terminal.tsx`
- `src/lib/providers.ts` provider list — extend with full Emdash-style schema
- `src/components/ui/*` (50+ shadcn components) — keep as-is
- Tailwind + Vite + Electron Builder config — keep as-is
- IPC contract — replace with generic Proxy-based RPC (Emdash pattern), keep type-safety

## Phased build

### Phase 1 — Foundation (rip and re-lay)
- New `src/shared/rpc.ts` + `src/shared/events.ts` (Proxy-based, typed)
- New minimal `electron/preload.ts` (4 methods only: invoke, eventOn, eventSend, getPathForFile)
- Drizzle + better-sqlite3 setup with first migration (workspaces, projects, tasks, conversations, messages, terminals, skills, memories tables)
- New `core/pty/` with ring buffer + atomic subscribe (port from current code, fix race)
- New `core/providers/` with extended registry + PATH/version probe
- New `core/git/` with worktree pool + branch naming `sigmalink/<role>/<task>-<5char>`
- Workspace launcher UI: pick repo, pick preset (1-16 panes), assign provider per pane, launch
- Command Room with new terminal grid using rebuilt PTY

### Phase 2 — Swarm core
- Mailbox file format: `<userData>/swarms/<swarmId>/inboxes/<agentId>.jsonl`
- Role roster UI: select count of Coordinators/Builders/Scouts/Reviewers, assign provider per role
- Side-chat panel with live mailbox tail
- Operator broadcast tool (writes a special envelope to all inboxes)
- Roll-call protocol (Coordinator polls Builders for status)
- Persist swarm state in SQLite

### Phase 3 — Skills + MCP + Browser
- Skills drop zone in renderer (HTML5 drag, `webkitGetAsEntry`, `webUtils.getPathForFile`)
- SKILL.md validator (Zod), copy to `<userData>/skills/<id>/`
- Fan-out: copy to `~/.claude/skills/<id>/`, copy/translate to `~/.codex/skills/<id>/`, synthesize `~/.gemini/extensions/<id>/`
- MCP server config writer for each spawned agent (Claude → `<worktree>/.mcp.json`, Codex → `~/.codex/config.toml`, Gemini → extension)
- Bundled MCP catalog (Playwright, Memory, Filesystem, Git)
- In-app browser pane: `WebContentsView`, address bar, back/forward, tabs
- CDP endpoint exposed; supervise `npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:<port>` per workspace
- Each agent's `.mcp.json` points to the shared Playwright MCP HTTP port → agents drive the visible in-app browser

### Phase 4 — Memory + Review + Polish
- Custom SigmaMemory MCP server (stdio, in-process) exposing 12 tools: `create_memory`, `search_memories`, `find_backlinks`, `suggest_connections`, `update_memory`, `delete_memory`, `list_memories`, `get_memory`, `link_memories`, `get_graph`, `tag_memory`, `get_recent_memories`
- Markdown notes in `.sigmamemory/` with `[[wikilinks]]`
- Force-directed graph view (D3 or react-force-graph)
- Review Room: rebuild on top of solid Git ops; full diff viewer (Monaco diff or react-diff-view)
- Kanban board (dnd-kit) with task→agent assignment
- Command palette (Cmd+K) using existing shadcn Command
- 25+ themes (CSS custom properties only, no per-theme rebuild)
- Auto-cleanup: prune merged worktrees on app start

## Out of scope (this rebuild)

- Cloud sync / accounts / billing / credit metering
- Voice assistant
- Mobile app
- SSH remote workspaces (port the abstraction so it can be added later, but no UI)
- BridgeMind-specific paid features

## Legal/IP guardrails

- Visual layout, terminology (Coordinator/Builder/Scout/Reviewer roles, room naming, `.sigmamemory` directory) is allowed because it's functional/idiomatic; the file-mailbox protocol is independently designed.
- All directly portable code patterns come from Emdash (Apache-2.0). Add NOTICE attribution.
- No screenshot reproduction, no copy of proprietary BridgeSpace assets.
- Provider names (Claude Code, Codex, etc.) are factual product references.
