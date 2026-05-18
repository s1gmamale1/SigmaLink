# 10 — Disk-scan provider scoping (R-1.2.8-2)

**Severity**: P3 hygiene
**Effort**: S (~1hr)
**Cluster**: Backlog hygiene
**Suggested delegate**: Qwen via OpenCode
**Depends on**: nothing

## Context

v1.2.8 shipped "Session capture rewrite" with disk-scanner for Codex/Kimi/OpenCode. Open risk R-1.2.8-2: the scanner doesn't cross-reference the captured session's cwd against the current workspace's repo — so a Codex/Kimi session opened OUTSIDE SigmaLink (in another repo, via terminal) could get attached to the current workspace's pane.

Closes WISHLIST line 62 / v1.2.8 R-1.2.8-2.

## Diagnosis

Disk scanner lives at `app/src/main/core/providers/session-disk-scanner.ts` (verify exact file). It walks the provider's session storage (e.g. `~/.codex/sessions/` or `~/.kimi/sessions/`) and matches sessions to panes by recency + cwd. The cwd check is permissive: if cwd matches OR is a subdirectory of the workspace cwd, it captures. But it does NOT verify that the captured session was actually spawned by SigmaLink.

Result: if the user has Codex running in another terminal in a completely different repo, AND that other repo's cwd matches the SigmaLink workspace by coincidence (e.g. both under `/Users/.../projects/`), the foreign session might attach.

## Fix

Add a project-hash check: SigmaLink-spawned sessions could be tagged with a workspace-hash sentinel (e.g. an env var passed at spawn) OR the scanner could cross-reference against the `agent_sessions` table for sessions SigmaLink itself spawned.

Two options:

### Option A — Strict scope (project-hash check)
At session spawn, set env var `SIGMALINK_WORKSPACE_HASH=<8char>` for the provider process. On disk scan, only capture sessions whose recorded env includes this hash. (Many CLI session formats record env; verify which providers do.)

### Option B — Whitelist via agent_sessions
Disk scanner only captures sessions whose IDs are present in the `agent_sessions` table for the active workspace.

**Recommendation**: Option B (simpler, doesn't depend on provider session format).

## File:line targets

| File | Operation |
|---|---|
| `app/src/main/core/providers/session-disk-scanner.ts` (verify path) | Add workspace-scoped filter after session enumeration |
| `app/src/main/core/db/sessions-dao.ts` (or wherever agent_sessions is read) | If Option B: expose `listSessionExternalIdsForWorkspace(wsId)` helper |
| `app/src/main/core/providers/session-disk-scanner.test.ts` | New test: foreign session in another repo NOT captured |

## Verification

- New test: simulate two repos each with a Codex session; assert only the SigmaLink-spawned one captures.
- Manual smoke: open SigmaLink workspace, leave it idle. In separate terminal, spawn a fresh Codex session in another repo. Switch back to SigmaLink, click pane refresh. Should NOT capture the foreign session.

## Risks

- R-10-1: Option B (whitelist) breaks "adopt session spawned outside SigmaLink" use case if it ever becomes a feature. Currently NOT supported (per v1.2.8 explicit scope), so safe.

## Closes

- v1.2.8 R-1.2.8-2
- WISHLIST line 62
