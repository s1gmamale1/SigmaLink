# Changelog

## [1.1.3] - 2026-05-12

v1.1.3 implements the multi-workspace architecture, pane resume capabilities, and growable agent swarms.

### Added

- **Multi-workspace tabs** — The sidebar now supports parallel opened workspaces. Users can switch between workspaces without losing runtime state. Includes an 8-tab limit with an overflow drawer and per-tab close buttons.
- **Pane resume** — Agent CLI processes now persist across app restarts. SigmaLink captures the provider-native session ID (Claude/Codex) and relaunches PTYs using `--resume <id>`.
- **Growable swarms** — Swarms are no longer locked at creation size. Users can add agents to an existing swarm post-launch (up to a 20-agent capacity). Sigma Assistant can also use the new `add_agent` tool.
- **Ruflo readiness pre-flight** — New verification pipeline ensures the Ruflo orchestration layer is fully operational before spawning agents. Readiness is surfaced via a "Readiness Pill" in the breadcrumb.
- **Multi-workspace session restore** — The app now restores all previously open workspaces and their active rooms on boot.
- **Skills verification sweep** — SigmaLink now performs a content-hash check of enabled skills on workspace open, automatically refreshing missing or stale copies.

### Fixed

- **Assistant chat label** - Rendered assistant messages now use the `SIGMA` role pill instead of the leftover `BRIDGE` label.
- **Mailbox fanout** - Resolved issues with inter-agent group broadcasts in multi-workspace environments.

### Verification

- `pnpm exec vitest run` → **86/86 pass** (all test files converted to Vitest).
- `npm run build` → Success (frontend + main/preload).
- Environment: Fixed `better-sqlite3` Node 26 mismatch via manual rebuild.

## [1.1.2] - 2026-05-11

Sigma Assistant end-to-end. v1.1.1 shipped streaming Claude CLI responses but the Tool calls panel exposed that `tool_use` envelopes never executed — Sigma could talk but couldn't act. v1.1.2 fixes that. The assistant now actually launches panes, dispatches prompts, sees live workspace state, broadcasts to swarm groups, and writes its own MCP config for spawned agent CLIs.

### Added

- **Tool dispatch parity** — `runClaudeCliTurn.ts:routeToolUse()` extended with a `dispatchTool` callback. Every `tool_use` block emitted by the Claude CLI is now routed to `controller.invokeTool(name, args)`, the result captured, and a `tool_result` envelope (correct `tool_use_id` matching, `is_error` flag, stringified content) written back to the CLI's stdin via a serialised write queue. Slow tools guarded by a 30 s `withTimeout`. The CLI continues its turn with the actual host result in scope — no more orphan tool_use intents.
- **Live `list_*` tools** in `tools.ts` — `list_active_sessions`, `list_swarms`, `list_workspaces` read the in-memory PTY + swarm registries (not the DB), so Sigma can answer "how many agents are running right now?" accurately mid-turn. `system-prompt.ts` trimmed to remove the stale recent-files + open-swarms blob in favour of "call the `list_*` tools when you need live state".
- **MCP autowrite façade** — new `app/src/main/core/workspaces/mcp-autowrite.ts`. On workspace open, SigmaLink writes/merges:
  - claude code: project-local `<root>/.mcp.json`
  - codex: global `~/.codex/config.toml` `[mcp_servers.ruflo]` table
  - gemini: global `~/.gemini/settings.json` mcpServers block
  Each entry points the spawned agent CLI at the shared `<root>/.claude-flow/` state dir, so every agent that boots inside a SigmaLink workspace converges on one Ruflo brain. Idempotent; merges without clobbering user-customised entries (refuses to overwrite if `command !== "npx"`). Settings toggle at `RufloSettings.tsx` (kv key `ruflo.autowriteMcp`, default ON).
- **SONA trajectory wrapping** in `runClaudeCliTurn.ts` — `trajectoryStart` on every CLI turn, `trajectoryStep` per tool dispatch, `trajectoryEnd` on success / failure / cancel. Fail-soft when Ruflo is unavailable. Sigma Assistant now accumulates cross-session learning from its own tool-call outcomes via the existing ReasoningBank pipeline.

### Fixed

- **Mailbox group broadcast** (`BUG-V1.1.1-03`) — `mailbox.ts:expandRecipient` correctly resolves `@all`, `@coordinators`, `@builders`, `@scouts`, `@reviewers` to concrete agent keys before invoking the PTY pane-echo closure. Operator broadcasts now reach every recipient in the target swarm (and only that swarm — the rc3 cross-swarm-leak fix is preserved).
- **Tool calls execute end-to-end** (`BUG-V1.1.1-01`) — see Tool dispatch parity above. Sigma's "launch a codex pane" now actually spawns the pane.
- **Sigma can enumerate live state** (`BUG-V1.1.1-02`) — see live `list_*` tools above. Replaces the stale system-prompt blob that read from the DB at turn start.
- **Ruflo MCP auto-connected for spawned agent CLIs** (`BUG-V1.1.1-04`) — see MCP autowrite above. Each claude/codex/gemini pane boots into a workspace with Ruflo MCP already configured.

### Verification

- `pnpm exec tsc -b` → clean (exit 0).
- `pnpm exec vitest run` → **28/28 pass** (13 new tests: 5 dispatch + trajectory in `runClaudeCliTurn.test.ts`, 3 live tools in `tools.test.ts`, 4 in `mcp-autowrite.test.ts`, 1 group-fanout in `mailbox.test.ts`).
- `pnpm exec vite build` → main bundle 335 KB raw / **92.84 KB gzipped** (well under 700 KB target).
- `pnpm run lint` → 54 errors / 0 warnings (rc3 baseline, no new errors).
- `pr-reviewer` agent verdict: SHIP-WITH-PATCH; six doc-only patches applied inline (master memory SHAs, this CHANGELOG entry, missing release notes file, memory_index "Latest commit + tag", `.upstream.md` provenance note). Zero P1 code issues; no regressions to v1.1.1 surfaces (drag, rebrand, voice diagnostics, single-instance lock all intact).
- **Distribution**: arm64-only macOS DMG, same constraints as v1.1.1 (per-arch native rebuild required; x64 deferred to CI matrix in v1.2).

### Deferred to v1.1.3

- Refactor `runClaudeCliTurn.ts` (643 lines) + `tools.ts` (525 lines) under the 500-line/file rule.
- `list_swarms` workspaceId-optional fix at `tools.ts:463`.
- CI workflow `pnpm-lock.yaml` cache-path resolution (local gates pass; CI fails at Setup Node).
