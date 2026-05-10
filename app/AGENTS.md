# SigmaLink Codex Notes

## Ruflo Integration

Ruflo is available to Codex through MCP, not as a fully automatic Claude Code
plugin runtime. Use it deliberately as an orchestration and memory layer while
Codex continues to execute the actual implementation work.

Installed local references:

- Upstream Ruflo Codex guide: `.agents/ruflo/AGENTS.upstream.md`
- Upstream Ruflo `.agents` README: `.agents/ruflo/README.upstream.md`
- Upstream Ruflo Codex config sample: `.agents/ruflo/config.upstream.toml`
- Ruflo Codex skills: `~/.codex/skills/`

Default workflow for non-trivial tasks:

1. Search Ruflo/AgentDB memory only when prior context is likely to reduce work
   or avoid mistakes.
2. Use Ruflo swarm/task tools for coordination records on broad, multi-file, or
   ambiguous work.
3. Implement, edit, run tests, and verify directly in Codex.
4. Store a concise memory pattern after meaningful successful work.

Avoid using Ruflo for simple one-file edits, small questions, or status checks
that do not change the implementation path. Extra tool calls add context and can
raise token cost.

Codex/Ruflo division of labor:

- Codex writes files, runs commands, edits code, verifies behavior, and reports
  results.
- Ruflo tracks coordination, stores memory, searches vectors, routes tasks, and
  records learned patterns when explicitly invoked.
