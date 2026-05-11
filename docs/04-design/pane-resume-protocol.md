# Pane resume protocol

> **Status**: planning draft for v1.1.3. The implementation may refine this design as it lands; this file will be amended with final shape at PR-merge time.

## Why

`agent_sessions` rows survive app restarts in SigmaLink's SQLite. The actual claude/codex/gemini processes do NOT — they die with the parent Electron process. When the user reopens SigmaLink the prior pane rows are stale (`status='running'` but no live PID), the boot janitor (`db/janitor.ts`) cleans them up, and the user has to manually re-spawn each agent and re-establish the conversation.

v1.1.3 fixes this. Each CLI exposes a `--resume <session_id>` flag that re-attaches to a prior session's working memory (chat history, tool state). The flag is already declared in `app/src/shared/providers.ts` for claude/codex/gemini but **unused since v1.1.0** — no code captures the session id, no code consumes the registry field, no migration adds the storage column.

## Per-CLI session-id extraction

The session id is emitted by the CLI in its early stdout output. The extractor must parse it deterministically per CLI without false positives.

### Claude Code

- Non-interactive mode (`claude -p ... --output-format stream-json --verbose`) emits an `init` envelope as the first JSONL line:
  ```json
  {"type":"system","subtype":"init","session_id":"<uuid>","tools":[...], ...}
  ```
- Interactive PTY mode emits a welcome banner (verify exact format against `claude` v2.1+ before relying):
  ```
  ╭───────────────────────────────────────╮
  │ Claude Code v2.1.x                    │
  │ Session: <uuid-or-name>               │
  ╰───────────────────────────────────────╯
  ```
- Extractor strategy: for non-interactive, parse JSONL until first `init` envelope. For interactive, regex `/Session:\s+([A-Za-z0-9_-]+)/` against the first 50 lines.

### Codex CLI

- Codex emits its session id in the early banner. Exact format needs capture during implementation (capture via PTY recording of `codex` startup); plausible patterns include `Session ID: <id>` or a JSON-RPC `notifications/initialized` envelope if codex uses MCP-style transport.
- Extractor: regex first; fall back to "Session ID: <id>" literal match.

### Gemini CLI

- Investigation in v1.1.3 implementation will confirm whether gemini emits a session id at all.
- If no session-id concept, mark provider as `resumable: false` in registry and skip resume for gemini panes (respawn fresh instead).

### Other providers (cursor-agent, opencode, custom shell)

- Not in scope for v1.1.3. Add `resumable: false` to their registry entries; respawn fresh.

## Storage

New migration `0011_agent_session_external_id.ts`:

```sql
ALTER TABLE agent_sessions ADD COLUMN external_session_id TEXT;
CREATE INDEX IF NOT EXISTS agent_sessions_external_id_idx ON agent_sessions(external_session_id);
```

Idempotent (`IF NOT EXISTS` for the index; SQLite tolerates re-running ALTER if the column already exists in some dialects, but mirror migration 0010's BEGIN/COMMIT/ROLLBACK pattern to be safe).

## Wire-up

1. `core/pty/registry.ts` — on first PTY data event for a session, run the extractor. Stop scanning after either a hit (write to DB) or 100 lines (give up; no resume next time). Keep a per-session "scanned-N-lines" counter to enforce the cap.
2. `core/pty/session-id-extractor.ts` (NEW) — exports `extractSessionId(providerId, rawOutput, lineNumber): { id?: string, done: boolean }`.
3. `core/pty/resume-launcher.ts` (NEW) — exports `resumeWorkspacePanes(workspaceId): Promise<ResumeResult>` called by the boot flow after multi-workspace session-restore (Step 6 in the plan):
   - Query `agent_sessions WHERE workspace_id = ? AND status IN ('running','exited') AND external_session_id IS NOT NULL`.
   - For each, call `resolveAndSpawn` with `extraArgs: [...provider.resumeArgs, externalSessionId]`.
   - Update row status + new PID + new started_at on success.
   - On failure (CLI returned non-zero / extractor regex didn't match a new id / `resumeArgs` undefined for provider): set `status='exited'` with error code, emit toast "Could not resume <provider> session" (silent per locked UX decision; toast suppressed unless user enables verbose-restore in Settings).

## Per-provider `resumable` flag

Extend `app/src/shared/providers.ts` ProviderDef:

```ts
interface ProviderDef {
  // ... existing fields
  resumable?: boolean; // default false; set true for providers with verified --resume support
  resumeArgs?: string[]; // already declared; keep
}
```

- claude: `resumable: true, resumeArgs: ['--resume']`
- codex: `resumable: true, resumeArgs: ['--resume']` (verify syntax during implementation)
- gemini: `resumable: false` until gemini supports it (TBD)
- everything else: `resumable: false`

The resume-launcher checks `resumable === true` before attempting; respawns fresh otherwise.

## Failure modes + fallback

| Failure | Behaviour |
|---|---|
| `external_session_id` is null (PTY died before extractor caught) | Skip; respawn fresh. Log info. |
| CLI rejects `--resume <id>` (session aged out) | Mark `status='exited'`; respawn fresh in a new pane row. Toast suppressed by default. |
| `resumeArgs` is undefined for the provider | Skip resume; respawn fresh. |
| Worktree was deleted (user cleaned up `.git/worktrees`) | Re-allocate worktree at same path; if that fails, the row is marked exited and the user sees an empty pane. |

The goal is: resume succeeds silently when possible; falls back gracefully without ever crashing the boot flow.

## Affected files

- `app/src/main/core/db/migrations/0011_agent_session_external_id.ts` (NEW)
- `app/src/main/core/pty/session-id-extractor.ts` (NEW)
- `app/src/main/core/pty/resume-launcher.ts` (NEW)
- `app/src/main/core/pty/registry.ts` (wire extractor on first data event)
- `app/src/shared/providers.ts` (add `resumable` flag)
- `app/src/main/rpc-router.ts` (panes.resume RPC)
- `app/src/main/core/session/session-restore.ts` (call resumeWorkspacePanes from restore flow)

## Verification

- `session-id-extractor.test.ts`: per-CLI fixtures (real captured early output); assert id extracted; assert no false positives on long-running output.
- `resume-launcher.test.ts`: mock PTY registry; verify `extraArgs` shape; verify failure path doesn't crash; verify status row updates.
- E2E: open workspace, spawn 2 agents (claude + codex), let them produce a few lines, quit, relaunch — both panes return with `--resume <id>` in their PTY command line (visible in `ps aux` during the test).

## Out of scope

- Gemini resume (deferred until gemini CLI supports it).
- Cursor-agent / opencode / shell resume.
- Session-id capture on initial spawn before the PTY emits data (e.g., if SigmaLink generates the id and passes it via flag). v1.1.3 captures from output; future v1.2 could invert.
