# WISHLIST — SigmaLink

## Recently shipped

| # | Item | Shipped in | Notes |
|---|------|------------|-------|
| 1 | Windows spawn ENOENT fix — cross-platform .cmd/.bat/.ps1 shim handling | v1.4.2 | Packet 01, `spawn-cross-platform.ts` |
| 2 | Settings room blocks workspace click — GLOBAL_ROOMS guard | v1.4.2 | Packet 02, `state.reducer.ts` |
| 3 | xterm preservation across room/workspace switch — terminal cache | v1.4.2 | Packet 03, renderer-side cache |
| 4 | Worktree location discoverability UX — Option D | v1.4.2 | Packet 06, pane context menu + Storage tab |
| 5 | Disk-scan provider scoping — agent_sessions whitelist | v1.4.2 | Packet 10, cross-workspace rejection |
| 6 | NSIS installer welcome page — SmartScreen workaround | v1.4.2 | Packet 11, `installer.nsh` |
| 7 | state.tsx split verification (97 LOC) | v1.4.2 | Packet 08, already done in v1.1.9 |
| 8 | Backlog verify-and-close sweep — 4 items closed | v1.4.2 | Packet 09 |

## In progress

| # | Item | Target | Notes |
|---|------|--------|-------|
| — | *(empty — all v1.4.2 packets shipped)* | | |

## Backlog

| # | Item | Priority | Notes |
|---|------|----------|-------|
| 1 | shellcheck CI step — fix macos-14 runner (brew install or ubuntu) | P2 | Escalated from packet 09 |
| 2 | Review/runner.ts + git/git-ops.ts migration to spawn-cross-platform | P3 | Deferred from packet 01 to v1.4.3 |
| 3 | Detection-gated MCP writes for Claude/Codex/Gemini | P3 | v1.3.6 candidate |
