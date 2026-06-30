# Windows RAM Leakage — Manual Verification

Branch: `worktree-fix+windows-ram-leakage` (off `origin/main`). Date: 2026-06-30.

Backend/main-process only — no renderer/UI changes.

## What changed

Three changes make the Windows Ruflo-stdio-MCP RAM multiplier **observable** and **contained**.
(Windows process-tree inspection and child-first `taskkill` teardown already shipped on
`origin/main`; this branch builds the MCP-specific layer on top.)

1. **MCP descendant diagnostics** (`summarizeMcpProcesses`, surfaced via `pty.processStats.mcp`).
   Returns `claudeFlowStdioCount`, `duplicateClaudeFlowStdio`, `claudeFlowStdioRssBytes`,
   `claudeFlowStdioPids`, and the highest-RSS `topClaudeFlowCommand`. Parent→child match chains
   are collapsed, so one healthy `npx → node cli.js` server counts as **1**, not 2. HTTP-transport
   (`-t http` / `--transport http`) servers are a separate daemon and are **not** counted.
2. **Windows Codex stdio Ruflo suppression (default).** On Windows, when no Ruflo HTTP daemon
   port is available, SigmaLink does **not** write a managed Codex stdio Ruflo MCP entry and
   removes any SigmaLink-managed `[mcp_servers.ruflo]` (+ `[mcp_servers.ruflo.env]`) table from
   `~/.codex/config.toml`. **User-managed entries are preserved** (a `uvx`/custom command, or a
   non-localhost URL, is detected as user-managed and recorded in `refused`). Opt back in with the
   KV flag `ruflo.codexStdioMcp = 1`. HTTP entries are still written normally when a port exists.
3. **Observed-process RAM brake.** Launch admission runs a second pass over live OS process state
   and blocks the launch — *before* any worktree/PTY side effect — when an existing pane already
   exceeds an observed RSS cap or holds duplicate `@claude-flow/cli` stdio MCP chains, unless
   `forceRamBrake` is set. Error prefix: `RAM_BRAKE_OBSERVED_PROCESS_BUDGET:`. Caps are KV-tunable:
   `ramBrake.maxObservedWorkspaceRssMb` (default 4096), `ramBrake.maxObservedTotalRssMb` (12288),
   `ramBrake.maxClaudeFlowStdioPerSession` (1).

## Preflight

1. Run this branch's build (packaged Windows build, or `pnpm run electron:dev`).
2. Open one normal workspace with the default `ruflo-core` profile.
3. Launch one Codex pane and one Claude pane.

## Expected

- `pty.processStats` returns `supported: true` on Windows.
- `mcp.claudeFlowStdioCount === 0` for a default Codex pane (no managed stdio Ruflo written when
  no HTTP daemon is available).
- `~/.codex/config.toml` has **no** SigmaLink-managed `[mcp_servers.ruflo]` table after opening a
  workspace on Windows (a pre-existing managed one is removed; a user-managed one is kept).
- Closing a pane removes its descendant `node`/`npx` MCP children (tree-aware `taskkill /T`).
- A launch is **blocked** with `RAM_BRAKE_OBSERVED_PROCESS_BUDGET:` when an existing pane already
  has more than one `@claude-flow/cli mcp start` chain (or RSS over cap). `forceRamBrake` overrides.
- Opt-in: set KV `ruflo.codexStdioMcp = 1`, reopen the workspace → the managed Codex stdio Ruflo
  entry is written again.

## PowerShell sampling

Run before and after closing panes:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match '@claude-flow/cli|mcp start|SigmaLink|codex|claude' } |
  Select-Object ProcessId, ParentProcessId, WorkingSetSize, CommandLine |
  Sort-Object WorkingSetSize -Descending |
  Format-Table -AutoSize
```

## Pass criteria

- No default Codex pane owns a SigmaLink-managed `@claude-flow/cli mcp start` descendant on
  Windows (unless opted in via `ruflo.codexStdioMcp`).
- Closing SigmaLink removes descendant `node`/`npx` MCP children under the SigmaLink PTY roots.
- Repeated managed Codex MCP children no longer accumulate (~400 MB each) in the default profile;
  the live sample that motivated this work showed ~4 such descendants ≈ 1.57 GB.

## Automated tests

Run from `app/` (pnpm workspace, vitest):

```
pnpm exec vitest run \
  src/main/core/ram-brake/mcp-process-diagnostic.test.ts \
  src/main/core/ram-brake/process-budget.test.ts \
  src/main/core/workspaces/mcp-autowrite.test.ts \
  src/main/core/workspaces/factory.test.ts \
  src/main/core/workspaces/launcher.test.ts
```

> **Windows-host caveat:** 5 tests in `src/main/core/pty/registry.test.ts`
> ("PtyRegistry — Phase 2 sentinel detection") fail on a Windows host because the suite's own
> spawn-mode mock coerces `shell-first → direct` when `process.platform === 'win32'`. These are
> **pre-existing** (they fail identically on the `origin/main` base) and unrelated to this work;
> they pass on macOS/Linux CI.
